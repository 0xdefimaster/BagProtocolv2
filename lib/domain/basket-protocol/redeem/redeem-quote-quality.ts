import { parseDec, DEC_SCALE } from '../accounting/decimal';

// -----------------------------------------------------------------------------
// Price quality of a fee-paying sale leg (RedeemFeeRouter, direct Uniswap v3).
// Pure; shared by signFeeAttestation and the read-only liquidity checker so the
// checker reports exactly what the attestation will do.
//
// A minimum output protects against the price moving AFTER the quote; it does
// not say the quote was a fair price. The live check on 2026-10-05 found tokens
// whose only quoting pool was a near-empty 1% pool ($25 of stock → $0.18): a
// minimum of 99% of that quote would have let the sale "succeed" at a ~99% loss.
//
// So a leg is priced in two steps:
//   1. quote EVERY fee tier and take the best (highest output) — never "the first
//      that answers";
//   2. compare it with the reference value — quantity × BAG's verified price
//      (the same price provider the NAV uses) — and refuse it if it is more than
//      `maxDeviationBps` below. No reference price → no attestation.
// -----------------------------------------------------------------------------

/**
 * How far below the verified value a fee-paying sale leg may execute. The same protocol default as the strategy
 * policy's `maxPriceImpactBps` (5%); not yet a per-strategy parameter.
 */
export const FEE_REDEEM_MAX_PRICE_DEVIATION_BPS = 500;

export interface TierQuote {
  feeTier: number;
  amountOut: bigint;
}

export type LegQuoteSelection =
  | { ok: true; feeTier: number; quoteRaw: bigint; referenceRaw: bigint; deviationBps: number }
  | { ok: false; reason: 'NO_QUOTE' }
  | { ok: false; reason: 'PRICE_DEVIATION'; feeTier: number; quoteRaw: bigint; referenceRaw: bigint; deviationBps: number };

/** Value of `amountRaw` of a token at `priceUsd`, in the output token's raw units (USDG ≈ USD), rounded down. */
export function referenceValueRaw(amountRaw: bigint, tokenDecimals: number, priceUsd: string, outputDecimals: number): bigint {
  const price = parseDec(priceUsd); // 18-place fixed point
  if (price <= BigInt(0)) throw new Error('referenceValueRaw: non-positive price');
  // amount / 10^tokenDecimals × price / 10^18 × 10^outputDecimals
  return (amountRaw * price * BigInt(10) ** BigInt(outputDecimals)) / (BigInt(10) ** BigInt(tokenDecimals) * BigInt(10) ** BigInt(DEC_SCALE));
}

/** Token amount worth `valueUsd` at `priceUsd` (for sizing a representative sale), rounded down. */
export function tokenAmountForValue(valueUsd: number, tokenDecimals: number, priceUsd: string): bigint {
  const price = parseDec(priceUsd);
  if (price <= BigInt(0)) throw new Error('tokenAmountForValue: non-positive price');
  const value = parseDec(valueUsd.toFixed(6));
  return (value * BigInt(10) ** BigInt(tokenDecimals)) / price;
}

/** Best tier, then the reference check. `deviationBps` = how far the quote is below the reference (0 when above). */
export function selectRedeemLegQuote(quotes: TierQuote[], referenceRaw: bigint, maxDeviationBps: number): LegQuoteSelection {
  const usable = quotes.filter((q) => q.amountOut > BigInt(0));
  if (usable.length === 0) return { ok: false, reason: 'NO_QUOTE' };
  if (referenceRaw <= BigInt(0)) throw new Error('selectRedeemLegQuote: reference value must be positive');
  const best = usable.reduce((a, b) => (b.amountOut > a.amountOut ? b : a));
  const deviationBps = best.amountOut >= referenceRaw ? 0 : Number(((referenceRaw - best.amountOut) * BigInt(10000)) / referenceRaw);
  const picked = { feeTier: best.feeTier, quoteRaw: best.amountOut, referenceRaw, deviationBps };
  return deviationBps <= maxDeviationBps ? { ok: true, ...picked } : { ok: false, reason: 'PRICE_DEVIATION', ...picked };
}
