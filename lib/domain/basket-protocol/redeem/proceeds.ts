// -----------------------------------------------------------------------------
// Accounting V2 / A4 — what a sale is expected to return vs what it did.
//
// "Estimated proceeds" come from the route quote (after price impact and
// fees) and are shown before signing; they are never booked. Realized
// proceeds come only from verified receipts (each completed leg's received
// output), and only those enter realized P&L (accounting/position-pnl.ts).
// -----------------------------------------------------------------------------

export interface ProceedsLeg {
  action: 'SWAP' | 'KEEP';
  status: string;
  inputAmountRaw: string;
  /** Quoted estimate before execution; the verified received amount after it. */
  outputAmountRaw: string | null;
  minOutputRaw?: string | null;
  /** One-transaction (Composer) legs carry the on-chain enforced minimum here instead of `minOutputRaw`. */
  providerEnforcedMinOutputRaw?: string | null;
}

const RAW_RE = /^\d+$/;

/**
 * Σ quoted output of every SWAP leg + the KEEP legs (already the output asset), in the output asset's raw
 * units. Null when any SWAP leg has no quoted output: an estimate with a hole in it is not an estimate.
 */
export function estimatedProceedsRaw(legs: ProceedsLeg[]): string | null {
  let total = BigInt(0);
  for (const l of legs) {
    const v = l.action === 'KEEP' ? l.inputAmountRaw : l.outputAmountRaw;
    if (v === null || !RAW_RE.test(v)) return null;
    total += BigInt(v);
  }
  return total.toString();
}

export type SaleOutcome = 'PENDING' | 'SOLD' | 'PARTIAL' | 'FAILED';

export interface SaleOutcomeSummary {
  outcome: SaleOutcome;
  soldLegs: number;
  failedLegs: number;
  pendingLegs: number;
}

/**
 * How a multi-asset sale ended, leg by leg. A sale is SOLD only when every SWAP leg verified; one failed leg
 * next to a completed one is PARTIAL (never reported as fully sold), and all legs failing is FAILED.
 */
export function summarizeSale(legs: ProceedsLeg[]): SaleOutcomeSummary {
  const swaps = legs.filter((l) => l.action === 'SWAP');
  const soldLegs = swaps.filter((l) => l.status === 'COMPLETED').length;
  const failedLegs = swaps.filter((l) => l.status === 'FAILED').length;
  const pendingLegs = swaps.length - soldLegs - failedLegs;
  const outcome: SaleOutcome =
    pendingLegs > 0 ? 'PENDING' : failedLegs === 0 ? 'SOLD' : soldLegs === 0 ? 'FAILED' : 'PARTIAL';
  return { outcome, soldLegs, failedLegs, pendingLegs };
}

/** Σ the route's guaranteed minimum per SWAP leg + the KEEP legs. Null when any SWAP leg has no minimum. */
export function minimumProceedsRaw(legs: ProceedsLeg[]): string | null {
  let total = BigInt(0);
  for (const l of legs) {
    const v = l.action === 'KEEP' ? l.inputAmountRaw : (l.minOutputRaw ?? l.providerEnforcedMinOutputRaw ?? null);
    if (v === null || !RAW_RE.test(v)) return null;
    total += BigInt(v);
  }
  return total.toString();
}
