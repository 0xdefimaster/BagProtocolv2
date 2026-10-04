import { getToken } from '@lifi/sdk';
import { AssetIdentity, AssetPrice, ChainId } from '@/types/basket-protocol';
import { getLiFiClient, toLiFiChainId } from './lifi-config';
import { PriceDataGapError, PriceProvider, PriceUnavailableError } from '@/lib/domain/basket-protocol/pricing/provider';
import { parseUnsignedDecimal } from '@/lib/domain/basket-protocol/pricing/decimal-math';

// -----------------------------------------------------------------------------
// Crypto token metadata + indicative USD price from LI.FI — through the SAME
// `@lifi/sdk` client the quote/execution path uses (lifi-config.ts). No second
// LI.FI integration and no second crypto price system.
//
// `GET /v1/token?chain=&token=` returns {address, symbol, decimals, chainId,
// name, logoURI, priceUSD}. Every field is validated against what was asked
// for (chain id, address) before use; priceUSD must be a positive decimal
// string. LI.FI publishes no timestamp for priceUSD, so a price is stamped with
// the time it was fetched and cached for `ttlMs` (default 60 s).
//
// Error semantics (these decide whether a fallback source may be used):
//   token unknown to LI.FI (HTTP 400/404) or no priceUSD → PriceDataGapError
//   network / 5xx / 429 / malformed answer               → PriceUnavailableError
//
// This price is INDICATIVE (valuation, NAV, previews). What a purchase
// actually receives comes from a LI.FI route/quote (lifi-purchase-quote.ts,
// lib/execution), never from priceUSD.
// -----------------------------------------------------------------------------

export interface BagCryptoAsset {
  chainId: number;
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  logoURI?: string;
  priceUSD?: string;
  priceSource: 'LIFI';
}

export class LiFiTokenUnavailableError extends Error {
  constructor(public readonly chainId: number, public readonly address: string, public readonly kind: 'NOT_FOUND' | 'OUTAGE' | 'INVALID', message: string) {
    super(message);
    this.name = 'LiFiTokenUnavailableError';
  }
}

export type LiFiTokenFetcher = (chainId: number, address: string) => Promise<unknown>;

const defaultFetcher: LiFiTokenFetcher = (chainId, address) => getToken(getLiFiClient(), chainId, address);

function httpStatus(err: unknown): number | undefined {
  const e = err as { status?: unknown; cause?: { status?: unknown } } | null;
  const s = e?.status ?? e?.cause?.status;
  return typeof s === 'number' ? s : undefined;
}

/** Validates a LI.FI token object against the requested identity. Throws LiFiTokenUnavailableError('INVALID') on any mismatch. */
export function normalizeLiFiToken(raw: unknown, expected: { chainId: number; address: string }): BagCryptoAsset {
  const t = raw as Record<string, unknown> | null;
  const bad = (why: string) => new LiFiTokenUnavailableError(expected.chainId, expected.address, 'INVALID', `LI.FI token ${expected.chainId}:${expected.address}: ${why}`);
  if (!t || typeof t !== 'object') throw bad('not an object');
  if (t.chainId !== expected.chainId) throw bad(`chainId ${String(t.chainId)}`);
  if (typeof t.address !== 'string' || t.address.toLowerCase() !== expected.address.toLowerCase()) throw bad(`address ${String(t.address)}`);
  if (typeof t.symbol !== 'string' || !t.symbol.trim()) throw bad('missing symbol');
  if (!Number.isInteger(t.decimals) || (t.decimals as number) < 0 || (t.decimals as number) > 36) throw bad(`decimals ${String(t.decimals)}`);
  const price = typeof t.priceUSD === 'string' ? t.priceUSD.trim() : undefined;
  const scaled = price !== undefined ? parseUnsignedDecimal(price) : null;
  return {
    chainId: expected.chainId,
    address: t.address,
    symbol: t.symbol,
    name: typeof t.name === 'string' ? t.name : t.symbol,
    decimals: t.decimals as number,
    logoURI: typeof t.logoURI === 'string' && t.logoURI.startsWith('https://') ? t.logoURI : undefined,
    priceUSD: scaled !== null && scaled > BigInt(0) ? price : undefined,
    priceSource: 'LIFI',
  };
}

export interface LiFiTokenDataOptions {
  fetchToken?: LiFiTokenFetcher;
  ttlMs?: number;
  now?: () => number;
}

export class LiFiTokenData {
  private readonly fetchToken: LiFiTokenFetcher;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly cache = new Map<string, { at: number; value: Promise<BagCryptoAsset> }>();

  constructor(opts: LiFiTokenDataOptions = {}) {
    this.fetchToken = opts.fetchToken ?? defaultFetcher;
    this.ttlMs = opts.ttlMs ?? 60_000;
    this.now = opts.now ?? Date.now;
  }

  private key(chainId: number, address: string) {
    return `${chainId}:${address.toLowerCase()}`;
  }

  /** Cached, de-duplicated token lookup. Returns the fetch time alongside. */
  async getTokenWithTime(chain: ChainId, address: string): Promise<{ token: BagCryptoAsset; fetchedAt: number }> {
    const chainId = toLiFiChainId(chain);
    const key = this.key(chainId, address);
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < this.ttlMs) return { token: await hit.value, fetchedAt: hit.at };
    const entry = {
      at: this.now(),
      value: this.fetchToken(chainId, address).then(
        (raw) => normalizeLiFiToken(raw, { chainId, address }),
        (err) => {
          const status = httpStatus(err);
          throw new LiFiTokenUnavailableError(
            chainId,
            address,
            status === 400 || status === 404 ? 'NOT_FOUND' : 'OUTAGE',
            `LI.FI token lookup ${chainId}:${address} failed${status ? ` (HTTP ${status})` : ''}: ${(err as Error)?.message ?? String(err)}`
          );
        }
      ),
    };
    this.cache.set(key, entry);
    entry.value.catch(() => {
      if (this.cache.get(key) === entry) this.cache.delete(key);
    });
    return { token: await entry.value, fetchedAt: entry.at };
  }

  async getToken(chain: ChainId, address: string): Promise<BagCryptoAsset> {
    return (await this.getTokenWithTime(chain, address)).token;
  }

  /** Seeds the cache from a token LI.FI already returned elsewhere (e.g. inside a quote), avoiding a second call. Invalid tokens are ignored. */
  prime(raw: unknown): void {
    const t = raw as { chainId?: unknown; address?: unknown } | null;
    if (!t || typeof t.chainId !== 'number' || typeof t.address !== 'string') return;
    try {
      const token = normalizeLiFiToken(raw, { chainId: t.chainId, address: t.address });
      this.cache.set(this.key(t.chainId, t.address), { at: this.now(), value: Promise.resolve(token) });
    } catch {
      /* not a usable token object */
    }
  }
}

let shared: LiFiTokenData | null = null;
/** Process-wide instance so pricing, the asset API and quote priming share one cache. */
export function getLiFiTokenData(): LiFiTokenData {
  if (!shared) shared = new LiFiTokenData();
  return shared;
}
export function __resetLiFiTokenDataForTests(): void {
  shared = null;
}

/** Indicative crypto price from LI.FI's priceUSD. */
export class LiFiPriceProvider implements PriceProvider {
  constructor(private readonly data: LiFiTokenData) {}

  async getPrice(asset: AssetIdentity): Promise<AssetPrice> {
    let result: { token: BagCryptoAsset; fetchedAt: number };
    try {
      result = await this.data.getTokenWithTime(asset.chain, asset.address);
    } catch (err) {
      if (err instanceof LiFiTokenUnavailableError && err.kind === 'NOT_FOUND') throw new PriceDataGapError(asset, 'lifi', 'token unknown to LI.FI');
      throw new PriceUnavailableError(asset, 'SOURCE_UNAVAILABLE');
    }
    if (!result.token.priceUSD) throw new PriceDataGapError(asset, 'lifi', 'no priceUSD');
    return {
      asset,
      price: result.token.priceUSD,
      quoteCurrency: 'USD',
      timestamp: new Date(result.fetchedAt).toISOString(),
      source: `lifi:token:${result.token.chainId}`,
    };
  }
}
