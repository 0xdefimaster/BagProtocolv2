import type { Hex, PublicClient } from 'viem';
import { AssetIdentity, AssetPrice } from '@/types/basket-protocol';
import { PriceProvider, PriceUnavailableError } from './provider';
import { DEFAULT_MAX_PRICE_AGE_MS } from './staleness';
import { formatNavValue } from '../nav/nav';

// -----------------------------------------------------------------------------
// Chainlink Data Feeds on Robinhood Chain (AggregatorV3Interface).
//
// Per Robinhood's and Chainlink's docs, each Stock Token has its own feed and
// `latestRoundData()` returns the price of ONE TOKEN — the underlying share
// price ALREADY multiplied by the token's corporate-action multiplier. So the
// answer is used as-is; applying `currentMultiplier` again would double it.
//
// Feed addresses are NOT hardcoded or guessed: the operator copies them from
// docs.chain.link (Robinhood tokenized equities) into ROBINHOOD_CHAINLINK_FEEDS
// (`{"0xasset":"0xfeed"}`). An unconfigured asset is PriceUnavailable. In the
// price router (bag-price-router.ts) a feed VERIFIES Robinhood's API price
// on-chain; a wrongly configured feed shows up as a disagreement (fail closed).
//
// FAIL CLOSED on: unconfigured asset, non-positive answer, a round whose
// `updatedAt` is older than `maxAgeMs`, an incomplete round (updatedAt == 0 or
// answeredInRound < roundId), or any RPC error.
// -----------------------------------------------------------------------------

const AGGREGATOR_V3_ABI = [
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  {
    type: 'function',
    name: 'latestRoundData',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'roundId', type: 'uint80' },
      { name: 'answer', type: 'int256' },
      { name: 'startedAt', type: 'uint256' },
      { name: 'updatedAt', type: 'uint256' },
      { name: 'answeredInRound', type: 'uint80' },
    ],
  },
] as const;

export type FeedReadClient = Pick<PublicClient, 'readContract'>;

export interface ChainlinkFeedProviderConfig {
  client: FeedReadClient;
  /** asset address (any case) -> AggregatorV3 feed address. */
  feeds: Record<string, Hex>;
  maxAgeMs?: number;
  now?: () => Date;
}

export class ChainlinkFeedPriceProvider implements PriceProvider {
  private readonly feeds: Map<string, Hex>;
  private readonly maxAgeMs: number;
  private readonly decimalsCache = new Map<string, number>();

  constructor(private readonly config: ChainlinkFeedProviderConfig) {
    this.feeds = new Map(Object.entries(config.feeds).map(([a, f]) => [a.toLowerCase(), f]));
    this.maxAgeMs = config.maxAgeMs ?? DEFAULT_MAX_PRICE_AGE_MS;
  }

  hasFeed(asset: AssetIdentity): boolean {
    return asset.chain === 'robinhood' && this.feeds.has(asset.address.toLowerCase());
  }

  async getPrice(asset: AssetIdentity): Promise<AssetPrice> {
    const feed = asset.chain === 'robinhood' ? this.feeds.get(asset.address.toLowerCase()) : undefined;
    if (!feed) throw new PriceUnavailableError(asset);
    const c = this.config.client;
    let decimals: number;
    let round: readonly [bigint, bigint, bigint, bigint, bigint];
    try {
      const cached = this.decimalsCache.get(feed.toLowerCase());
      decimals = cached ?? Number(await c.readContract({ address: feed, abi: AGGREGATOR_V3_ABI, functionName: 'decimals' }));
      this.decimalsCache.set(feed.toLowerCase(), decimals);
      round = (await c.readContract({ address: feed, abi: AGGREGATOR_V3_ABI, functionName: 'latestRoundData' })) as typeof round;
    } catch {
      throw new PriceUnavailableError(asset);
    }
    const [roundId, answer, , updatedAt, answeredInRound] = round.map((v) => BigInt(v));
    if (answer <= BigInt(0) || updatedAt === BigInt(0) || answeredInRound < roundId) throw new PriceUnavailableError(asset);
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new PriceUnavailableError(asset);
    const updated = new Date(Number(updatedAt) * 1000);
    const now = this.config.now ? this.config.now() : new Date();
    if (now.getTime() - updated.getTime() > this.maxAgeMs) throw new PriceUnavailableError(asset);
    return {
      asset,
      price: formatNavValue(answer, decimals),
      quoteCurrency: 'USD',
      timestamp: updated.toISOString(),
      source: `chainlink:${feed.toLowerCase()}`,
    };
  }
}

/** Parses ROBINHOOD_CHAINLINK_FEEDS (`{"0xasset":"0xfeed"}`); throws on malformed input. */
export function parseChainlinkFeeds(raw: string | undefined): Record<string, Hex> {
  if (!raw || !raw.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('ROBINHOOD_CHAINLINK_FEEDS must be a JSON object {"0xasset":"0xfeed"}.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('ROBINHOOD_CHAINLINK_FEEDS must be a JSON object.');
  const out: Record<string, Hex> = {};
  for (const [asset, feed] of Object.entries(parsed as Record<string, unknown>)) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(asset) || typeof feed !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(feed)) {
      throw new Error(`ROBINHOOD_CHAINLINK_FEEDS entry ${asset} -> ${String(feed)} is not an address pair.`);
    }
    out[asset.toLowerCase()] = feed as Hex;
  }
  return out;
}
