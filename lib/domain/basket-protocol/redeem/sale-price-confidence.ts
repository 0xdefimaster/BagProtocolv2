import type { AssetPrice } from '@/types/basket-protocol';
import { FEE_REDEEM_MAX_PRICE_DEVIATION_BPS } from './redeem-quote-quality';
import {
  STOCK_PRICE_CHAINLINK_UNAVAILABLE_CONFIDENCE,
  STOCK_PRICE_CHAINLINK_VERIFIED_CONFIDENCE,
  stockPriceVerification,
} from '../pricing/bag-price-router';

// -----------------------------------------------------------------------------
// How much a fee-paying sale leg may trust its reference price.
//
// redeem-quote-quality.ts refuses a leg quoted more than `maxDeviationBps`
// below quantity × reference price. That check is only as good as the
// reference. The price router (pricing/bag-price-router.ts) leaves a Stock Token
// price in one of two DISCRETE, source-qualified states:
//
//   CHAINLINK_VERIFIED     confidence 1   + source `…|verify:chainlink:<feed>:<n>bps`
//   CHAINLINK_UNAVAILABLE  confidence 0.5 + source `…|verify:chainlink-unavailable`
//
// `confidence` is a label of that state, NOT a calibrated probability: the
// policy accepts exactly those two (confidence, source) pairs and nothing in
// between. Everything else is refused:
//
//   - no confidence (no feed configured, crypto / LI.FI / TWAP / CoinGecko price)
//   - confidence 1 without Chainlink evidence in the source
//   - confidence 0.5 with any other source
//   - any other confidence value (0.75, 0.99, …) or a non-number
//   - timestamp missing, unparseable, > 30 s in the future, or older than maxPriceAgeMs
//   - the router throwing (sources disagree, a source down or stale) — the caller's job
//
// Refusal = no plan in phase 1, so nothing for phase 2 to sign.
//
// Bands: VERIFIED → FEE_REDEEM_MAX_PRICE_DEVIATION_BPS (500). REDUCED → a
// stricter configurable band, default 100 (trade-offs:
// docs/release-notes/settlement-price-confidence.md). Up to 200 it is an
// ordinary setting; 201–499 only with an explicit break-glass flag; 500 or more
// never (it would erase the distinction between verified and unverified).
// -----------------------------------------------------------------------------

export const DEFAULT_REDUCED_CONFIDENCE_MAX_DEVIATION_BPS = 100;
/** Highest reduced band accepted without break-glass: the router's own default API-vs-Chainlink disagreement limit. */
export const REDUCED_CONFIDENCE_MAX_DEVIATION_BPS_LIMIT = 200;
/** Same 5-minute bound the stock API provider and NAV math use (pricing/staleness.ts). */
export const DEFAULT_SALE_PRICE_MAX_AGE_MS = 5 * 60 * 1000;
/** A timestamp this far ahead of the server clock is treated as invalid, not fresh. */
export const SALE_PRICE_MAX_FUTURE_SKEW_MS = 30 * 1000;

export interface SalePricePolicy {
  /** Band for a Chainlink-verified reference. */
  normalMaxDeviationBps: number;
  /** Band for a reference whose Chainlink feed was unavailable. Strictly below the normal band. */
  reducedConfidenceMaxDeviationBps: number;
  /** A reference older than this is refused. */
  maxPriceAgeMs: number;
  /** True only when an operator explicitly allowed a reduced band above REDUCED_CONFIDENCE_MAX_DEVIATION_BPS_LIMIT. */
  breakGlass: boolean;
}

export const DEFAULT_SALE_PRICE_POLICY: SalePricePolicy = Object.freeze({
  normalMaxDeviationBps: FEE_REDEEM_MAX_PRICE_DEVIATION_BPS,
  reducedConfidenceMaxDeviationBps: DEFAULT_REDUCED_CONFIDENCE_MAX_DEVIATION_BPS,
  maxPriceAgeMs: DEFAULT_SALE_PRICE_MAX_AGE_MS,
  breakGlass: false,
});

export type SalePriceRefusal =
  | 'CONFIDENCE_MISSING'
  | 'CONFIDENCE_INVALID'
  | 'CONFIDENCE_UNEXPECTED'
  | 'SOURCE_NOT_QUALIFIED'
  | 'TIMESTAMP_INVALID'
  | 'PRICE_STALE';

export type SalePriceDecision =
  | { ok: true; tier: 'VERIFIED' | 'REDUCED_CONFIDENCE'; maxDeviationBps: number; breakGlass: boolean }
  | { ok: false; reason: SalePriceRefusal };

export class SalePricePolicyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SalePricePolicyConfigError';
  }
}

function assertPolicy(p: SalePricePolicy): SalePricePolicy {
  for (const k of ['normalMaxDeviationBps', 'reducedConfidenceMaxDeviationBps', 'maxPriceAgeMs'] as const) {
    const v = p[k];
    if (!Number.isInteger(v) || v < 0) throw new SalePricePolicyConfigError(`${k} must be a non-negative integer (got ${v}).`);
  }
  if (p.normalMaxDeviationBps > 10_000) throw new SalePricePolicyConfigError('normalMaxDeviationBps must be ≤ 10000.');
  if (p.reducedConfidenceMaxDeviationBps >= p.normalMaxDeviationBps) {
    throw new SalePricePolicyConfigError(
      `reducedConfidenceMaxDeviationBps (${p.reducedConfidenceMaxDeviationBps}) must be below the verified band (${p.normalMaxDeviationBps}); ` +
        'an equal band would treat an unverified price as verified.'
    );
  }
  if (p.reducedConfidenceMaxDeviationBps > REDUCED_CONFIDENCE_MAX_DEVIATION_BPS_LIMIT && p.breakGlass !== true) {
    throw new SalePricePolicyConfigError(
      `reducedConfidenceMaxDeviationBps above ${REDUCED_CONFIDENCE_MAX_DEVIATION_BPS_LIMIT} requires FEE_SALE_REDUCED_CONFIDENCE_BREAK_GLASS=1.`
    );
  }
  if (p.maxPriceAgeMs === 0) throw new SalePricePolicyConfigError('maxPriceAgeMs must be positive.');
  return p;
}

function envInt(env: Record<string, string | undefined>, name: string): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new SalePricePolicyConfigError(`${name} must be a non-negative integer.`);
  return n;
}

/**
 * The policy from the environment. Unset → defaults. An invalid value throws (the sale is refused) rather than
 * falling back to a default — a typo must not silently widen the band.
 *   FEE_SALE_REDUCED_CONFIDENCE_MAX_DEVIATION_BPS  0..200 (default 100); 201..499 only with the break-glass flag
 *   FEE_SALE_REDUCED_CONFIDENCE_BREAK_GLASS        exactly "1" to allow 201..499; any other non-empty value is an error
 *   FEE_SALE_PRICE_MAX_AGE_SECONDS                 > 0, default 300
 */
export function salePricePolicyFromEnv(env: Record<string, string | undefined> = process.env): SalePricePolicy {
  const reduced = envInt(env, 'FEE_SALE_REDUCED_CONFIDENCE_MAX_DEVIATION_BPS');
  const ageSeconds = envInt(env, 'FEE_SALE_PRICE_MAX_AGE_SECONDS');
  const bg = env.FEE_SALE_REDUCED_CONFIDENCE_BREAK_GLASS?.trim();
  if (bg !== undefined && bg !== '' && bg !== '1') throw new SalePricePolicyConfigError('FEE_SALE_REDUCED_CONFIDENCE_BREAK_GLASS must be "1" or unset.');
  return assertPolicy({
    normalMaxDeviationBps: DEFAULT_SALE_PRICE_POLICY.normalMaxDeviationBps,
    reducedConfidenceMaxDeviationBps: reduced ?? DEFAULT_SALE_PRICE_POLICY.reducedConfidenceMaxDeviationBps,
    maxPriceAgeMs: ageSeconds === undefined ? DEFAULT_SALE_PRICE_POLICY.maxPriceAgeMs : ageSeconds * 1000,
    breakGlass: bg === '1',
  });
}

/** Which band a fee-paying sale leg may use with this reference price, or why it may not be used at all. Pure. */
export function salePriceDeviationLimit(
  price: Pick<AssetPrice, 'confidence' | 'timestamp' | 'source'>,
  policy: SalePricePolicy = DEFAULT_SALE_PRICE_POLICY,
  now: Date = new Date()
): SalePriceDecision {
  assertPolicy(policy);
  const ts = typeof price.timestamp === 'string' && price.timestamp !== '' ? Date.parse(price.timestamp) : NaN;
  if (!Number.isFinite(ts)) return { ok: false, reason: 'TIMESTAMP_INVALID' };
  const age = now.getTime() - ts;
  if (age < -SALE_PRICE_MAX_FUTURE_SKEW_MS) return { ok: false, reason: 'TIMESTAMP_INVALID' };
  if (age > policy.maxPriceAgeMs) return { ok: false, reason: 'PRICE_STALE' };

  const c = price.confidence;
  if (c === undefined || c === null) return { ok: false, reason: 'CONFIDENCE_MISSING' };
  if (typeof c !== 'number' || !Number.isFinite(c)) return { ok: false, reason: 'CONFIDENCE_INVALID' };
  const verification = stockPriceVerification(price.source);
  if (c === STOCK_PRICE_CHAINLINK_VERIFIED_CONFIDENCE) {
    return verification?.state === 'CHAINLINK_VERIFIED'
      ? { ok: true, tier: 'VERIFIED', maxDeviationBps: policy.normalMaxDeviationBps, breakGlass: false }
      : { ok: false, reason: 'SOURCE_NOT_QUALIFIED' };
  }
  if (c === STOCK_PRICE_CHAINLINK_UNAVAILABLE_CONFIDENCE) {
    return verification?.state === 'CHAINLINK_UNAVAILABLE'
      ? { ok: true, tier: 'REDUCED_CONFIDENCE', maxDeviationBps: policy.reducedConfidenceMaxDeviationBps, breakGlass: policy.breakGlass }
      : { ok: false, reason: 'SOURCE_NOT_QUALIFIED' };
  }
  return { ok: false, reason: 'CONFIDENCE_UNEXPECTED' };
}
