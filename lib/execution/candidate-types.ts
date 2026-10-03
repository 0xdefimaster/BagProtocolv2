import { CompiledExecution, ExecutionMode, OutputQuoteBasis } from './types';

// -----------------------------------------------------------------------------
// lib/execution/candidate-types.ts
//
// Phase 1 / item 9 — "basket-level execution candidate comparison". An
// `ExecutionCandidate` is what ONE provider produced when
// `compileBagExecutionCandidates()` (compiler.ts) tried every eligible
// provider in parallel, ANNOTATED with whatever real metrics
// candidate-metrics.ts could compute for it. This is an ADDITIVE layer:
// nothing here replaces `CompiledExecution`/`ExecutionMode` (types.ts,
// untouched) — a candidate's `compiled` field, when present, IS a real
// `CompiledExecution`, the exact same shape `compileBagExecution()` (the
// existing single-winner path) already returns.
//
// COMPILE STATUS is a strict two-value discriminant, not a richer status
// machine, because Phase 1 has exactly two outcomes worth telling a caller
// apart (spec item 2 — "distinguish COMPILED / FAILED"):
//   - COMPILED: the provider's `compile()` resolved, AND the result passed
//     `validateCandidateCompleteness()` — every graph leg has exactly one
//     real (non-fabricated) expected output. `candidate.compiled` is set.
//   - FAILED: the provider threw, OR it resolved but was structurally
//     incomplete (a failed/missing leg — see candidate-completeness.ts).
//     `candidate.compiled` is `undefined` and `candidate.failureReason` is
//     set instead. A FAILED candidate is still RETURNED (never dropped) so
//     the UI can say "2 of 3 routes available" (spec item 8) — see
//     compiler.ts's `compileBagExecutionCandidates()` doc.
// -----------------------------------------------------------------------------

export const CANDIDATE_COMPILE_STATUSES = ['COMPILED', 'FAILED'] as const;
export type CandidateCompileStatus = (typeof CANDIDATE_COMPILE_STATUSES)[number];

/** Structured, human-readable reason a candidate is FAILED — never just a bare string, so the UI/logs can distinguish "provider threw" from "provider returned a partial result" without parsing prose. */
export interface CandidateFailureReason {
  /**
   * - `PROVIDER_ERROR`   — `provider.compile()` itself threw (network, quote/simulation failure).
   * - `INCOMPLETE_RESULT`— `compile()` resolved, but `validateCandidateCompleteness()` rejected it
   *   (a graph leg has no expected output, a duplicate, or a fabricated-looking zero — see that
   *   module's own doc for the exact invariant).
   */
  kind: 'PROVIDER_ERROR' | 'INCOMPLETE_RESULT';
  message: string;
  /** Present only for `INCOMPLETE_RESULT` — the specific leg id(s) the completeness check rejected, for debugging/logging. Never shown to the end user verbatim. */
  legIds?: string[];
}

/**
 * One provider's real-money metrics for a candidate — ONLY fields a
 * provider genuinely returned. Spec item 5/6/7: "Do not use fake zero
 * values for unavailable metrics" — every field here is `number | null`,
 * and `null` always means "this provider/leg genuinely did not report
 * this", never "zero" and never "not yet computed". See
 * candidate-metrics.ts for how each field is populated and
 * candidate-ranking.ts for why a `null` metric excludes a candidate from
 * the ranking category that needs it, rather than sorting it as worst (or
 * best).
 */
export interface CandidateMetrics {
  /**
   * USD value of every leg's `ExpectedOutput.quotedOutputRaw` (what the
   * provider EXPECTS — never a promise), summed. Priced UNIFORMLY for every
   * provider via the existing `getPriceProvider()` + recipe/registry decimals
   * (never a provider's own self-reported `toAmountUSD`/`priceImpact`).
   * `null` when any leg's target asset could not be priced/decimals-resolved
   * — never a partial sum. Only comparable ACROSS candidates whose
   * `quotedOutputBasis` is the same (a quote is not a simulation).
   */
  quotedOutputUsd: number | null;
  /** The basis of every leg's `quotedOutputRaw` in this candidate; `'MIXED'` if legs disagree (then never ranked on quoted output). */
  quotedOutputBasis: OutputQuoteBasis | 'MIXED';
  /**
   * USD value of every leg's `ExpectedOutput.minimumGuaranteedOutputRaw` —
   * the floor ENFORCED at execution. `null` when ANY leg has no guaranteed
   * floor (e.g. Composer's simulation-only output) or could not be priced:
   * a candidate that cannot guarantee every leg never shows a guaranteed
   * total. This is the one output metric that is apples-to-apples across
   * providers by construction.
   */
  minimumGuaranteedOutputUsd: number | null;
  /**
   * Real gas cost in USD, ONLY when the provider's own compile response
   * carried one (LI.FI Sequential's `Estimate.gasCosts[].amountUSD`,
   * summed across legs — see lifi-sequential-provider.ts). `null` for
   * Composer (raw `gasLimit` is a gas UNIT, never converted to USD without
   * a live gas-price read this phase deliberately doesn't add — spec item
   * 6) and for bag-router (no gas estimate is available at compile time —
   * spec item 6's BAG ROUTER section).
   */
  estimatedGasUsd: number | null;
  /**
   * Seconds, summed across every leg's `Estimate.executionDuration` for
   * LI.FI Sequential — summed, not maxed, because
   * `hooks/use-purchase-execution.ts`'s own module doc confirms sequential
   * legs execute ONE AT A TIME, not in parallel (see that file's "SEQUENTIAL,
   * not parallel, in the fallback case" comment) — a wall-clock estimate for
   * a serialized process is the sum of its steps, not the slowest one.
   * `null` when the provider's response has no reliable duration field
   * (Composer, bag-router — spec item 6).
   */
  estimatedDurationSeconds: number | null;
  /** Passthrough of the intent's own constraint, for display/debugging only — NEVER a ranking input (spec item 7: slippage is an input constraint, identical across candidates, not a competitive metric). */
  requestedSlippageBps: number;
  /**
   * Provider-specific extra metrics that don't fit a universal field —
   * e.g. Composer's `priceImpact`/`fees`/raw `gasLimit` (spec item 6).
   * Never read by generic ranking/UI code that isn't provider-aware;
   * exists for debugging and for a provider-specific UI detail row, same
   * convention as `CompiledExecution.providerMetadata`.
   */
  providerMetadata?: Record<string, unknown>;
}

export interface ExecutionCandidate {
  /** Stable within one candidate-comparison response — currently just the `providerId` (Phase 1 never runs the same provider twice per comparison), kept as its own field so a future multi-route-per-provider phase doesn't have to renumber this shape. */
  id: string;
  /** The provider's own `identify()` name — `'bag-router' | 'lifi-composer' | 'lifi-sequential'` today, but this type never hardcodes that list (spec item 0: "support an arbitrary number N of providers"). */
  providerId: string;
  compile: {
    status: CandidateCompileStatus;
    /** Set only when `status === 'FAILED'`. */
    failureReason?: CandidateFailureReason;
  };
  /** The mode a COMPILED candidate would execute as. `null` for a FAILED candidate — there is nothing to execute. */
  executionMode: ExecutionMode | null;
  /** Set only when `compile.status === 'COMPILED'` — the real, complete, normalized result, byte-for-byte what `compileBagExecution()` would have returned had this been the single provider tried. NEVER read as the final thing to execute — see plan.ts/compiler.ts's own "recompile the selected provider" step (spec item 9/11) for why this is display/estimation data, not an executable artifact. */
  compiled?: CompiledExecution;
  /** `null` when `compile.status === 'FAILED'` or when the underlying `compiled.expectedOutputs` genuinely had nothing to compute metrics from — metrics annotation never runs on a FAILED candidate (candidate-metrics.ts's own guard). */
  metrics: CandidateMetrics | null;
  /** Same value every candidate in one comparison response carries — the graph this candidate was compiled from, per spec item 3/11 ("preserve the graph hash", "graph hash is consistent across candidates"). Distinct from quote freshness — see `compiledAt`'s own doc. */
  executionPlanHash: string;
  /**
   * Wall-clock ms this candidate was compiled at (`Date.now()`) — spec item
   * 9: "executionPlanHash and quote freshness are different invariants".
   * `executionPlanHash` proves "same basket/graph"; `compiledAt` (plus a
   * caller-applied TTL) is what proves "this specific provider quote is
   * still fresh enough to show". Neither this candidate's `compiled` object
   * NOR its `compiledAt` timestamp is ever executed directly — selecting a
   * candidate always triggers a fresh `compileBagExecution()` call (spec
   * item 9/11), so a stale `compiledAt` only means "the numbers on screen
   * might be off, refresh the comparison", never "this could execute a
   * stale transaction".
   */
  compiledAt: number;
}

/**
 * The client-facing shape of `ExecutionCandidate` — the same fields, MINUS
 * `compiled` (the raw `CompiledExecution`: transactions/calldata, and each
 * provider's own `providerMetadata` internals — LI.FI Sequential's full
 * per-leg `LiFiStep` objects, a signed Bag Router plan, etc). None of that
 * is needed to compare-and-pick a route: the comparison screen only ever
 * reads `providerId`/`executionMode`/`compile`/`metrics`, and selecting a
 * candidate re-compiles it from scratch server-side anyway
 * (`createPurchaseIntentForUser`'s `selectedProviderId`, spec item 9/11) —
 * the browser is never the thing that executes `candidate.compiled`.
 * Shipping it to the client before a route is even chosen is needless
 * exposure of internal provider data (and, for Bag Router specifically, of
 * an already-signed plan) with no corresponding benefit; this view is what
 * actually goes out over `/purchase-options` instead of the raw candidate.
 *
 * `swapLegCount` is the one piece of information client UI genuinely needs
 * that would otherwise only be reachable via `compiled.expectedOutputs.length`
 * — kept as a plain number instead, so a confirmation-count display (see
 * `lib/execution/signing-expectation.ts`) doesn't need the raw compile
 * result just to count legs.
 */
export interface ExecutionCandidateView {
  id: string;
  providerId: string;
  /**
   * Deliberately NOT `ExecutionCandidate['compile']` — that type's
   * `failureReason.message` is the raw provider/network error string
   * (`err.message` from `compiler.ts`, e.g. a literal LI.FI API error
   * body), which is internal debugging detail, not something the purchase
   * screen should ship to the browser. Only `failureReason.kind` (one of
   * a fixed, non-sensitive enum — see `CandidateFailureReason`'s own doc)
   * survives into this view; the full `CandidateFailureReason` (with its
   * `message`) stays server-side, in the raw `ExecutionCandidate` array
   * `getPurchaseOptionsForUser()` computes but does not return, for
   * logging/debugging.
   */
  compile: { status: CandidateCompileStatus; failureReasonKind?: CandidateFailureReason['kind'] };
  executionMode: ExecutionMode | null;
  metrics: CandidateMetrics | null;
  executionPlanHash: string;
  compiledAt: number;
  /** `compiled.expectedOutputs.length` when COMPILED, `null` when FAILED — see this interface's own doc for why this is carried instead of the full `compiled` object. */
  swapLegCount: number | null;
}

export function toExecutionCandidateView(candidate: ExecutionCandidate): ExecutionCandidateView {
  const { id, providerId, compile, executionMode, metrics, executionPlanHash, compiledAt, compiled } = candidate;
  return {
    id,
    providerId,
    compile: { status: compile.status, failureReasonKind: compile.failureReason?.kind },
    executionMode,
    metrics,
    executionPlanHash,
    compiledAt,
    swapLegCount: compiled?.expectedOutputs.length ?? null,
  };
}

/** Default candidate quote TTL — the same spirit as `PURCHASE_INTENT_TTL_MS` (types/purchase-intent.ts) but a much shorter horizon: a provider quote (gas price, DEX pool state, LI.FI route) goes stale far faster than a whole purchase intent. UI/caller-enforced only — the server-side selected-provider path never trusts `compiledAt` for anything security-relevant, since it always recompiles (see `ExecutionCandidate.compiledAt`'s own doc). */
export const CANDIDATE_TTL_MS = 30_000;

export function isCandidateStale(candidate: Pick<ExecutionCandidate, 'compiledAt'>, now: number = Date.now(), ttlMs: number = CANDIDATE_TTL_MS): boolean {
  return now - candidate.compiledAt > ttlMs;
}

/** The full result of one candidate-comparison pass — spec item 3's `compileBagExecutionCandidates()` return shape. */
export interface ExecutionCandidateSet {
  candidates: ExecutionCandidate[];
  executionPlanHash: string;
  /** When this comparison BATCH was started — distinct from each `ExecutionCandidate.compiledAt`, which is that candidate's own settlement time and can differ across candidates in the same set (a slow provider finishes later than a fast one). Use this field for "how old is this whole comparison", and each candidate's own `compiledAt` for per-candidate staleness. */
  compiledAt: number;
}
