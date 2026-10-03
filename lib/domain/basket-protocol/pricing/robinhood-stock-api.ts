import { AssetIdentity, AssetPrice } from '@/types/basket-protocol';
import { PriceProvider, PriceUnavailableError } from './provider';
import { DEFAULT_MAX_PRICE_AGE_MS } from './staleness';
import { deviationBps, midScaled, mulScaled, parseUnsignedDecimal, toDecimalString } from './decimal-math';
import { fetchRobinhoodAssets, ROBINHOOD_CHAIN_ID, RobinhoodAsset } from '../registry/robinhood-import';

// -----------------------------------------------------------------------------
// Robinhood's first-party, keyless, read-only Stock Token API
// (docs.robinhood.com/chain/stock-token-apis). The ONLY source of Stock Token
// identity, metadata, multipliers, trading capabilities, corporate actions and
// bid/ask in BAG. LI.FI never replaces it.
//
//   GET /rhj/assets             {"assets":[{id, tokenSymbol, tokenName,
//        deployments:[{contractAddress, chainId, networkName}],
//        currentMultiplier, pendingMultiplier ("" when none),
//        pendingMultiplierEffectiveTime?, status, logoUrl,
//        tradingCapabilities:{market|extended|overnight:{whole, fractional}},
//        tokenDecimals, isin}]}
//   GET /rhj/prices/{symbol}    {"quotes":[{tokenSymbol, deployments, bid, ask,
//        currency, dailyTradingVolume, isTradingHalt, generatedAt, …}]}
//        raw UNDERLYING-equity bid/ask; 404 = no quote for that symbol
//   GET /rhj/corporate-actions  {"corpActions":[{id, type, status,
//        processDate:{year,month,day}, tokenSymbol, deployments, details}]}
// Every numeric is a decimal STRING. Response shapes above are from live
// captures (MIT-licensed fixtures in __tests__/fixtures, see README there).
// Documented: /prices cache window 15 s; all endpoints 60 req/s.
//
// RULE 1 — identity is the registry ADDRESS, never a ticker. An address is a
//   Stock Token only if /assets lists it ACTIVE on chainId 4663. A quote whose
//   own `deployments` names a different 4663 contract is rejected.
// RULE 2 — /prices is per SHARE; one token = currentMultiplier shares, so
//   tokenPrice = underlyingPrice × currentMultiplier. Everything returned here
//   is per TOKEN, raw values kept alongside.
// -----------------------------------------------------------------------------

export const ROBINHOOD_API_BASE = 'https://api.robinhood.com/rhj';
export const ROBINHOOD_PRICES_URL = `${ROBINHOOD_API_BASE}/prices`;
export const ROBINHOOD_CORPORATE_ACTIONS_URL = `${ROBINHOOD_API_BASE}/corporate-actions`;
/** Documented cache window of /rhj/prices. */
export const ROBINHOOD_PRICES_CACHE_MS = 15_000;
/** Documented rate limit of every /rhj endpoint. */
export const ROBINHOOD_API_RATE_LIMIT_PER_SEC = 60;
/** Registry refresh interval (identity data changes rarely). */
export const ROBINHOOD_ASSETS_CACHE_MS = 5 * 60 * 1000;
/** Corporate actions change at most daily; not re-fetched per page load. */
export const ROBINHOOD_CORPORATE_ACTIONS_CACHE_MS = 60 * 60 * 1000;
const REGISTRY_RETRY_MS = 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;
const RATE_LIMIT_BACKOFF_MS = 2_000;
const ACTIVE_STATUS = 'ASSET_STATUS_ACTIVE';
const TRADABLE = 'TRADING_STATUS_TRADABLE';
/** Default for NAV-grade use: a quote wider than 5% is not a price. */
export const DEFAULT_MAX_SPREAD_BPS = 500;

export class RobinhoodPriceApiError extends Error {
  constructor(message: string, public readonly kind: 'NETWORK' | 'TIMEOUT' | 'RATE_LIMITED' | 'HTTP' | 'NO_QUOTE' | 'SHAPE' | 'IDENTITY' = 'SHAPE', public readonly cause?: unknown) {
    super(message);
    this.name = 'RobinhoodPriceApiError';
  }
}

export interface RobinhoodRawPrice {
  bid: bigint;
  ask: bigint;
  currency: string;
  dailyTradingVolume: string | null;
  isTradingHalt: boolean;
  generatedAt: string;
  /** Robinhood Chain contract the quote itself names, when present. */
  contractAddress: string | null;
}

export type TradingSession = 'market' | 'extended' | 'overnight';
export type TradingCapabilities = Partial<Record<TradingSession, { whole: boolean; fractional: boolean }>>;

export interface RobinhoodStockToken {
  id: string;
  symbol: string;
  name: string;
  address: string;
  decimals: number;
  currentMultiplier: string;
  /** Non-null when a corporate action is about to change the multiplier. */
  pendingMultiplier: string | null;
  pendingMultiplierEffectiveTime: string | null;
  logoUrl: string | null;
  tradingCapabilities: TradingCapabilities;
}

export interface RobinhoodStockQuote {
  token: RobinhoodStockToken;
  /** Per TOKEN (raw × currentMultiplier). Decimal strings, 18 dp. */
  bid: string;
  ask: string;
  mid: string;
  /** Raw underlying-equity values exactly as the API quotes one share. */
  rawBid: string;
  rawAsk: string;
  currency: string;
  spreadBps: number;
  dailyTradingVolume: string | null;
  isTradingHalt: boolean;
  generatedAt: string;
}

export interface RobinhoodCorporateAction {
  id: string;
  type: string;
  status: string;
  /** ISO date (YYYY-MM-DD). */
  processDate: string | null;
  tokenSymbol: string;
  /** Robinhood Chain contract the action applies to, when listed. */
  contractAddress: string | null;
  /** Cash dividend per underlying share (decimal string), when `type` is a cash dividend. */
  cashDividendRate: string | null;
  details: Record<string, unknown>;
}

// ----------------------------- rate limiting ---------------------------------

/** Sliding one-second window shared by every /rhj call in this process; waits instead of exceeding the limit. `pause()` backs off after a 429. */
export class RateLimiter {
  private stamps: number[] = [];
  private pausedUntil = 0;
  constructor(
    private readonly perSecond: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))
  ) {}
  pause(ms: number): void {
    this.pausedUntil = Math.max(this.pausedUntil, this.now() + ms);
  }
  async take(): Promise<void> {
    for (;;) {
      const t = this.now();
      if (t < this.pausedUntil) {
        await this.sleep(this.pausedUntil - t);
        continue;
      }
      this.stamps = this.stamps.filter((s) => t - s < 1000);
      if (this.stamps.length < this.perSecond) {
        this.stamps.push(t);
        return;
      }
      await this.sleep(1000 - (t - this.stamps[0]) + 1);
    }
  }
}

// ----------------------------- parsing ---------------------------------------

/** protobuf Timestamp `{year, month, day}` or an ISO string → ISO string. */
export function parseApiDate(v: unknown): string | null {
  if (typeof v === 'string' && v.trim() && !Number.isNaN(Date.parse(v))) return v;
  if (v && typeof v === 'object') {
    const d = v as { year?: unknown; month?: unknown; day?: unknown };
    if (typeof d.year === 'number' && typeof d.month === 'number' && typeof d.day === 'number') {
      return `${String(d.year).padStart(4, '0')}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
    }
  }
  return null;
}

function chainDeploymentAddress(deployments: unknown): string | null {
  if (!Array.isArray(deployments)) return null;
  const d = deployments.find((x) => x && typeof x === 'object' && (x as { chainId?: unknown }).chainId === ROBINHOOD_CHAIN_ID) as
    | { contractAddress?: unknown }
    | undefined;
  return d && typeof d.contractAddress === 'string' && /^0x[0-9a-fA-F]{40}$/.test(d.contractAddress) ? d.contractAddress.toLowerCase() : null;
}

/**
 * Validates a /rhj/prices body. Accepts the live `{"quotes":[…]}` wrapper
 * (picking the quote for `symbol`) and a bare quote object. Throws on
 * anything else: a price source whose shape changed must fail loudly.
 */
export function parseRobinhoodPrice(body: unknown, symbol: string): RobinhoodRawPrice {
  let o = body as Record<string, unknown> | null;
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw new RobinhoodPriceApiError(`/prices/${symbol}: response is not an object`);
  if (Array.isArray(o.quotes)) {
    const quotes = o.quotes as Record<string, unknown>[];
    const match = quotes.find((q) => typeof q?.tokenSymbol === 'string' && q.tokenSymbol.toUpperCase() === symbol.toUpperCase());
    const q = match ?? (quotes.length === 1 && quotes[0]?.tokenSymbol === undefined ? quotes[0] : undefined);
    if (!q) throw new RobinhoodPriceApiError(`/prices/${symbol}: no quote for ${symbol}`, 'NO_QUOTE');
    o = q;
  }
  const bid = parseUnsignedDecimal(o.bid);
  const ask = parseUnsignedDecimal(o.ask);
  if (bid === null || ask === null) throw new RobinhoodPriceApiError(`/prices/${symbol}: missing or non-decimal bid/ask — API shape may have changed`);
  if (typeof o.isTradingHalt !== 'boolean') throw new RobinhoodPriceApiError(`/prices/${symbol}: missing isTradingHalt`);
  if (typeof o.generatedAt !== 'string' || Number.isNaN(Date.parse(o.generatedAt))) {
    throw new RobinhoodPriceApiError(`/prices/${symbol}: missing or invalid generatedAt`);
  }
  const currency = o.currency === undefined ? 'USD' : o.currency;
  if (currency !== 'USD') throw new RobinhoodPriceApiError(`/prices/${symbol}: unsupported currency ${String(currency)}`);
  const vol = o.dailyTradingVolume;
  return {
    bid,
    ask,
    currency,
    dailyTradingVolume: typeof vol === 'string' || typeof vol === 'number' ? String(vol) : null,
    isTradingHalt: o.isTradingHalt,
    generatedAt: new Date(o.generatedAt).toISOString(),
    contractAddress: chainDeploymentAddress(o.deployments),
  };
}

function parseTradingCapabilities(raw: unknown): TradingCapabilities {
  const out: TradingCapabilities = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const session of ['market', 'extended', 'overnight'] as const) {
    const s = (raw as Record<string, unknown>)[session] as Record<string, unknown> | undefined;
    if (s && typeof s === 'object') out[session] = { whole: s.whole === TRADABLE, fractional: s.fractional === TRADABLE };
  }
  return out;
}

/** An ACTIVE chain-4663 deployment with a sane symbol, positive multiplier and decimals — else null (not a BAG Stock Token). */
export function toStockToken(a: RobinhoodAsset): RobinhoodStockToken | null {
  if (a.status !== ACTIVE_STATUS) return null;
  const address = chainDeploymentAddress(a.deployments);
  if (!address) return null;
  if (typeof a.tokenSymbol !== 'string' || !/^[A-Za-z0-9.\-]{1,16}$/.test(a.tokenSymbol)) return null;
  const m = parseUnsignedDecimal(a.currentMultiplier);
  if (m === null || m === BigInt(0)) return null;
  if (!Number.isInteger(a.tokenDecimals) || a.tokenDecimals < 0 || a.tokenDecimals > 36) return null;
  const pending = a.pendingMultiplier;
  const pendingStr = typeof pending === 'string' ? pending.trim() : typeof pending === 'number' ? String(pending) : '';
  return {
    id: String(a.id),
    symbol: a.tokenSymbol,
    name: a.tokenName,
    address,
    decimals: a.tokenDecimals,
    currentMultiplier: String(a.currentMultiplier),
    pendingMultiplier: pendingStr && parseUnsignedDecimal(pendingStr) !== null ? pendingStr : null,
    pendingMultiplierEffectiveTime: parseApiDate(a.pendingMultiplierEffectiveTime),
    logoUrl: typeof a.logoUrl === 'string' && a.logoUrl.startsWith('https://') ? a.logoUrl : null,
    tradingCapabilities: parseTradingCapabilities(a.tradingCapabilities),
  };
}

/** Bag purchases buy fractional token amounts: tradable when some session allows fractional trading. Missing capabilities = not tradable (fail closed). */
export function isFractionallyTradable(token: RobinhoodStockToken): boolean {
  return Object.values(token.tradingCapabilities).some((s) => s?.fractional === true);
}

export function parseCorporateActions(body: unknown): RobinhoodCorporateAction[] {
  const o = body as Record<string, unknown> | null;
  const items = Array.isArray(o) ? o : o && Array.isArray(o.corpActions) ? (o.corpActions as unknown[]) : null;
  if (!items) throw new RobinhoodPriceApiError('/corporate-actions: no corpActions array — API shape may have changed');
  const out: RobinhoodCorporateAction[] = [];
  for (const raw of items) {
    const a = raw as Record<string, unknown>;
    if (!a || typeof a.id !== 'string' || typeof a.type !== 'string' || typeof a.tokenSymbol !== 'string') continue;
    const details = a.details && typeof a.details === 'object' ? (a.details as Record<string, unknown>) : {};
    const cash = details.cashDividend as { rate?: unknown } | undefined;
    const rate = cash && parseUnsignedDecimal(cash.rate) !== null ? String(cash.rate) : null;
    out.push({
      id: a.id,
      type: a.type,
      status: typeof a.status === 'string' ? a.status : 'UNKNOWN',
      processDate: parseApiDate(a.processDate),
      tokenSymbol: a.tokenSymbol,
      contractAddress: chainDeploymentAddress(a.deployments),
      cashDividendRate: rate,
      details,
    });
  }
  return out;
}

// ----------------------------- client ----------------------------------------

export interface RobinhoodStockApiOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
  limiter?: RateLimiter;
  baseUrl?: string;
  timeoutMs?: number;
}

/**
 * Registry + prices + corporate actions, each cached on its own window:
 * registry 5 min (last good copy kept through outages), a symbol's price at
 * most once per 15 s, corporate actions 1 h. Concurrent requests share one
 * fetch; failures are never cached; a 429 pauses every /rhj call briefly.
 */
export class RobinhoodStockApi {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly limiter: RateLimiter;
  private readonly base: string;
  private readonly timeoutMs: number;
  private registry: { at: number; byAddress: Map<string, RobinhoodStockToken>; bySymbol: Map<string, RobinhoodStockToken> } | null = null;
  private registryInFlight: Promise<void> | null = null;
  private readonly prices = new Map<string, { at: number; value: Promise<RobinhoodRawPrice> }>();
  private actions: { at: number; value: Promise<RobinhoodCorporateAction[]> } | null = null;

  constructor(opts: RobinhoodStockApiOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    this.limiter = opts.limiter ?? new RateLimiter(ROBINHOOD_API_RATE_LIMIT_PER_SEC, this.now);
    this.base = opts.baseUrl ?? ROBINHOOD_API_BASE;
    this.timeoutMs = opts.timeoutMs ?? FETCH_TIMEOUT_MS;
  }

  /** GET with timeout, rate limit and error classification. */
  private async getJson(path: string): Promise<unknown> {
    await this.limiter.take();
    const url = `${this.base}/${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(url, { signal: controller.signal, cache: 'no-store' });
    } catch (err) {
      throw controller.signal.aborted
        ? new RobinhoodPriceApiError(`${url}: timeout after ${this.timeoutMs}ms`, 'TIMEOUT', err)
        : new RobinhoodPriceApiError(`Failed to reach ${url}`, 'NETWORK', err);
    } finally {
      clearTimeout(timeout);
    }
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after'));
      this.limiter.pause(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 60_000) : RATE_LIMIT_BACKOFF_MS);
      throw new RobinhoodPriceApiError(`${url}: rate limited (429)`, 'RATE_LIMITED');
    }
    if (res.status === 404) throw new RobinhoodPriceApiError(`${url}: not found`, 'NO_QUOTE');
    if (!res.ok) throw new RobinhoodPriceApiError(`${url} responded ${res.status}`, 'HTTP');
    try {
      return await res.json();
    } catch (err) {
      throw new RobinhoodPriceApiError(`${url}: response was not valid JSON`, 'SHAPE', err);
    }
  }

  private async loadRegistry(): Promise<void> {
    if (this.registry && this.now() - this.registry.at < ROBINHOOD_ASSETS_CACHE_MS) return;
    if (!this.registryInFlight) {
      this.registryInFlight = (async () => {
        await this.limiter.take();
        let assets: RobinhoodAsset[];
        try {
          assets = await fetchRobinhoodAssets(this.fetchImpl, `${this.base}/assets`);
        } catch (err) {
          // Keep serving the last good registry; retry in 60 s. None yet: fail loudly.
          if (this.registry) {
            this.registry = { ...this.registry, at: this.now() - ROBINHOOD_ASSETS_CACHE_MS + REGISTRY_RETRY_MS };
            return;
          }
          throw err;
        }
        const byAddress = new Map<string, RobinhoodStockToken>();
        const bySymbol = new Map<string, RobinhoodStockToken>();
        for (const a of assets) {
          const t = toStockToken(a);
          if (!t) continue;
          byAddress.set(t.address, t);
          bySymbol.set(t.symbol.toUpperCase(), t);
        }
        this.registry = { at: this.now(), byAddress, bySymbol };
      })().finally(() => {
        this.registryInFlight = null;
      });
    }
    await this.registryInFlight;
  }

  /** The canonical Stock Token at this Robinhood Chain address, or null if the registry does not list it (whatever its ticker says). */
  async tokenByAddress(address: string): Promise<RobinhoodStockToken | null> {
    await this.loadRegistry();
    return this.registry!.byAddress.get(address.toLowerCase()) ?? null;
  }

  async tokenBySymbol(symbol: string): Promise<RobinhoodStockToken | null> {
    await this.loadRegistry();
    return this.registry!.bySymbol.get(symbol.toUpperCase()) ?? null;
  }

  async allTokens(): Promise<RobinhoodStockToken[]> {
    await this.loadRegistry();
    return Array.from(this.registry!.byAddress.values());
  }

  async rawPrice(symbol: string): Promise<RobinhoodRawPrice> {
    const key = symbol.toUpperCase();
    const hit = this.prices.get(key);
    if (hit && this.now() - hit.at < ROBINHOOD_PRICES_CACHE_MS) return hit.value;
    const entry = { at: this.now(), value: this.getJson(`prices/${encodeURIComponent(key)}`).then((b) => parseRobinhoodPrice(b, key)) };
    this.prices.set(key, entry);
    entry.value.catch(() => {
      if (this.prices.get(key) === entry) this.prices.delete(key); // never cache a failure
    });
    return entry.value;
  }

  /** Per-token quote for a registry token: raw bid/ask × currentMultiplier. Rejects a quote that names a different contract. */
  async quote(token: RobinhoodStockToken): Promise<RobinhoodStockQuote> {
    const raw = await this.rawPrice(token.symbol);
    if (raw.contractAddress && raw.contractAddress !== token.address) {
      throw new RobinhoodPriceApiError(`/prices/${token.symbol} names ${raw.contractAddress}, registry says ${token.address}`, 'IDENTITY');
    }
    return buildQuote(token, raw);
  }

  /** Processed corporate actions (most recent first), cached for 1 h. */
  async corporateActions(): Promise<RobinhoodCorporateAction[]> {
    if (this.actions && this.now() - this.actions.at < ROBINHOOD_CORPORATE_ACTIONS_CACHE_MS) return this.actions.value;
    const entry = { at: this.now(), value: this.getJson('corporate-actions').then(parseCorporateActions) };
    this.actions = entry;
    entry.value.catch(() => {
      if (this.actions === entry) this.actions = null;
    });
    return entry.value;
  }
}

export function buildQuote(token: RobinhoodStockToken, raw: RobinhoodRawPrice): RobinhoodStockQuote {
  const m = parseUnsignedDecimal(token.currentMultiplier)!;
  const bid = mulScaled(raw.bid, m);
  const ask = mulScaled(raw.ask, m);
  const spread = raw.bid > BigInt(0) && raw.ask >= raw.bid ? Number(deviationBps(raw.bid, raw.ask)) : Number.POSITIVE_INFINITY;
  return {
    token,
    bid: toDecimalString(bid),
    ask: toDecimalString(ask),
    mid: toDecimalString(midScaled(bid, ask)),
    rawBid: toDecimalString(raw.bid),
    rawAsk: toDecimalString(raw.ask),
    currency: raw.currency,
    spreadBps: spread,
    dailyTradingVolume: raw.dailyTradingVolume,
    isTradingHalt: raw.isTradingHalt,
    generatedAt: raw.generatedAt,
  };
}

// ----------------------------- corporate-action reconciliation ---------------

export interface CorporateActionReconciliation {
  /** Actions for registry Stock Tokens, matched by contract (or symbol when the action lists no contract). */
  matched: { token: RobinhoodStockToken; action: RobinhoodCorporateAction }[];
  /** Actions naming a chain-4663 contract that is not the registry's token for that symbol — never applied. */
  identityMismatch: RobinhoodCorporateAction[];
  /** Registry tokens with a queued multiplier change. */
  pendingMultiplierChanges: { token: RobinhoodStockToken; pendingMultiplier: string; effectiveTime: string | null }[];
  /** Local multipliers (e.g. the `assets` table) that differ from the registry's currentMultiplier. */
  multiplierDrift: { address: string; local: string; registry: string }[];
}

/**
 * Cross-checks corporate actions, the registry and (optionally) locally stored
 * multipliers. Pure. The multiplier itself is always taken from /assets
 * (currentMultiplier), never recomputed from action history: the API does not
 * expose enough (e.g. no total cash amounts) to rebuild it.
 */
export function reconcileCorporateActions(
  actions: RobinhoodCorporateAction[],
  tokens: RobinhoodStockToken[],
  localMultipliers: Record<string, string | undefined> = {}
): CorporateActionReconciliation {
  const byAddress = new Map(tokens.map((t) => [t.address, t]));
  const bySymbol = new Map(tokens.map((t) => [t.symbol.toUpperCase(), t]));
  const matched: CorporateActionReconciliation['matched'] = [];
  const identityMismatch: RobinhoodCorporateAction[] = [];
  for (const action of actions) {
    const token = action.contractAddress ? byAddress.get(action.contractAddress) : bySymbol.get(action.tokenSymbol.toUpperCase());
    if (token && token.symbol.toUpperCase() === action.tokenSymbol.toUpperCase()) matched.push({ token, action });
    else if (action.contractAddress) identityMismatch.push(action);
  }
  const pendingMultiplierChanges = tokens
    .filter((t) => t.pendingMultiplier !== null)
    .map((t) => ({ token: t, pendingMultiplier: t.pendingMultiplier!, effectiveTime: t.pendingMultiplierEffectiveTime }));
  const multiplierDrift: CorporateActionReconciliation['multiplierDrift'] = [];
  for (const [address, local] of Object.entries(localMultipliers)) {
    const t = byAddress.get(address.toLowerCase());
    if (!t || local === undefined) continue;
    const a = parseUnsignedDecimal(local);
    const b = parseUnsignedDecimal(t.currentMultiplier);
    if (a === null || b === null || a !== b) multiplierDrift.push({ address: t.address, local, registry: t.currentMultiplier });
  }
  return { matched, identityMismatch, pendingMultiplierChanges, multiplierDrift };
}

// ----------------------------- PriceProvider ---------------------------------

export interface RobinhoodApiPriceProviderConfig {
  api: RobinhoodStockApi;
  maxAgeMs?: number;
  maxSpreadBps?: number;
  now?: () => Date;
}

/**
 * NAV-grade Stock Token price from /rhj/prices: per-token MID
 * (bid+ask)/2 × currentMultiplier. Fails closed (PriceUnavailableError) when
 * the address is not in the registry, trading is halted, the quote is older
 * than `maxAgeMs`, bid/ask is zero or crossed, the spread exceeds
 * `maxSpreadBps`, the quote names another contract, or the API is
 * unreachable / rate limited / returns an unexpected shape.
 */
export class RobinhoodApiPriceProvider implements PriceProvider {
  private readonly maxAgeMs: number;
  private readonly maxSpreadBps: number;
  constructor(private readonly config: RobinhoodApiPriceProviderConfig) {
    this.maxAgeMs = config.maxAgeMs ?? DEFAULT_MAX_PRICE_AGE_MS;
    this.maxSpreadBps = config.maxSpreadBps ?? DEFAULT_MAX_SPREAD_BPS;
  }

  async getPrice(asset: AssetIdentity): Promise<AssetPrice> {
    if (asset.chain !== 'robinhood') throw new PriceUnavailableError(asset);
    let q: RobinhoodStockQuote;
    try {
      const token = await this.config.api.tokenByAddress(asset.address);
      if (!token) throw new PriceUnavailableError(asset);
      q = await this.config.api.quote(token);
    } catch (err) {
      if (err instanceof PriceUnavailableError) throw err;
      throw new PriceUnavailableError(asset);
    }
    const now = this.config.now ? this.config.now() : new Date();
    if (q.isTradingHalt) throw new PriceUnavailableError(asset);
    if (now.getTime() - Date.parse(q.generatedAt) > this.maxAgeMs) throw new PriceUnavailableError(asset);
    if (!(q.spreadBps <= this.maxSpreadBps)) throw new PriceUnavailableError(asset); // also rejects zero/crossed (Infinity)
    return {
      asset,
      price: q.mid,
      quoteCurrency: 'USD',
      timestamp: q.generatedAt,
      source: `robinhood-api:prices:${q.token.symbol}:mid×${q.token.currentMultiplier}`,
    };
  }
}
