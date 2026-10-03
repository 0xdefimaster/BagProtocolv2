import { PurchaseIntentStatus, PurchaseIntentStepStatus, TERMINAL_PURCHASE_INTENT_STATUSES } from '@/types/purchase-intent';

// -----------------------------------------------------------------------------
// Phase 17 — spec Aşama 2: "Server'da status transition kontrollü olsun.
// Invalid transition engellensin." Pure, synchronous, no I/O — the single
// source of truth both `purchase-intent-repo.ts` (every write) and the API
// route handlers check against before persisting any status change.
//
// Deliberately a plain adjacency table, not "any forward status is fine" —
// e.g. DRAFT -> COMPLETED is structurally invalid even though DRAFT sorts
// "before" COMPLETED in the enum, exactly the kind of shortcut this file
// exists to rule out.
// -----------------------------------------------------------------------------

const ALLOWED_TRANSITIONS: Record<PurchaseIntentStatus, ReadonlySet<PurchaseIntentStatus>> = {
  DRAFT: new Set(['QUOTED', 'FAILED', 'CANCELLED', 'EXPIRED']),
  QUOTED: new Set(['READY', 'FAILED', 'CANCELLED', 'EXPIRED']),
  READY: new Set(['AWAITING_SIGNATURE', 'FAILED', 'CANCELLED', 'EXPIRED']),
  AWAITING_SIGNATURE: new Set(['SUBMITTED', 'FAILED', 'CANCELLED', 'EXPIRED']),
  SUBMITTED: new Set(['CONFIRMING', 'PARTIAL_SUCCESS', 'FAILED']),
  CONFIRMING: new Set(['COMPLETED', 'PARTIAL_SUCCESS', 'FAILED']),
  // Phase 18 — always advances to RECONCILIATION_REQUIRED, possibly across
  // more than one call if `reconcilePartialExecution()`'s RPC needs a
  // retry (see purchase-execution.ts) — never terminal itself.
  PARTIAL_SUCCESS: new Set(['RECONCILIATION_REQUIRED']),
  // Terminal — no outgoing transition is ever valid.
  COMPLETED: new Set([]),
  RECONCILIATION_REQUIRED: new Set([]),
  FAILED: new Set([]),
  EXPIRED: new Set([]),
  CANCELLED: new Set([]),
};

export function isTerminalPurchaseIntentStatus(status: PurchaseIntentStatus): boolean {
  return TERMINAL_PURCHASE_INTENT_STATUSES.has(status);
}

/** True iff `from -> to` is a structurally valid transition (including the trivial `from === to` no-op, which every idempotent write path relies on). */
export function isValidPurchaseIntentTransition(from: PurchaseIntentStatus, to: PurchaseIntentStatus): boolean {
  if (from === to) return true;
  return ALLOWED_TRANSITIONS[from].has(to);
}

export class InvalidPurchaseIntentTransitionError extends Error {
  constructor(
    public readonly from: PurchaseIntentStatus,
    public readonly to: PurchaseIntentStatus
  ) {
    super(`Invalid PurchaseIntent status transition: ${from} -> ${to}`);
    this.name = 'InvalidPurchaseIntentTransitionError';
  }
}

/** Throws `InvalidPurchaseIntentTransitionError` unless `isValidPurchaseIntentTransition(from, to)`. Every repo write that changes `status` calls this first — see purchase-intent-repo.ts. */
export function assertValidPurchaseIntentTransition(from: PurchaseIntentStatus, to: PurchaseIntentStatus): void {
  if (!isValidPurchaseIntentTransition(from, to)) {
    throw new InvalidPurchaseIntentTransitionError(from, to);
  }
}

// -----------------------------------------------------------------------------
// Per-STEP transitions (spec Aşama 6/7 — approval/signature/submit/confirm
// per SWAP step). Separate table from the intent-level one above: a step's
// lifecycle is a finer-grained thing nested inside the intent's own
// AWAITING_SIGNATURE/SUBMITTED/CONFIRMING window.
// -----------------------------------------------------------------------------

const ALLOWED_STEP_TRANSITIONS: Record<PurchaseIntentStepStatus, ReadonlySet<PurchaseIntentStepStatus>> = {
  PENDING: new Set(['APPROVAL_REQUIRED', 'AWAITING_SIGNATURE', 'FAILED']),
  APPROVAL_REQUIRED: new Set(['APPROVAL_AWAITING_SIGNATURE', 'FAILED']),
  APPROVAL_AWAITING_SIGNATURE: new Set(['APPROVAL_SUBMITTED', 'FAILED']),
  APPROVAL_SUBMITTED: new Set(['APPROVAL_CONFIRMED', 'FAILED']),
  APPROVAL_CONFIRMED: new Set(['AWAITING_SIGNATURE', 'FAILED']),
  AWAITING_SIGNATURE: new Set(['SUBMITTED', 'FAILED']),
  SUBMITTED: new Set(['CONFIRMING', 'FAILED']),
  CONFIRMING: new Set(['COMPLETED', 'FAILED']),
  // Terminal.
  NOT_NEEDED: new Set([]),
  COMPLETED: new Set([]),
  FAILED: new Set([]),
};

export function isValidPurchaseIntentStepTransition(
  from: PurchaseIntentStepStatus,
  to: PurchaseIntentStepStatus
): boolean {
  if (from === to) return true;
  return ALLOWED_STEP_TRANSITIONS[from].has(to);
}

export class InvalidPurchaseIntentStepTransitionError extends Error {
  constructor(
    public readonly stepIndex: number,
    public readonly from: PurchaseIntentStepStatus,
    public readonly to: PurchaseIntentStepStatus
  ) {
    super(`Invalid PurchaseIntent step ${stepIndex} status transition: ${from} -> ${to}`);
    this.name = 'InvalidPurchaseIntentStepTransitionError';
  }
}

export function assertValidPurchaseIntentStepTransition(
  stepIndex: number,
  from: PurchaseIntentStepStatus,
  to: PurchaseIntentStepStatus
): void {
  if (!isValidPurchaseIntentStepTransition(from, to)) {
    throw new InvalidPurchaseIntentStepTransitionError(stepIndex, from, to);
  }
}
