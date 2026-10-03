// -----------------------------------------------------------------------------
// Pure, TypeScript-side mirror of apply_redeem_execution()'s (supabase/
// migrations/0013_add_creator_rewards.sql) performance-fee arithmetic —
// needed by the EIP-712 fee-attestation endpoint (lib/server/
// redeem-fee-attestation.ts), which must sign the EXACT fee amount the
// on-chain settlement will later be credited for, WITHOUT calling that SQL
// function first (attestation happens BEFORE the router transaction, the
// SQL function's accounting happens for the legacy path independently).
//
// Every intermediate value is computed in integer CENTS (bigint), never a
// JS `number` — same "no floats for money" rule this codebase enforces
// everywhere else (see lib/config/robinhood-chain.ts's own module doc).
// `roundHalfAwayFromZeroCents()` below exists ONLY because Postgres
// `numeric`'s `round(x, 2)` — what the SQL function actually uses — is
// round-HALF-AWAY-FROM-ZERO, not round-half-to-even/banker's-rounding
// (JS has neither built in for arbitrary decimal strings): getting this
// wrong would mean the attestation's signed fee amount could differ from
// what `apply_redeem_execution()` computes for the exact same redemption,
// which is precisely the "two independent calculations of the same
// royalty/fee" the production brief prohibits.
// -----------------------------------------------------------------------------

const DECIMAL_STRING_RE = /^-?\d+(\.\d+)?$/;

/** Parses a decimal string into integer CENTS (bigint) — e.g. "12.345" -> 1235n (rounds at the 3rd decimal place using the SAME half-away-from-zero rule, since a quote-currency amount should never carry more than 2 decimals of real precision, but a caller passing one extra digit of float noise must not silently truncate it away asymmetrically). */
function decimalToCents(value: string): bigint {
  const trimmed = value.trim();
  if (!DECIMAL_STRING_RE.test(trimmed)) {
    throw new Error(`performance-fee-preview: not a valid decimal amount: ${JSON.stringify(value)}`);
  }
  const negative = trimmed.startsWith('-');
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [wholePart, fracPartRaw = ''] = unsigned.split('.');
  // Round (not truncate) any precision beyond 2dp into the cents value —
  // e.g. an upstream "0.005" rounds to 1 cent, matching Postgres numeric
  // round-half-away-from-zero at 2dp.
  const fracPadded = (fracPartRaw + '000').slice(0, 3); // 3 digits: 2 kept + 1 for rounding
  const centsUnrounded = BigInt(wholePart + fracPadded.slice(0, 2));
  const thirdDigit = BigInt(fracPadded.slice(2, 3) || '0');
  const cents = thirdDigit >= BigInt(5) ? centsUnrounded + BigInt(1) : centsUnrounded;
  return negative ? -cents : cents;
}

function centsToDecimalString(cents: bigint): string {
  const negative = cents < BigInt(0);
  const abs = negative ? -cents : cents;
  const s = abs.toString().padStart(3, '0');
  const whole = s.slice(0, s.length - 2);
  const frac = s.slice(s.length - 2);
  return `${negative ? '-' : ''}${whole}.${frac}`;
}

/**
 * `round(cents * bps / 10000, 0)`, i.e. round-half-away-from-zero — the
 * exact semantics of Postgres `round(numeric, 2)` applied to an amount
 * already expressed in cents (so rounding to the nearest CENT here is
 * rounding to 2dp of the original dollar amount).
 */
function roundHalfAwayFromZeroCents(centsTimesBpsNumerator: bigint, denominator: bigint): bigint {
  const negative = centsTimesBpsNumerator < BigInt(0);
  const absNumerator = negative ? -centsTimesBpsNumerator : centsTimesBpsNumerator;
  const doubled = absNumerator * BigInt(2);
  const quotient = doubled / denominator;
  // Half-away-from-zero: bump up if the remainder-doubled is >= denominator
  // (equivalent to "the fractional part is >= 0.5").
  const flooredHalf = quotient / BigInt(2);
  const roundUp = quotient % BigInt(2) === BigInt(1);
  const result = roundUp ? flooredHalf + BigInt(1) : flooredHalf;
  return negative ? -result : result;
}

export interface PerformanceFeePreviewInput {
  /** `bag_investor_positions.cost_basis_quote` for THIS depositor, BEFORE this redemption. */
  positionCostBasisQuote: string;
  /** `bag_investor_positions.shares_raw` for THIS depositor, BEFORE this redemption. */
  positionSharesRaw: string;
  /** Shares being redeemed by this specific intent — always `<= positionSharesRaw`. */
  sharesBurnRaw: string;
  /** `RedeemQuote.grossValue` — this redemption's quoted value, human-decimal quote-currency string. */
  redeemValueQuote: string;
  performanceFeeBps: number;
  /** True if the creator IS the redeeming user — no fee, ever (matches `p_creator_id <> p_user_id` in the SQL). */
  creatorIsRedeemer: boolean;
}

export interface PerformanceFeePreviewResult {
  /** Always `>= "0.00"` — a loss never produces a negative fee (matches `v_profit > 0` gating in the SQL). */
  feeAmountQuote: string;
  /** For audit/display — can be negative (a loss). */
  profitQuote: string;
}

/**
 * Bit-for-bit mirror of the profit/fee arithmetic inside
 * `apply_redeem_execution()` (see that function's own comments in
 * supabase/migrations/0013_add_creator_rewards.sql for the derivation of
 * `consumedCostBasis`). Never throws on a loss — returns `feeAmountQuote:
 * "0.00"` instead, same as the SQL function's `if v_profit > 0` guard.
 */
export function previewPerformanceFee(input: PerformanceFeePreviewInput): PerformanceFeePreviewResult {
  if (input.creatorIsRedeemer || input.performanceFeeBps <= 0) {
    return { feeAmountQuote: '0.00', profitQuote: '0.00' };
  }

  const positionSharesRaw = BigInt(input.positionSharesRaw);
  const sharesBurnRaw = BigInt(input.sharesBurnRaw);
  if (positionSharesRaw === BigInt(0)) {
    throw new Error('previewPerformanceFee: positionSharesRaw is zero — no position to redeem from.');
  }
  if (sharesBurnRaw > positionSharesRaw) {
    throw new Error('previewPerformanceFee: sharesBurnRaw exceeds positionSharesRaw.');
  }

  const costBasisCents = decimalToCents(input.positionCostBasisQuote);
  const redeemValueCents = decimalToCents(input.redeemValueQuote);

  // consumedCostBasis = costBasis * sharesBurn / positionShares — same
  // proportional-consumption formula apply_redeem_execution() uses
  // (derived there from newCostBasis = costBasis * newShares/oldShares).
  // Rounded half-away-from-zero at the cents boundary, same as every
  // other money value in this pipeline.
  const consumedCostBasisCents = roundHalfAwayFromZeroCents(costBasisCents * sharesBurnRaw, positionSharesRaw);

  const profitCents = redeemValueCents - consumedCostBasisCents;

  if (profitCents <= BigInt(0)) {
    return { feeAmountQuote: '0.00', profitQuote: centsToDecimalString(profitCents) };
  }

  const feeCents = roundHalfAwayFromZeroCents(profitCents * BigInt(input.performanceFeeBps), BigInt(10000));

  return {
    feeAmountQuote: centsToDecimalString(feeCents),
    profitQuote: centsToDecimalString(profitCents),
  };
}
