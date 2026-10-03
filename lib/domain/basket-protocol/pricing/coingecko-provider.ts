import { AssetIdentity, AssetPrice, ChainId } from '@/types/basket-protocol';
import { assetIdentityKey, isNativeAssetIdentity, normalizeAssetIdentity } from '../asset-identity';
import { isValidDecimalString } from './price-precision';
import { PriceProvider, PriceUnavailableError } from './provider';

// -----------------------------------------------------------------------------
// Phase 18 — Real Price Authority. The ONLY `PriceProvider` implementation
// that may ever back real money (NAV, purchase preview, purchase execution).
// `MockPriceProvider` stays in the tree for tests/fixtures only — nothing in
// this file imports it, and `lib/server/price-provider.ts` is the sole
// factory allowed to choose between them (and refuses to choose Mock in
// production — see that file).
//
// Every `AssetPrice` this returns satisfies three hard invariants a mock
// price never had to:
//   1. `price` came from CoinGecko's response, never fabricated locally.
//   2. `timestamp` is CoinGecko's OWN `last_updated_at` for that asset, not
//      our fetch time — so `isPriceStale()`/`StalePriceError` (nav.ts) catch
//      genuinely stale upstream data, not just a slow network hop.
//   3. Any missing, non-numeric, non-positive, or non-finite value —
//      network failure, timeout, unknown token, empty body, rate limit —
//      throws `PriceUnavailableError` rather than returning something a
//      caller might mistake for a real price. There is no silent fallback
//      anywhere in this file.
// -----------------------------------------------------------------------------

const DEFAULT_BASE_URL = 'https://api.coingecko.com/api/v3';
const PRO_BASE_URL = 'https://pro-api.coingecko.com/api/v3';
const DEFAULT_TIMEOUT_MS = 8_000;
/** Cache the same upstream response for a few seconds so a burst of
 * requests for the same asset (several holdings priced in one NAV calc,
 * concurrent purchase previews) doesn't multiply CoinGecko calls or trip
 * rate limits. Well under the 5-minute NAV staleness window, and the
 * cached `AssetPrice.timestamp` is still CoinGecko's own `last_updated_at`
 * — caching this response never masks the upstream data actually being
 * stale. */
const DEFAULT_CACHE_TTL_MS = 15_000;
const MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 300;

/** CoinGecko "asset platform" id for each chain this protocol supports token lookups on. `null` = CoinGecko has no platform for this chain, so only native-asset pricing (if any) is possible; a non-native address on such a chain always fails closed. Exported so `coingecko-import.ts` (registry import, not pricing) uses the exact same chain->platform mapping rather than a second hand-copied one that could drift from this one. */
export const CHAIN_TO_PLATFORM: Record<ChainId, string | null> = {
  ethereum: 'ethereum',
  base: 'base',
  arbitrum: 'arbitrum-one',
  solana: 'solana',
  robinhood: null,
};

/** CoinGecko coin id for a chain's native asset (used when `AssetIdentity` is that chain's `NATIVE_ASSET_ADDRESS` sentinel — see asset-identity.ts). */
const CHAIN_NATIVE_COIN_ID: Partial<Record<ChainId, string>> = {
  ethereum: 'ethereum',
  base: 'ethereum', // native gas asset on Base is bridged ETH
  arbitrum: 'ethereum', // native gas asset on Arbitrum One is bridged ETH
  solana: 'solana',
};

interface CacheEntry {
  price: AssetPrice;
  cachedAt: number;
}

export interface CoinGeckoPriceProviderOptions {
  /** Optional CoinGecko API key (Demo or Pro). When set, requests go to the Pro host with the key header; unset falls back to the public rate-limited endpoint. */
  apiKey?: string;
  /** Overrides the base URL entirely (tests). */
  baseUrl?: string;
  quoteCurrency?: string;
  timeoutMs?: number;
  cacheTtlMs?: number;
  /** Injectable fetch (tests) — defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injectable clock (tests). */
  now?: () => Date;
}

export class CoinGeckoPriceProvider implements PriceProvider {
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly quoteCurrency: string;
  private readonly timeoutMs: number;
  private readonly cacheTtlMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(options: CoinGeckoPriceProviderOptions = {}) {
    this.apiKey = options.apiKey || undefined;
    this.baseUrl = options.baseUrl ?? (this.apiKey ? PRO_BASE_URL : DEFAULT_BASE_URL);
    this.quoteCurrency = (options.quoteCurrency ?? 'usd').toLowerCase();
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  async getPrice(asset: AssetIdentity): Promise<AssetPrice> {
    const identity = normalizeAssetIdentity(asset);
    const key = assetIdentityKey(identity);

    const cached = this.cache.get(key);
    if (cached && this.now().getTime() - cached.cachedAt < this.cacheTtlMs) {
      return cached.price;
    }

    const price = await this.fetchPrice(identity);
    this.cache.set(key, { price, cachedAt: this.now().getTime() });
    return price;
  }

  private async fetchPrice(identity: AssetIdentity): Promise<AssetPrice> {
    const url = this.buildUrl(identity);
    if (!url) {
      // No CoinGecko platform/coin mapping exists for this identity at all
      // (e.g. Robinhood Chain, or a chain CoinGecko doesn't index) — fail
      // closed rather than guessing.
      throw new PriceUnavailableError(identity);
    }

    let lastError: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
      }
      try {
        return await this.fetchOnce(url, identity);
      } catch (err) {
        lastError = err;
        // Don't retry a response we successfully parsed and found invalid
        // (bad data won't fix itself on retry) — only retry on network-
        // level failure (timeout, fetch throw, non-2xx).
        if (err instanceof InvalidPriceDataError) break;
      }
    }
    if (lastError instanceof PriceUnavailableError) throw lastError;
    throw new PriceUnavailableError(identity);
  }

  private async fetchOnce(url: string, identity: AssetIdentity): Promise<AssetPrice> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = {};
      if (this.apiKey) headers['x-cg-pro-api-key'] = this.apiKey;

      const res = await this.fetchImpl(url, { signal: controller.signal, headers, cache: 'no-store' });
      if (!res.ok) {
        throw new PriceUnavailableError(identity);
      }
      const body = (await res.json()) as Record<string, Record<string, number | undefined>>;
      return this.parseResponse(body, identity);
    } catch (err) {
      if (err instanceof InvalidPriceDataError || err instanceof PriceUnavailableError) throw err;
      throw new PriceUnavailableError(identity); // network error, abort/timeout, JSON parse failure, ...
    } finally {
      clearTimeout(timeout);
    }
  }

  private buildUrl(identity: AssetIdentity): string | null {
    const params = new URLSearchParams({
      vs_currencies: this.quoteCurrency,
      include_last_updated_at: 'true',
    });

    if (isNativeAssetIdentity(identity)) {
      const coinId = CHAIN_NATIVE_COIN_ID[identity.chain];
      if (!coinId) return null;
      params.set('ids', coinId);
      return `${this.baseUrl}/simple/price?${params.toString()}`;
    }

    const platform = CHAIN_TO_PLATFORM[identity.chain];
    if (!platform) return null;
    params.set('contract_addresses', identity.address);
    return `${this.baseUrl}/simple/token_price/${platform}?${params.toString()}`;
  }

  private parseResponse(
    body: Record<string, Record<string, number | undefined>>,
    identity: AssetIdentity
  ): AssetPrice {
    const lookupKey = isNativeAssetIdentity(identity)
      ? CHAIN_NATIVE_COIN_ID[identity.chain]
      : identity.address;
    const entry = lookupKey ? body[lookupKey] ?? body[lookupKey.toLowerCase()] : undefined;
    if (!entry) throw new InvalidPriceDataError(identity);

    const rawPrice = entry[this.quoteCurrency];
    const lastUpdatedAt = entry[`${this.quoteCurrency}_last_updated_at`];

    if (typeof rawPrice !== 'number' || !Number.isFinite(rawPrice) || rawPrice <= 0) {
      throw new InvalidPriceDataError(identity);
    }
    if (typeof lastUpdatedAt !== 'number' || !Number.isFinite(lastUpdatedAt) || lastUpdatedAt <= 0) {
      throw new InvalidPriceDataError(identity);
    }

    const priceStr = formatFinitePrice(rawPrice);
    if (!isValidDecimalString(priceStr)) throw new InvalidPriceDataError(identity);

    return {
      asset: identity,
      price: priceStr,
      quoteCurrency: this.quoteCurrency.toUpperCase(),
      timestamp: new Date(lastUpdatedAt * 1000).toISOString(),
      source: 'coingecko',
    };
  }
}

/** Distinguishes "we got a 2xx response but couldn't make sense of it" (never worth retrying) from a network/timeout/non-2xx failure (worth a couple of retries) — both ultimately surface to the caller as `PriceUnavailableError`. */
class InvalidPriceDataError extends Error {
  constructor(public readonly asset: AssetIdentity) {
    super(`Invalid/missing price data from CoinGecko for ${asset.chain}:${asset.address}`);
    this.name = 'InvalidPriceDataError';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** CoinGecko returns a JS number; convert to a plain decimal string without exponential notation or float artifacts. `Number.prototype.toString()` already produces the shortest round-trip decimal representation for any normal-range value (e.g. `(1.0002).toString() === "1.0002"`) — it's ONLY exponential notation (very small/large magnitudes, e.g. `1e-7`) that needs manual expansion. Deliberately not `toFixed()`: `toFixed(18)` re-expands the binary float to 18 fixed digits and exposes its inexactness (e.g. `(1.0002).toFixed(18)` renders trailing float noise that was never actually meaningful precision). */
function formatFinitePrice(value: number): string {
  const str = value.toString();
  if (!str.includes('e') && !str.includes('E')) return str;

  const negative = value < 0;
  const abs = Math.abs(value);
  const [mantissa, exponentStr] = abs.toExponential().split('e');
  const exponent = Number(exponentStr);
  const [whole, fraction = ''] = mantissa.split('.');
  const digits = whole + fraction;

  let result: string;
  if (exponent >= 0) {
    const pointIndex = exponent + 1;
    result = pointIndex >= digits.length
      ? digits.padEnd(pointIndex, '0')
      : `${digits.slice(0, pointIndex)}.${digits.slice(pointIndex)}`;
  } else {
    result = `0.${'0'.repeat(-exponent - 1)}${digits}`;
  }
  return negative ? `-${result}` : result;
}
