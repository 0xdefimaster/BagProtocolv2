import type { AssetPrice } from '@/types/basket-protocol';
import { FEE_REDEEM_MAX_PRICE_DEVIATION_BPS } from './redeem-quote-quality';

// -----------------------------------------------------------------------------
// How much a fee-paying sale leg may trust its reference price.
//
// redeem-quote-quality.ts refuses a leg quoted more than `maxDeviationBps` below
// quantity × reference price. That check is only as good as the reference. The
// price router (pricing/bag-price-router.ts) says how good it is:
//
//   confidence 1    Robinhood API price verified against a Chainlink feed
//                   within ROBINHOOD_PRICE_MAX_DEVIATION_BPS (default 200).
//   confidence 0.5  a Chainlink feed is configured for the asset but could not
//                   be read: the API price stands UNVERIFIED
//                   (source `…|verify:chainlink-unavailable`).
//   no confidence   no feed configured (stock token) or a crypto price
//                   (LI.FI / TWAP fallback): nothing cross-checked it.
//   throws          sources disagree beyond the router's limit
//                   (PriceSourceDisagreementError) or a source is stale/down.
//
// Before this module the sale paths read only `.price`, so an unverified
// reference got the same 5% band as a verified one. The tiers now are:
//
//   VERIFIED            confidence ≥ 1        → FEE_REDEEM_MAX_PRICE_DEVIATION_BPS (500)
//   REDUCED_CONFIDENCE  0.5 ≤ confidence < 1  → reducedConfidenceMaxDeviationBps (default 100)
//   refused             confidence < 0.5, missing, not a finite number in [0, 1],
//                       timestamp missing/unparseable/in the future, or older
//                       than maxPriceAgeMs.
//
// Refusal = no plan in phase 1, so nothing for phase 2 to sign.
//
// Why 100 bps (provisional, see docs/release-notes/settlement-price-confidence.md):
// a Uniswap v3 sale already pays the pool fee (0.05–1%) plus price impact, so a
// 1% band refuses most sales of thin stock-token pools while Chainlink is
// unreadable — an availability cost accepted for a reference nobody checked.
// It does NOT verify the reference: a reference that is itself too low would
// still let a correspondingly low quote through. Only a working feed fixes that.
// -----------------------------------------------------------------------------

export const DEFAULT_REDUCED_CONFIDENCE_MAX_DEVIATION_BPS = 100;
/** The confidence the router assigns an API price it could not verify. Anything lower is refused. */
export const MIN_SALE_PRICE_CONFIDENCE = 0.5;
/** Same 5-minute bound the stock API provider and NAV math use (pricing/staleness.ts). */
export const DEFAULT_SALE_PRICE_MAX_AGE_MS = 5 * 60 * 1000;
/** A timestamp this far ahead of the server clock is treated as invalid, not fresh. */
export const SALE_PRICE_MAX_FUTURE_SKEW_MS = 30 * 1000;

export interface SalePricePolicy {
  /** Band for a verified reference (confidence ≥ 1). */
  normalMaxDeviationBps: number;
  /** Band for an unverified-but-usable reference (0.5 ≤ confidence < 1). Must be ≤ the normal band. */
  reducedConfidenceMaxDeviationBps: number;
  /** A reference older than this is refused. */
  maxPriceAgeMs: number;
}

export const DEFAULT_SALE_PRICE_POLICY: SalePricePolicy = Object.freeze({
  normalMaxDeviationBps: FEE_REDEEM_MAX_PRICE_DEVIATION_BPS,
  reducedConfidenceMaxDeviationBps: DEFAULT_REDUCED_CONFIDENCE_MAX_DEVIATION_BPS,
  maxPriceAgeMs: DEFAULT_SALE_PRICE_MAX_AGE_MS,
});

export type SalePriceRefusal = 'CONFIDENCE_MISSING' | 'CONFIDENCE_INVALID' | 'CONFIDENCE_TOO_LOW' | 'TIMESTAMP_INVALID' | 'PRICE_STALE';

export type SalePriceDecision =
  | { ok: true; tier: 'VERIFIED' | 'REDUCED_CONFIDENCE'; maxDeviationBps: number }
  | { ok: false; reason: SalePriceRefusal };

export class SalePricePolicyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SalePricePolicyConfigError';
  }
}

function assertPolicy(p: SalePricePolicy): SalePricePolicy {
  for (const [k, v] of Object.entries(p)) {
    if (!Number.isInteger(v) || v < 0) throw new SalePricePolicyConfigError(`${k} must be a non-negative integer (got ${v}).`);
  }
  if (p.normalMaxDeviationBps > 10_000) throw new SalePricePolicyConfigError('normalMaxDeviationBps must be ≤ 10000.');
  if (p.reducedConfidenceMaxDeviationBps > p.normalMaxDeviationBps) {
    throw new SalePricePolicyConfigError(
      `reducedConfidenceMaxDeviationBps (${p.reducedConfidenceMaxDeviationBps}) must not exceed the verified band (${p.normalMaxDeviationBps}).`
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
 *   FEE_SALE_REDUCED_CONFIDENCE_MAX_DEVIATION_BPS  0..500, default 100
 *   FEE_SALE_PRICE_MAX_AGE_SECONDS                 > 0,    default 300
 */
export function salePricePolicyFromEnv(env: Record<string, string | undefined> = process.env): SalePricePolicy {
  const reduced = envInt(env, 'FEE_SALE_REDUCED_CONFIDENCE_MAX_DEVIATION_BPS');
  const ageSeconds = envInt(env, 'FEE_SALE_PRICE_MAX_AGE_SECONDS');
  return assertPolicy({
    normalMaxDeviationBps: DEFAULT_SALE_PRICE_POLICY.normalMaxDeviationBps,
    reducedConfidenceMaxDeviationBps: reduced ?? DEFAULT_SALE_PRICE_POLICY.reducedConfidenceMaxDeviationBps,
    maxPriceAgeMs: ageSeconds === undefined ? DEFAULT_SALE_PRICE_POLICY.maxPriceAgeMs : ageSeconds * 1000,
  });
}

/** Which band a fee-paying sale leg may use with this reference price, or why it may not be used at all. Pure. */
export function salePriceDeviationLimit(
  price: Pick<AssetPrice, 'confidence' | 'timestamp'>,
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
  if (typeof c !== 'number' || !Number.isFinite(c) || c < 0 || c > 1) return { ok: false, reason: 'CONFIDENCE_INVALID' };
  if (c >= 1) return { ok: true, tier: 'VERIFIED', maxDeviationBps: policy.normalMaxDeviationBps };
  if (c >= MIN_SALE_PRICE_CONFIDENCE) return { ok: true, tier: 'REDUCED_CONFIDENCE', maxDeviationBps: policy.reducedConfidenceMaxDeviationBps };
  return { ok: false, reason: 'CONFIDENCE_TOO_LOW' };
}
