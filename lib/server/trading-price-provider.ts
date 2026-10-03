import { TRADABLE_ASSETS } from '@/lib/config/market';
import { TradableSymbol } from '@/types/domain';

// -----------------------------------------------------------------------------
// Phase 18.6 — Trusted server-side price source for paper trading.
//
// `app/api/trades` used to trust whatever `price`/`prices` value the client
// sent in the request body. Those numbers ultimately come from
// `lib/market/market-data.ts`, which lives in the browser's `localStorage` —
// trivially editable from DevTools, or simply substitutable by hand-crafting
// the POST body. That let a client fabricate an arbitrary execution price
// for a BUY/SELL, which (via `applyTrade()`) fabricates realized PnL, which
// (via `syncPointsFromRealizedPnL`) fabricates BAG Points and, from there,
// Leaderboard rank.
//
// This module is the ONLY place `app/api/trades` may obtain an execution
// price. It deliberately mirrors the same fail-closed shape as
// `lib/domain/basket-protocol/pricing/coingecko-provider.ts` (the real-money
// `CoinGeckoPriceProvider`) — every price comes from CoinGecko's own
// response, never fabricated locally, and a symbol CoinGecko didn't price
// this round is simply absent from the result rather than defaulting to
// something a caller might mistake for a real price. Unlike
// `CoinGeckoPriceProvider`, this feed is keyed by the simple ticker symbols
// paper trading already uses (`TradableSymbol`, e.g. "BTC") rather than a
// chain+address `AssetIdentity` — the mock market has no on-chain identity
// to key on, and forcing one would be more machinery than the problem needs.
//
// All eight `TRADABLE_ASSETS` are fetched and cached together (one
// CoinGecko call, same `/simple/price` endpoint the client-side
// `lib/market/price-feed.ts` already uses) since the list is small and
// fixed — the same batching lib/market/price-feed.ts already does, just
// server-side and cached across requests instead of per-browser-tab.
// -----------------------------------------------------------------------------

const COINGECKO_URL = 'https://api.coingecko.com/api/v3/simple/price';
const DEFAULT_TIMEOUT_MS = 8_000;
/** Well under the couple-of-seconds a user waits for a trade to confirm, but long enough that a burst of trades (or an invest() fanning out across several symbols) shares one upstream call. */
const DEFAULT_CACHE_TTL_MS = 15_000;
const MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 300;

export type TradingPriceMap = Partial<Record<TradableSymbol, number>>;

/** Thrown when the trusted feed has no current price for a symbol — unknown symbol, or CoinGecko unavailable/rate-limited/timed out for it. The caller (app/api/trades) must reject the trade rather than fall back to any client-supplied number. */
export class TradingPriceUnavailableError extends Error {
  constructor(public readonly symbol: string) {
    super(`No trusted server-side price available for ${symbol}.`);
    this.name = 'TradingPriceUnavailableError';
  }
}

export interface ServerTradingPriceFeedOptions {
  /** Injectable fetch (tests) — defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injectable clock (tests). */
  now?: () => Date;
  timeoutMs?: number;
  cacheTtlMs?: number;
}

interface CacheEntry {
  prices: TradingPriceMap;
  cachedAt: number;
}

export class ServerTradingPriceFeed {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly timeoutMs: number;
  private readonly cacheTtlMs: number;
  private cache: CacheEntry | null = null;
  private inFlight: Promise<TradingPriceMap> | null = null;

  constructor(options: ServerTradingPriceFeedOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  }

  /**
   * Trusted USD prices for every tradable symbol CoinGecko successfully
   * priced this round. A symbol missing from the result could not be
   * verified and MUST be treated as unpriced — never fall back to a
   * caller-supplied number for it.
   */
  async getPrices(): Promise<TradingPriceMap> {
    const cached = this.cache;
    if (cached && this.now().getTime() - cached.cachedAt < this.cacheTtlMs) {
      return cached.prices;
    }

    // Collapse concurrent callers (e.g. invest() pricing several symbols,
    // or two simultaneous trade requests) onto a single upstream fetch
    // instead of each racing off their own CoinGecko call.
    if (!this.inFlight) {
      this.inFlight = this.fetchPrices().finally(() => {
        this.inFlight = null;
      });
    }

    const prices = await this.inFlight;
    this.cache = { prices, cachedAt: this.now().getTime() };
    return prices;
  }

  /** Trusted USD price for a single symbol. Throws `TradingPriceUnavailableError` — never returns a guessed or zero price — if the symbol is unknown or couldn't be priced this round. */
  async getPrice(symbol: string): Promise<number> {
    const prices = await this.getPrices();
    const price = prices[symbol as TradableSymbol];
    if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) {
      throw new TradingPriceUnavailableError(symbol);
    }
    return price;
  }

  private async fetchPrices(): Promise<TradingPriceMap> {
    const ids = TRADABLE_ASSETS.map((a) => a.coingeckoId).join(',');
    const url = `${COINGECKO_URL}?ids=${ids}&vs_currencies=usd`;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
      }
      try {
        return await this.fetchOnce(url);
      } catch {
        // Network failure, timeout, non-2xx, bad JSON — retry a couple of
        // times, then fail closed (empty map) rather than throw and take
        // down every symbol's trade because one upstream call hiccupped.
      }
    }
    return {};
  }

  private async fetchOnce(url: string): Promise<TradingPriceMap> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, { signal: controller.signal, cache: 'no-store' });
      if (!res.ok) throw new Error(`CoinGecko responded ${res.status}`);

      const body = (await res.json()) as Record<string, { usd?: number }>;
      const prices: TradingPriceMap = {};
      for (const asset of TRADABLE_ASSETS) {
        const usd = body[asset.coingeckoId]?.usd;
        if (typeof usd === 'number' && Number.isFinite(usd) && usd > 0) {
          prices[asset.symbol] = usd;
        }
      }
      return prices;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let cachedFeed: ServerTradingPriceFeed | null = null;

/** Returns the process-wide trusted price feed for all paper-trading execution. Memoized so its cache is actually shared across requests within one server process/request lifecycle — same convention as `lib/server/price-provider.ts`. */
export function getTradingPriceFeed(): ServerTradingPriceFeed {
  if (!cachedFeed) cachedFeed = new ServerTradingPriceFeed();
  return cachedFeed;
}

/** Test-only: replaces (or clears) the memoized feed so tests can inject a `ServerTradingPriceFeed` with a fake `fetchImpl`/`now`. Never call from production code. */
export function __setTradingPriceFeedForTests(feed: ServerTradingPriceFeed | null): void {
  cachedFeed = feed;
}
