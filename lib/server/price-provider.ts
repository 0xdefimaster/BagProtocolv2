import { PriceProvider } from '@/lib/domain/basket-protocol/pricing/provider';
import { CoinGeckoPriceProvider } from '@/lib/domain/basket-protocol/pricing/coingecko-provider';
import { MockPriceProvider } from '@/lib/domain/basket-protocol/pricing/mock-provider';
import { ChainId } from '@/types/basket-protocol';
import { parseRobinhoodPricePools, RobinhoodTwapPriceProvider } from '@/lib/domain/basket-protocol/pricing/robinhood-twap-provider';
import { ROBINHOOD_REWARD_TOKEN, UNISWAP_V3_FACTORY_ADDRESS } from '@/lib/config/robinhood-chain';
import { getRobinhoodPublicClient } from '@/lib/blockchain/robinhood-public-client';
import { ChainlinkFeedPriceProvider, parseChainlinkFeeds } from '@/lib/domain/basket-protocol/pricing/chainlink-feed-provider';
import { RobinhoodApiPriceProvider, RobinhoodStockApi } from '@/lib/domain/basket-protocol/pricing/robinhood-stock-api';
import { BagPriceRouter } from '@/lib/domain/basket-protocol/pricing/bag-price-router';
import { getLiFiTokenData, LiFiPriceProvider } from '@/lib/blockchain/lifi-token-data';

// -----------------------------------------------------------------------------
// Phase 18 — the ONLY place production code may obtain a `PriceProvider`.
// Every route/service that prices real money (purchase-preview,
// purchase-execution, bag-nav) must call `getPriceProvider()` here instead
// of importing `MockPriceProvider` directly. This is what makes
// "MockPriceProvider can't run in production" an enforced invariant rather
// than a convention: `PRICE_PROVIDER=mock` is only honored outside
// production, and this module throws at first use (fail fast, not fail
// silent) if that guard would otherwise be bypassed.
// -----------------------------------------------------------------------------

let cachedProvider: PriceProvider | null = null;
let cachedDisplayProvider: PriceProvider | null = null;

/**
 * Spread limit for DISPLAY-only valuation (TVL, position value, NAV history).
 * Robinhood's stock-token quotes widen a lot while US markets are closed (an
 * 8% spread is normal overnight); the purchase/redeem limit (500 bps) would
 * then make a whole Bag's TVL unknown. Money paths never use this.
 */
export const DISPLAY_MAX_SPREAD_BPS = 2500;
let cachedStockApi: RobinhoodStockApi | null = null;

/** Process-wide Robinhood Stock Token API client, so the registry cache, the 15 s price cache and the 60 req/s limiter are shared by pricing and the quotes route. */
export function getRobinhoodStockApi(): RobinhoodStockApi {
  if (!cachedStockApi) cachedStockApi = new RobinhoodStockApi();
  return cachedStockApi;
}

function optionalInt(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer.`);
  return n;
}

export class MockPriceProviderInProductionError extends Error {
  constructor() {
    super(
      'PRICE_PROVIDER=mock is set but NODE_ENV=production. Refusing to start a real-money price path on mock/deterministic prices.'
    );
    this.name = 'MockPriceProviderInProductionError';
  }
}

function buildProvider(options: { maxSpreadBps?: number } = {}): PriceProvider {
  const isProduction = process.env.NODE_ENV === 'production';
  const explicitMock = process.env.PRICE_PROVIDER === 'mock';

  if (explicitMock) {
    if (isProduction) throw new MockPriceProviderInProductionError();
    return new MockPriceProvider();
  }

  // One router for every chain (bag-price-router.ts, docs/PRICE_AND_DATA_LAYER.md):
  //   Stock Tokens → Robinhood /rhj/prices (× multiplier), verified by Chainlink when a feed is configured
  //   crypto       → LI.FI priceUSD; a fallback only on a LI.FI data gap:
  //                  Robinhood → Uniswap v3 TWAP (configured pools); other chains →
  //                  CoinGecko only if CRYPTO_PRICE_FALLBACK=coingecko
  const client = getRobinhoodPublicClient();
  const twap = new RobinhoodTwapPriceProvider({
    client,
    factoryAddress: UNISWAP_V3_FACTORY_ADDRESS,
    usdg: { address: ROBINHOOD_REWARD_TOKEN.address, decimals: ROBINHOOD_REWARD_TOKEN.decimals },
    pools: parseRobinhoodPricePools(process.env.ROBINHOOD_PRICE_POOLS),
    windowSeconds: optionalInt('ROBINHOOD_TWAP_WINDOW_SECONDS'),
  });
  const cryptoFallbacks: Partial<Record<ChainId, PriceProvider>> = { robinhood: twap };
  if (process.env.CRYPTO_PRICE_FALLBACK === 'coingecko') {
    const coingecko = new CoinGeckoPriceProvider({ apiKey: process.env.COINGECKO_API_KEY });
    for (const chain of ['ethereum', 'base', 'arbitrum'] as const) cryptoFallbacks[chain] = coingecko;
  }
  const api = getRobinhoodStockApi();
  const chainlinkMaxAge = optionalInt('ROBINHOOD_CHAINLINK_MAX_AGE_SECONDS');
  const apiMaxAge = optionalInt('ROBINHOOD_API_MAX_AGE_SECONDS');
  return new BagPriceRouter({
    stockApi: api,
    stockPrices: new RobinhoodApiPriceProvider({
      api,
      maxAgeMs: apiMaxAge === undefined ? undefined : apiMaxAge * 1000,
      maxSpreadBps: options.maxSpreadBps ?? optionalInt('ROBINHOOD_API_MAX_SPREAD_BPS'),
    }),
    chainlink: new ChainlinkFeedPriceProvider({
      client,
      feeds: parseChainlinkFeeds(process.env.ROBINHOOD_CHAINLINK_FEEDS),
      maxAgeMs: chainlinkMaxAge === undefined ? undefined : chainlinkMaxAge * 1000,
    }),
    crypto: new LiFiPriceProvider(getLiFiTokenData()),
    cryptoFallbacks,
    usdgAddress: ROBINHOOD_REWARD_TOKEN.address,
    maxDeviationBps: optionalInt('ROBINHOOD_PRICE_MAX_DEVIATION_BPS'),
  });
}

/** Returns the process-wide `PriceProvider` for all real-money code paths. Memoized so the providers' caches are actually shared across calls within one server process/request lifecycle. */
export function getPriceProvider(): PriceProvider {
  if (!cachedProvider) cachedProvider = buildProvider();
  return cachedProvider;
}

/**
 * Same router as `getPriceProvider()` but with the wider DISPLAY_MAX_SPREAD_BPS
 * stock-quote spread limit (the mid price is still used). ONLY for showing
 * value — Bag TVL, a holder's position value, NAV snapshots. Purchases,
 * redemptions and their previews must keep using `getPriceProvider()`.
 */
export function getDisplayPriceProvider(): PriceProvider {
  if (!cachedDisplayProvider) {
    const configured = optionalInt('ROBINHOOD_API_MAX_SPREAD_BPS');
    cachedDisplayProvider = buildProvider({ maxSpreadBps: Math.max(configured ?? 0, DISPLAY_MAX_SPREAD_BPS) });
  }
  return cachedDisplayProvider;
}

/** Test-only: clears the memoized provider so tests can rebuild it under different env vars. Never call from production code. */
export function __resetPriceProviderForTests(): void {
  cachedProvider = null;
  cachedDisplayProvider = null;
  cachedStockApi = null;
}
