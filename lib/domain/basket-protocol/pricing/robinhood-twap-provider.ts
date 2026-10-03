import type { Hex, PublicClient } from 'viem';
import { AssetIdentity, AssetPrice } from '@/types/basket-protocol';
import { PriceProvider, PriceUnavailableError } from './provider';
import { DEFAULT_MAX_PRICE_AGE_MS } from './staleness';
import { formatNavValue, NAV_VALUE_DECIMALS } from '../nav/nav';
import { getSqrtRatioAtTick, meanTickFromCumulatives, priceFromSqrtRatio } from './uniswap-v3-twap';

// -----------------------------------------------------------------------------
// Robinhood Chain price authority — Uniswap v3 TWAP against USDG.
//
// SOURCE (real, documented, on-chain): the Uniswap v3 pool oracle
// (`IUniswapV3Pool.observe`) of a pool created by the VERIFIED Uniswap v3
// Factory on Robinhood Chain (lib/config/robinhood-chain.ts,
// UNISWAP_V3_FACTORY_ADDRESS, from developers.uniswap.org's Robinhood Chain
// deployments page), paired with USDG — Paxos "Global Dollar", Robinhood
// Chain's canonical USD stablecoin (ROBINHOOD_REWARD_TOKEN).
//
// WHY TWAP, not a spot quote: a time-weighted mean tick over `windowSeconds`
// cannot be moved by a single-block trade the way `slot0`/QuoterV2 can.
//
// DETERMINISTIC MAPPING: an asset is priced ONLY through a pool explicitly
// configured for it (`pools`: asset address -> pool address). Before use, the
// pool is checked on-chain: `pool.factory()` is the verified factory, its two
// tokens are exactly {asset, USDG}, and `factory.getPool(t0, t1, fee)` returns
// that same pool (so a look-alike contract can never be configured in).
// An asset with no configured pool is PriceUnavailable — never guessed,
// never routed through some other pool, never a mock.
//
// FAIL CLOSED (PriceUnavailableError) on: unconfigured asset, pool that fails
// the checks above, zero in-range liquidity, `observe` reverting (window
// longer than the pool's recorded observations), a latest block older than
// `maxAgeMs` (halted chain / stale RPC).
//
// QUOTE CURRENCY: USDG, reported as "USD" for NAV math under an explicit
// assumption that USDG trades at its 1:1 peg. A depeg is NOT detected here.
// USDG itself is priced at exactly 1 (source "peg:USDG") for the same reason.
// `timestamp` is the latest block's timestamp (the end of the TWAP window).
// -----------------------------------------------------------------------------

const POOL_ABI = [
  { type: 'function', name: 'factory', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'token0', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'token1', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'fee', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint24' }] },
  { type: 'function', name: 'liquidity', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint128' }] },
  {
    type: 'function',
    name: 'observe',
    stateMutability: 'view',
    inputs: [{ name: 'secondsAgos', type: 'uint32[]' }],
    outputs: [
      { name: 'tickCumulatives', type: 'int56[]' },
      { name: 'secondsPerLiquidityCumulativeX128s', type: 'uint160[]' },
    ],
  },
] as const;
const FACTORY_ABI = [
  {
    type: 'function',
    name: 'getPool',
    stateMutability: 'view',
    inputs: [
      { type: 'address' },
      { type: 'address' },
      { type: 'uint24' },
    ],
    outputs: [{ type: 'address' }],
  },
] as const;
const ERC20_DECIMALS_ABI = [{ type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] }] as const;

export type TwapReadClient = Pick<PublicClient, 'readContract' | 'getBlock'>;

export interface RobinhoodTwapProviderConfig {
  client: TwapReadClient;
  factoryAddress: Hex;
  usdg: { address: Hex; decimals: number };
  /** asset address (any case) -> Uniswap v3 pool address. The ONLY assets this provider will price (besides USDG). */
  pools: Record<string, Hex>;
  windowSeconds?: number;
  maxAgeMs?: number;
  now?: () => Date;
}

export const DEFAULT_TWAP_WINDOW_SECONDS = 1800;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export class RobinhoodTwapPriceProvider implements PriceProvider {
  private readonly pools: Map<string, Hex>;
  private readonly windowSeconds: number;
  private readonly maxAgeMs: number;

  constructor(private readonly config: RobinhoodTwapProviderConfig) {
    this.pools = new Map(Object.entries(config.pools).map(([asset, pool]) => [asset.toLowerCase(), pool]));
    this.windowSeconds = config.windowSeconds ?? DEFAULT_TWAP_WINDOW_SECONDS;
    this.maxAgeMs = config.maxAgeMs ?? DEFAULT_MAX_PRICE_AGE_MS;
    if (!Number.isInteger(this.windowSeconds) || this.windowSeconds < 60) throw new Error('TWAP window must be an integer >= 60 seconds.');
  }

  /** Whether this provider is authoritative for `asset` (Robinhood Chain only). */
  handles(asset: AssetIdentity): boolean {
    return asset.chain === 'robinhood';
  }

  async getPrice(asset: AssetIdentity): Promise<AssetPrice> {
    if (asset.chain !== 'robinhood') throw new PriceUnavailableError(asset);
    const c = this.config.client;
    const block = await c.getBlock({ blockTag: 'latest' });
    const blockTime = new Date(Number(block.timestamp) * 1000);
    const now = this.config.now ? this.config.now() : new Date();
    if (now.getTime() - blockTime.getTime() > this.maxAgeMs) throw new PriceUnavailableError(asset); // halted chain / stale RPC

    if (same(asset.address, this.config.usdg.address)) {
      return { asset, price: '1', quoteCurrency: 'USD', timestamp: blockTime.toISOString(), source: 'peg:USDG' };
    }

    const pool = this.pools.get(asset.address.toLowerCase());
    if (!pool) throw new PriceUnavailableError(asset);

    const read = <T>(address: Hex, abi: readonly unknown[], functionName: string, args?: readonly unknown[]) =>
      c.readContract({ address, abi: abi as never, functionName: functionName as never, args: args as never }) as Promise<T>;

    const [factory, token0, token1, fee, liquidity] = await Promise.all([
      read<Hex>(pool, POOL_ABI, 'factory'),
      read<Hex>(pool, POOL_ABI, 'token0'),
      read<Hex>(pool, POOL_ABI, 'token1'),
      read<number>(pool, POOL_ABI, 'fee'),
      read<bigint>(pool, POOL_ABI, 'liquidity'),
    ]);
    if (!same(factory, this.config.factoryAddress)) throw new PriceUnavailableError(asset);
    const baseIsToken0 = same(token0, asset.address) && same(token1, this.config.usdg.address);
    const baseIsToken1 = same(token1, asset.address) && same(token0, this.config.usdg.address);
    if (!baseIsToken0 && !baseIsToken1) throw new PriceUnavailableError(asset);
    const canonical = await read<Hex>(this.config.factoryAddress, FACTORY_ABI, 'getPool', [token0, token1, fee]);
    if (!same(canonical, pool)) throw new PriceUnavailableError(asset);
    if (BigInt(liquidity) === BigInt(0)) throw new PriceUnavailableError(asset);

    let cumulatives: readonly bigint[];
    try {
      [cumulatives] = await read<readonly [readonly bigint[], readonly bigint[]]>(pool, POOL_ABI, 'observe', [[this.windowSeconds, 0]]);
    } catch {
      throw new PriceUnavailableError(asset); // "OLD": not enough observation history for the window
    }
    const meanTick = meanTickFromCumulatives(BigInt(cumulatives[0]), BigInt(cumulatives[1]), this.windowSeconds);
    const baseDecimals = Number(await read<number>(asset.address as Hex, ERC20_DECIMALS_ABI, 'decimals'));
    const scaled = priceFromSqrtRatio(getSqrtRatioAtTick(meanTick), baseIsToken0, baseDecimals, this.config.usdg.decimals, NAV_VALUE_DECIMALS);
    if (scaled <= BigInt(0)) throw new PriceUnavailableError(asset);

    return {
      asset,
      price: formatNavValue(scaled, NAV_VALUE_DECIMALS),
      quoteCurrency: 'USD',
      timestamp: blockTime.toISOString(),
      source: `uniswap-v3-twap:${pool.toLowerCase()}:${this.windowSeconds}s:USDG`,
    };
  }
}

/** Parses ROBINHOOD_PRICE_POOLS (`{"0xasset":"0xpool",...}`); throws on malformed input (a misconfigured price source must fail loudly). */
export function parseRobinhoodPricePools(raw: string | undefined): Record<string, Hex> {
  if (!raw || !raw.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('ROBINHOOD_PRICE_POOLS must be a JSON object {"0xasset":"0xpool"}.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('ROBINHOOD_PRICE_POOLS must be a JSON object.');
  const out: Record<string, Hex> = {};
  for (const [asset, pool] of Object.entries(parsed as Record<string, unknown>)) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(asset) || typeof pool !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(pool)) {
      throw new Error(`ROBINHOOD_PRICE_POOLS entry ${asset} -> ${String(pool)} is not an address pair.`);
    }
    out[asset.toLowerCase()] = pool as Hex;
  }
  return out;
}
