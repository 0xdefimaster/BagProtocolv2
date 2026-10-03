import { AssetIdentity, ExecutionPlan, ExecutionStep } from '@/types/basket-protocol';

// -----------------------------------------------------------------------------
// Execution adapter interface — the seam where a real router/aggregator
// (LI.FI's getRoutes/Composer today; possibly "Robinhood Chain" or "ATLAS"
// later — spec section 7/10) gets plugged in without touching
// `lib/domain/basket-protocol/deposit/*` (the pure allocation/plan layer)
// or any UI that renders an `ExecutionPlan`.
//
// Deliberately a SEPARATE interface from `BlockchainAdapter` (adapter.ts),
// not an extension of it — that interface is about deploying/minting a
// Bag itself; this one is about routing a deposit's constituent swaps.
// Mirrors that file's own `MockAdapter`/`EvmAdapter` split: today only
// `MockExecutionAdapter` (mock-execution-adapter.ts) exists; a future
// `LiFiExecutionAdapter` implements this same interface (spec section 8).
//
// `quoteExecutionPlan()` returns QUOTES ONLY. No implementation of this
// interface may sign a transaction, request wallet approval, or submit
// anything on-chain in this phase (spec section 21) — see each step's
// `quote` staying entirely advisory (an `ExecutionResult` is never fed
// back into anything that moves funds).
// -----------------------------------------------------------------------------

/**
 * One step's quoted result. `outputAmountRaw`/`outputDecimals` describe an
 * actual QUANTITY of the step's `outputAsset` — the thing a
 * `DepositAllocation.valueRaw` deliberately does NOT (spec section 14:
 * "Price vs Route" — value vs quantity are never the same field). `null`
 * for a `KEEP` step: there is nothing to quote when nothing is swapped.
 *
 * Phase 14 — fields below `executionFeeRaw` were added for
 * `LiFiExecutionAdapter` (lifi-execution-adapter.ts). Every one of them is
 * `null` unless the adapter's underlying provider genuinely returned a
 * value for it (spec section 13: "Fake/default values oluşturma. Veri
 * yoksa null olarak bırak.") — `MockExecutionAdapter` sets every new field
 * to `null` (or the one deterministic pass-through value noted below),
 * never a fabricated number.
 */
export interface ExecutionStepQuote {
  /** Which adapter produced this quote — `'mock'` today; `'lifi'` once `LiFiExecutionAdapter` exists. Never used for branching logic, only for display/debugging — same spirit as `AssetPrice.source`. */
  provider: string;
  outputAmountRaw: string;
  outputDecimals: number;
  /** Present for forward-compatibility with a real router's quote (spec section 12) — this phase's mock adapter always reports `0`. */
  slippageBps: number;
  /** Present for forward-compatibility with real fee logic (spec section 13) — this phase's mock adapter always reports `"0"`. */
  protocolFeeRaw: string;
  executionFeeRaw: string;

  /**
   * Guaranteed minimum quantity of `outputAsset` this quote's `slippageBps`
   * enforces — LI.FI's `estimate.toAmountMin` (spec section 12: never
   * conflated with `ExecutionRouteRequest.targetValueRaw`, a VALUE in the
   * input asset, not a quantity of the output asset). `MockExecutionAdapter`
   * sets this equal to `outputAmountRaw`, matching its own `slippageBps: 0`.
   */
  minOutputRaw: string | null;
  /**
   * Human-readable identifier of the route/tool the quote came from — e.g.
   * a DEX or bridge name (LI.FI's `estimate.tool`) for a live quote,
   * `'mock'` for the mock adapter. Display/debugging only, same as
   * `provider` above — never branched on.
   */
  route: string | null;
  /**
   * 0–1 price-impact fraction. Reserved for forward compatibility — LI.FI's
   * `/v1/quote` response (as of this phase) does not include a top-level
   * price-impact figure, so this is always `null` today for every adapter,
   * `LiFiExecutionAdapter` included, rather than a value estimated/derived
   * here (spec section 13/16: never fabricate what the provider doesn't
   * hand back).
   */
  priceImpact: number | null;
  /** Estimated gas cost for this step's route, in `gasCostAsset`'s raw units — `null` when the provider reports none (a `KEEP` step, or a quote-only provider that doesn't estimate gas). */
  gasCostRaw: string | null;
  /** The asset `gasCostRaw` is denominated in — usually the source chain's native asset. `null` iff `gasCostRaw` is `null`. */
  gasCostAsset: AssetIdentity | null;
  /** ISO timestamp of when this specific quote was fetched — a live quote is only ever a snapshot; `MockExecutionAdapter` stamps this at call time too, for shape parity. */
  timestamp: string;
}

/** Typed domain error for a single step's quote request — spec section 10: the UI never sees a raw provider stack trace, only one of these four codes plus a human message. */
export type ExecutionQuoteErrorCode = 'QUOTE_UNAVAILABLE' | 'UNSUPPORTED_ROUTE' | 'INVALID_ASSET' | 'PROVIDER_ERROR';

export interface ExecutionQuoteError {
  code: ExecutionQuoteErrorCode;
  message: string;
}

export interface ExecutionStepResult {
  step: ExecutionStep;
  quote: ExecutionStepQuote | null;
  /** Non-null iff `quote` is `null` because the adapter tried and failed to price this step (as opposed to a `KEEP` step, which is `quote: null, error: null` — nothing was ever attempted). */
  error: ExecutionQuoteError | null;
}

export interface ExecutionResult {
  bagId: string;
  inputAsset: AssetIdentity;
  inputAmountRaw: string;
  steps: ExecutionStepResult[];
  unallocatedRaw: string;
}

export interface ExecutionAdapter {
  readonly name: string;
  readonly isLive: boolean;

  /**
   * Quotes every step of `plan`. Never signs, sends, bridges, or waits for
   * a transaction — see this file's module doc. Implementations should be
   * safe to call repeatedly against the same `ExecutionPlan` (idempotent,
   * no side effects on the plan itself); only the returned `quote` may
   * vary between calls (e.g. a live adapter's market-price-dependent
   * quote), never the `step` it's attached to.
   */
  quoteExecutionPlan(plan: ExecutionPlan): Promise<ExecutionResult>;
}
