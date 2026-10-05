import { parseDec, DEC_SCALE } from '../accounting/decimal';
import type { PositionPnl } from '../accounting/position-pnl';

// -----------------------------------------------------------------------------
// B0 — the interim, conservative, floor-based performance fee
// (docs/FEE_ECONOMICS_DESIGN.md §3, decisions F1–F5). Pure.
//
//   fee = floor( max(0, grossMinimumProceeds − consumedBasis − lossCarry) × rateBps / 10000 )
//
// in the settlement token's raw units (USDG, 6 decimals; §5.7). The fee is
// computed on the least the swaps may return (RedeemFeeRouter reverts below
// it), so for every actual output ≥ grossMinimumProceeds the charged fee is ≤
// rate × max(0, actual − basis − carry): never charged on gain not realized.
// Every conversion and rounding step goes in the user's favour: basis and loss
// carry are rounded UP into raw units (a smaller fee base), the fee DOWN.
//
// The basis is the A3 average cost of exactly the quantities sold (F2), the
// sale is netted as a whole (F3), and losses carry forward against the
// position's realized high-water mark (F4). Unknown inputs are never guessed:
// the caller gets a reason and refuses to attest.
// -----------------------------------------------------------------------------

export interface SoldQuantity {
  chain: string;
  address: string;
  quantityRaw: string;
}

export type B0FeeBasisResult =
  | { ok: true; consumedBasisQuote: bigint; lossCarryQuote: bigint }
  | { ok: false; reason: 'BASIS_UNKNOWN' | 'SOLD_EXCEEDS_BOOKS' | 'REALIZED_PNL_UNKNOWN' };

const ZERO = BigInt(0);
const key = (chain: string, address: string) => `${chain}:${address.toLowerCase()}`;

/**
 * Consumed basis of `sold` at the position's A3 average cost (the same rule the ledger applies when the sale
 * settles: basis × sold / held, per asset), and the loss carried forward (high-water mark − cumulative realized).
 * Amounts are accounting decimals (18 places) as bigint.
 */
export function feeBasisFromPositionPnl(pnl: PositionPnl, sold: SoldQuantity[]): B0FeeBasisResult {
  if (pnl.realizedPnlQuote === null || pnl.realizedHighWaterMarkQuote === null) return { ok: false, reason: 'REALIZED_PNL_UNKNOWN' };
  const held = new Map(pnl.assets.map((a) => [key(a.chain, a.address), a]));
  let basis = ZERO;
  for (const s of sold) {
    const qty = BigInt(s.quantityRaw);
    if (qty <= ZERO) continue;
    const a = held.get(key(s.chain, s.address));
    if (!a || BigInt(a.quantityRaw) < qty) return { ok: false, reason: 'SOLD_EXCEEDS_BOOKS' };
    if (a.costBasisQuote === null) return { ok: false, reason: 'BASIS_UNKNOWN' };
    // Same integer rule as position-pnl.ts `remove()` (mulDiv: truncates toward zero).
    basis += (parseDec(a.costBasisQuote) * qty) / BigInt(a.quantityRaw);
  }
  const carry = parseDec(pnl.realizedHighWaterMarkQuote) - parseDec(pnl.realizedPnlQuote);
  return { ok: true, consumedBasisQuote: basis, lossCarryQuote: carry > ZERO ? carry : ZERO };
}

/** Accounting decimal (18 places, bigint) → token raw units, rounded UP (never below the decimal value). */
export function decimalToRawCeil(v: bigint, tokenDecimals: number): bigint {
  if (v <= ZERO) return ZERO;
  if (tokenDecimals > DEC_SCALE) throw new Error('decimalToRawCeil: token has more decimals than the accounting scale');
  const unit = BigInt(10) ** BigInt(DEC_SCALE - tokenDecimals);
  return (v + unit - BigInt(1)) / unit;
}

export interface B0FeeInput {
  /** Σ per-leg minimum outputs, token raw (the floor RedeemFeeRouter enforces). */
  grossMinimumProceedsRaw: bigint;
  consumedBasisRaw: bigint;
  lossCarryRaw: bigint;
  /** The Bag's locked performance fee rate. */
  rateBps: number;
  /** The creator selling their own Bag pays no fee. */
  creatorIsRedeemer: boolean;
}

export interface B0Fee {
  feeBaseRaw: bigint;
  feeRaw: bigint;
  /** grossMinimumProceeds − fee: the user's own floor, signed in the attestation. */
  minUserProceedsRaw: bigint;
}

export function computeB0Fee(input: B0FeeInput): B0Fee {
  const { grossMinimumProceedsRaw: gross, consumedBasisRaw, lossCarryRaw, rateBps } = input;
  if (gross < ZERO || consumedBasisRaw < ZERO || lossCarryRaw < ZERO) throw new Error('computeB0Fee: negative input');
  if (!Number.isInteger(rateBps) || rateBps < 0 || rateBps > 10000) throw new Error('computeB0Fee: rate out of range');
  const gainAboveCarry = gross - consumedBasisRaw - lossCarryRaw;
  const feeBaseRaw = input.creatorIsRedeemer || rateBps === 0 || gainAboveCarry <= ZERO ? ZERO : gainAboveCarry;
  const feeRaw = (feeBaseRaw * BigInt(rateBps)) / BigInt(10000);
  return { feeBaseRaw, feeRaw, minUserProceedsRaw: gross - feeRaw };
}
