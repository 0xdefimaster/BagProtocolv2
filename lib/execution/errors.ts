// -----------------------------------------------------------------------------
// lib/execution/errors.ts
//
// Typed failures for the BAG execution abstraction layer (intent → graph →
// compiled execution). Mirrors the existing convention in this codebase
// (`PurchaseIntentFailureCode`, `ExecutionQuoteErrorCode`): callers and the
// UI only ever see one of these codes plus a message, never a raw provider
// stack trace or SDK-specific error shape.
//
// Deliberately separate from `PurchaseIntentFailureCode` — that taxonomy is
// the persisted, user-facing status of a `PurchaseIntent` row; this one is
// about what went wrong INSIDE the compiler/provider-selection step, before
// (or instead of) a `PurchaseIntent` even being touched. A caller that
// bridges the two (e.g. `lib/server/purchase-execution.ts`, in a later
// integration pass) maps a `BagExecutionErrorCode` onto the nearest
// `PurchaseIntentFailureCode` explicitly, rather than the two enums being
// merged into one.
// -----------------------------------------------------------------------------

export const BAG_EXECUTION_ERROR_CODES = [
  /** No registered provider's `supports()` returned true for this intent/graph. */
  'NO_ELIGIBLE_PROVIDER',
  /** A provider claimed `supports()` but `compile()` failed anyway (network, quote, simulation). */
  'PROVIDER_COMPILE_FAILED',
  /** `intent.compositionHash`/`recipeVersion` no longer matches what the graph was built from — see recipe-lock follow-up work in README.md item 10. */
  'INTENT_RECIPE_MISMATCH',
  /** The graph's legs don't sum to the intent's total input, or a leg is malformed (negative amount, unknown asset, etc). */
  'INVALID_EXECUTION_GRAPH',
  /** Caller asked for a capability (e.g. `atomic: true` / forced `SINGLE_TX`) no eligible provider can satisfy. */
  'UNSATISFIABLE_CONSTRAINTS',
] as const;

export type BagExecutionErrorCode = (typeof BAG_EXECUTION_ERROR_CODES)[number];

export class BagExecutionError extends Error {
  readonly code: BagExecutionErrorCode;
  /** Non-fatal context for logging/debugging — never something the UI parses. */
  readonly details?: Record<string, unknown>;

  constructor(code: BagExecutionErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'BagExecutionError';
    this.code = code;
    this.details = details;
  }
}
