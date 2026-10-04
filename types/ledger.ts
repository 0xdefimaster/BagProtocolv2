// -----------------------------------------------------------------------------
// Accounting V2 ledger (supabase/migrations/0048_ledger_events.sql,
// docs/ACCOUNTING_V2_DESIGN.md). One immutable event per change to an
// investor's tracked exposure; amounts are decimal strings, never floats.
// -----------------------------------------------------------------------------

export const LEDGER_EVENT_KINDS = [
  'OPENING_BALANCE',
  'PURCHASE_FILL',
  'REDEEM_FILL',
  'FEE_CHARGED',
  'ROYALTY_ACCRUED',
  'EXTERNAL_OUTFLOW',
  'OUTFLOW_CLASSIFIED',
  'RECONCILIATION_NOTE',
] as const;
export type LedgerEventKind = (typeof LEDGER_EVENT_KINDS)[number];

export interface LedgerLeg {
  chain: string;
  address: string;
  decimals: number | null;
  /** Signed raw quantity change. */
  deltaRaw: string;
}

export interface LedgerEvent {
  /** Total order of the ledger. */
  seq: string;
  bagId: string;
  kind: LedgerEventKind;
  legs: LedgerLeg[];
  /** sharesDeltaRaw, costBasisDeltaQuote, amountQuote, … as decimal strings (kind-specific). */
  quote: Record<string, unknown>;
  /** {intentKind, intentId} | {chain, txHash} | {migration}. */
  source: Record<string, unknown>;
  strategyVersion: number | null;
  createdAt: string;
}

export interface LedgerPage {
  events: LedgerEvent[];
  /** Pass as `before` to read the next (older) page; null on the last page. */
  nextBefore: string | null;
}
