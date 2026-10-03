import { BagExecutionGraph, CompiledExecution } from './types';
import { CandidateFailureReason } from './candidate-types';

// -----------------------------------------------------------------------------
// lib/execution/candidate-completeness.ts
//
// Phase 1 / item 1's "IMPORTANT CURRENT BUG / INVARIANT": a `compile()` that
// RESOLVES is not the same claim as "every leg has a real, executable
// output". `LiFiSequentialProvider.compile()` (lifi-sequential-provider.ts)
// quotes every leg in parallel and reports a per-leg failure as
// `{ ok: false, ... }` inside `providerMetadata.legResults` WITHOUT
// throwing — by design, to match the pre-existing
// `buildPurchaseIntentSteps()` partial-success behavior a single legacy
// `compileBagExecution()` caller relies on (see that provider's own module
// doc). That is the CORRECT behavior for the legacy single-winner path,
// which the compiler's caller (`purchase-intent-bridge.ts`) already knows
// how to turn into a per-step FAILED row.
//
// It is NOT safe to reuse that same partially-successful `CompiledExecution`
// as an "available" CANDIDATE for side-by-side comparison, though: a
// candidate the user can tap to select must be a route that can actually
// execute end to end. This module is the generic (provider-neutral) check
// that decides that — deliberately living HERE, in the candidate layer, and
// NOT inside `compiler.ts`/`lifi-sequential-provider.ts` itself (spec item
// 1: "Prefer implementing this validation in the new candidate layer rather
// than making compiler.ts understand LI.FI-specific legResults") so the
// legacy `compileBagExecution()` path's behavior is completely unchanged —
// this file is additive, read-only over its input, and only ever consulted
// by `compileBagExecutionCandidates()`.
// -----------------------------------------------------------------------------

const POSITIVE_INTEGER_RE = /^[1-9]\d*$/;

/** True for a raw output string that represents a genuine, non-zero, non-fabricated quantity. Rejects `'0'`, `''`, negative, decimal, and non-numeric strings — a real swap leg never legitimately expects to receive exactly zero of its target asset, so a `'0'` here is always either a missing quote (LI.FI Sequential's per-leg failure) or a provider's own "nothing to report" fallback (Composer's `outputAmountRaw ?? '0'` — see lifi-composer-provider.ts) rather than a real, verifiable minimum. */
function isGenuineRawOutput(raw: string | null | undefined): raw is string {
  return typeof raw === 'string' && POSITIVE_INTEGER_RE.test(raw);
}

/** `null` (no guarantee claimed) or a genuine positive raw amount no greater than the quote. */
function isConsistentGuarantee(minimum: string | null, quoted: string): boolean {
  if (minimum === null) return true;
  return isGenuineRawOutput(minimum) && BigInt(minimum) <= BigInt(quoted);
}

/**
 * The completeness invariant itself, spec item 1's bullets, checked in
 * order (cheapest/most-informative failure first):
 *
 *   1. `graph.legs.length === compiled.expectedOutputs.length` — a provider
 *      that silently dropped a leg (or added a phantom one) fails here
 *      before anything else is even inspected.
 *   2. Every graph leg id appears in `expectedOutputs` EXACTLY once — catches
 *      both a missing leg (LiFiSequentialProvider's per-leg failure case)
 *      and a duplicate/malformed provider response.
 *   3. Each `ExpectedOutput.asset` matches the SAME leg's `targetAsset` —
 *      catches a provider that returned outputs in the wrong order/keying.
 *   4. Each `ExpectedOutput.quotedOutputRaw` is a genuine positive integer
 *      (see `isGenuineRawOutput()`) — catches both an explicit missing
 *      quote AND a fabricated `'0'`/`null` (Composer's degenerate case when
 *      a leg's simulation genuinely came back empty).
 *   5. `minimumGuaranteedOutputRaw` is either `null` (the provider claims NO
 *      guaranteed floor — legitimate, e.g. Composer) or a genuine positive
 *      integer that does not exceed `quotedOutputRaw` (a "guaranteed floor"
 *      above the provider's own expectation is a malformed quote).
 *
 * Returns `{ ok: true }` only when ALL FOUR hold for EVERY leg. Never
 * throws — the caller (`compileBagExecutionCandidates()`) turns a `{ ok:
 * false }` into a FAILED candidate, exactly the way a provider throwing
 * does, rather than letting an exception here abort the whole
 * `Promise.allSettled()` fan-out.
 */
export function validateCandidateCompleteness(
  graph: BagExecutionGraph,
  compiled: CompiledExecution
): { ok: true } | { ok: false; reason: CandidateFailureReason } {
  const { legs } = graph;
  const { expectedOutputs } = compiled;

  if (expectedOutputs.length !== legs.length) {
    return {
      ok: false,
      reason: {
        kind: 'INCOMPLETE_RESULT',
        message: `Expected ${legs.length} leg output(s), got ${expectedOutputs.length}.`,
        legIds: legs.map((l) => l.id),
      },
    };
  }

  const outputsByLegId = new Map<string, (typeof expectedOutputs)[number][]>();
  for (const output of expectedOutputs) {
    const bucket = outputsByLegId.get(output.legId);
    if (bucket) bucket.push(output);
    else outputsByLegId.set(output.legId, [output]);
  }

  const badLegIds: string[] = [];
  for (const leg of legs) {
    const outputs = outputsByLegId.get(leg.id);
    if (!outputs || outputs.length !== 1) {
      // Missing entirely (a failed/omitted leg) OR duplicated (a malformed
      // provider response) — both are "not exactly one", both disqualify.
      badLegIds.push(leg.id);
      continue;
    }
    const output = outputs[0];
    const sameAsset = output.asset.chain === leg.targetAsset.chain && output.asset.address.toLowerCase() === leg.targetAsset.address.toLowerCase();
    if (!sameAsset || !isGenuineRawOutput(output.quotedOutputRaw) || !isConsistentGuarantee(output.minimumGuaranteedOutputRaw, output.quotedOutputRaw)) {
      badLegIds.push(leg.id);
    }
  }

  if (badLegIds.length > 0) {
    return {
      ok: false,
      reason: {
        kind: 'INCOMPLETE_RESULT',
        message: `${badLegIds.length} of ${legs.length} leg(s) have no valid expected output: ${badLegIds.join(', ')}.`,
        legIds: badLegIds,
      },
    };
  }

  return { ok: true };
}
