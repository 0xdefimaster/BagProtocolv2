import { BagExecutionError } from './errors';
import { assertValidExecutionGraph, computeBagExecutionGraphHash } from './plan';
import { BagExecutionGraph, BagExecutionIntent, CompiledExecution } from './types';
import { BagExecutionProvider } from './providers/types';
import { compileWithCache } from './compile-cache';
import { validateCandidateCompleteness } from './candidate-completeness';
import { ExecutionCandidate, ExecutionCandidateSet } from './candidate-types';

// -----------------------------------------------------------------------------
// lib/execution/compiler.ts
//
// `compileBagExecution()` — spec item 3's compiler. Takes a
// provider-independent intent + graph and an ORDERED list of registered
// providers, and returns a normalized `CompiledExecution`. Never imports or
// references a specific provider package (LI.FI or otherwise) — see
// providers/types.ts's module doc.
//
// Provider order IS the fallback policy (spec item 6: "Composer uygunsa
// Composer provider, uygun değilse normal LI.FI provider, ..."). Callers
// wire that policy up by the ORDER they pass providers in — this file
// itself has no opinion on which provider should come first; see
// lib/execution/registry.ts for where BAG's own default order lives (not
// hardcoded here, so a test can pass a different order without touching
// this file).
// -----------------------------------------------------------------------------

/**
 * Shared eligibility logic — the SAME rules both `compileBagExecution()`
 * (single-winner) and `compileBagExecutionCandidates()` (spec item 9's
 * "try every eligible provider") apply, extracted here ONCE so the two
 * paths can never silently drift apart (spec item 3: "Do not duplicate
 * eligibility logic in two places"). Preserves, in order:
 *   1. `allowedProviders` filtering, if `intent.constraints.allowedProviders` is set.
 *   2. The `atomic` capability requirement, if `intent.constraints.atomic` is set.
 *   3. Each remaining provider's own `supports(intent, graph)`.
 * Never throws — a caller decides what "zero eligible" means for its own
 * error surface (see both callers below for the two different outcomes
 * that produces).
 */
function selectEligibleProviders(
  intent: BagExecutionIntent,
  graph: BagExecutionGraph,
  providers: readonly BagExecutionProvider[]
): { candidates: readonly BagExecutionProvider[]; eligible: readonly BagExecutionProvider[] } {
  const allowList = intent.constraints?.allowedProviders;
  const candidates = allowList ? providers.filter((p) => allowList.includes(p.identify())) : providers;
  const eligible = candidates.filter((p) => {
    if (intent.constraints?.atomic && !p.getCapabilities().atomic) return false;
    return p.supports(intent, graph);
  });
  return { candidates, eligible };
}

/**
 * Compiles `intent` against `graph`, trying every ELIGIBLE provider (in
 * `providers` order — see `registry.ts`) in turn until one's `compile()`
 * succeeds. This is the generalized form of the legacy
 * `tryBuildComposerSteps()` → sequential fallback (spec item 6/9's
 * "Composer başarısız/ineligible olduğunda sequential fallback çalışıyor
 * mu?"): a provider that claimed `supports() === true` but then fails to
 * actually compile (network error, quote/simulation failure) does NOT abort
 * the whole call — the compiler moves on to the next eligible provider,
 * exactly the way a real Composer outage degrades to the sequential path
 * today. Throws:
 *   - `UNSATISFIABLE_CONSTRAINTS` if `intent.constraints.atomic` is set and
 *     at least one provider is otherwise eligible, but none of the eligible
 *     ones support `atomic` — checked BEFORE compiling, so a non-atomic
 *     provider is never even asked.
 *   - `NO_ELIGIBLE_PROVIDER` if no provider (after `allowedProviders`
 *     filtering, if set) supports this intent/graph at all.
 *   - `PROVIDER_COMPILE_FAILED` only once EVERY eligible provider's
 *     `compile()` has thrown — carries every provider's failure message
 *     (`details.compileFailures`), not just the last one.
 *
 * UNCHANGED by the addition of `compileBagExecutionCandidates()` below —
 * still tries providers SEQUENTIALLY and returns the FIRST success. The two
 * functions share only the eligibility rule (`selectEligibleProviders()`),
 * never their control flow.
 */
export async function compileBagExecution(
  intent: BagExecutionIntent,
  graph: BagExecutionGraph,
  providers: readonly BagExecutionProvider[]
): Promise<CompiledExecution> {
  assertValidExecutionGraph(graph);

  const { candidates, eligible } = selectEligibleProviders(intent, graph, providers);

  if (eligible.length === 0) {
    if (intent.constraints?.atomic && candidates.some((p) => p.supports(intent, graph))) {
      throw new BagExecutionError(
        'UNSATISFIABLE_CONSTRAINTS',
        'An eligible provider exists for this intent, but none of them support atomic (single-transaction) execution.'
      );
    }
    throw new BagExecutionError(
      'NO_ELIGIBLE_PROVIDER',
      `No registered execution provider supports this intent (chain=${intent.chainId}, targets=${intent.targets.length}).`,
      { candidateIds: candidates.map((p) => p.identify()) }
    );
  }

  const executionPlanHash = computeBagExecutionGraphHash(graph);
  const compileFailures: { providerId: string; message: string }[] = [];

  for (const provider of eligible) {
    try {
      const compiled = await compileWithCache(provider, intent, graph);
      // Providers report their own `providerId`/`executionPlanHash` inside
      // `compile()` too (they have to, to satisfy the `CompiledExecution`
      // shape) — the compiler re-stamps both here from what IT knows to be
      // true, so a provider bug (wrong id, stale hash) can never leak a
      // mismatched value past this seam.
      return { ...compiled, providerId: provider.identify(), executionPlanHash };
    } catch (err) {
      compileFailures.push({ providerId: provider.identify(), message: (err as Error).message ?? String(err) });
      // Fall through to the next eligible provider — same "degrade, don't
      // abort" behavior `tryBuildComposerSteps()` already has for Composer
      // specifically, generalized across however many providers are
      // registered.
    }
  }

  throw new BagExecutionError(
    'PROVIDER_COMPILE_FAILED',
    `Every eligible provider failed to compile this execution: ${compileFailures.map((f) => `${f.providerId}: ${f.message}`).join('; ')}`,
    { compileFailures }
  );
}

/**
 * Phase 1 / item 9 — "try every eligible provider and return every
 * candidate", the sibling path `compileBagExecution()` above does NOT
 * become. Same eligibility rule (`selectEligibleProviders()`), same
 * `assertValidExecutionGraph()`/`computeBagExecutionGraphHash()` upfront —
 * but instead of stopping at the first success, every eligible provider is
 * compiled IN PARALLEL (`Promise.allSettled()`, never `Promise.all()` — one
 * provider's rejection must not discard the others' results) and EVERY
 * outcome — success or failure — becomes an `ExecutionCandidate` (spec item
 * 3.9/3.10: "Return BOTH successful and failed candidates", "Do not throw
 * simply because some providers fail").
 *
 * A candidate's `compile.status`:
 *   - `'FAILED'`, `failureReason.kind: 'PROVIDER_ERROR'` — the provider's
 *     own `compile()` threw.
 *   - `'FAILED'`, `failureReason.kind: 'INCOMPLETE_RESULT'` —
 *     `compile()` resolved, but `validateCandidateCompleteness()`
 *     (candidate-completeness.ts) rejected it as structurally partial (spec
 *     item 1 — a failed/missing graph leg).
 *   - `'COMPILED'` — resolved AND complete. `candidate.compiled` carries the
 *     SAME normalized `CompiledExecution` shape `compileBagExecution()`
 *     itself would have returned had this been the one provider tried
 *     (same `providerId`/`executionPlanHash` re-stamping).
 *
 * Only the TWO structural, graph-level failures `compileBagExecution()`
 * itself throws for are preserved as exceptions here too (spec item 3.10 —
 * "structural graph/constraint failures ... should retain exception
 * semantics"): an invalid graph (`assertValidExecutionGraph()`, checked
 * BEFORE any provider runs — no candidates are even attempted) and
 * `UNSATISFIABLE_CONSTRAINTS` (an atomic requirement no eligible provider
 * can meet — there is nothing candidate-shaped to return, the request
 * itself cannot be satisfied). `NO_ELIGIBLE_PROVIDER`, by contrast, resolves
 * to an EMPTY candidate list here rather than throwing — "no provider
 * wanted to try" is a legitimate (if unfortunate) comparison result, not a
 * caller error.
 *
 * Never ranks, never adds UI logic (spec item 3.12/3.13) — that is
 * candidate-ranking.ts's job, given this function's output as plain input.
 *
 * SIGNING BOUNDARY: this function calls each eligible provider's
 * `compileQuote()` when it has one, `compile()` otherwise (see
 * `BagExecutionProvider.compileQuote`'s doc, providers/types.ts) — it never
 * unconditionally calls `compile()` the way `compileBagExecution()` above
 * does. This is what keeps `POST /purchase-options` (the route this
 * function backs) side-effect-free: `BagRouterProvider.compile()` calls a
 * server-held EIP-712 plan signer, and a pure comparison — run before the
 * user has picked anything — must never trigger that. Only the SINGLE
 * eligible provider a caller later selects (via
 * `constraints.allowedProviders`) and re-compiles through
 * `compileBagExecution()` ever reaches `compile()` for real.
 */
export async function compileBagExecutionCandidates(
  intent: BagExecutionIntent,
  graph: BagExecutionGraph,
  providers: readonly BagExecutionProvider[]
): Promise<ExecutionCandidateSet> {
  assertValidExecutionGraph(graph);

  const { candidates, eligible } = selectEligibleProviders(intent, graph, providers);

  if (eligible.length === 0 && intent.constraints?.atomic && candidates.some((p) => p.supports(intent, graph))) {
    throw new BagExecutionError(
      'UNSATISFIABLE_CONSTRAINTS',
      'An eligible provider exists for this intent, but none of them support atomic (single-transaction) execution.'
    );
  }

  const executionPlanHash = computeBagExecutionGraphHash(graph);
  // Batch-level timestamp — ONLY for `ExecutionCandidateSet.compiledAt`
  // (spec item 11's "when was this comparison run"), never stamped onto an
  // individual candidate. Each candidate gets its OWN `compiledAt` below,
  // captured at that provider's actual settlement time, not this shared
  // start time — three providers finishing at 200ms/4s/8s must NOT all
  // report the same timestamp (fix for the "compiledAt is actually a batch
  // timestamp, not a per-candidate one" review finding).
  const batchCompiledAt = Date.now();

  // Wrap each provider's compile() so EVERY outcome — success or failure —
  // captures `Date.now()` at that PARTICULAR provider's own settlement
  // moment, not after the whole batch finishes. This wrapper never rejects
  // (errors are caught internally), which is deliberate: if we let a
  // rejection propagate to `Promise.allSettled`, the timestamp could only
  // be read back out in the `.map()` below, which runs AFTER every promise
  // in the batch has settled — i.e. at the slowest provider's finish time,
  // not the failing provider's own (much earlier) one. Catching internally
  // is what makes a fast failure's `compiledAt` genuinely earlier than a
  // slow success's, not just a success's.
  const settled = await Promise.allSettled(
    eligible.map(async (provider) => {
      try {
        // Comparison path — prefer a provider's quote-only compilation
        // (`compileQuote()`, providers/types.ts's own doc) when it defines
        // one, and fall back to `compile()` only when it doesn't. This is
        // the ONE call site in this file that ever chooses between the two;
        // `compileBagExecution()` above never does — it always calls
        // `compile()`. Bound explicitly rather than destructured off
        // `provider`, since both are ordinary instance methods that close
        // over `this` (see BagRouterProvider).
        // `compileWithCache()` lets the purchase-intent that follows reuse
        // this exact result instead of compiling it again (compile-cache.ts).
        const compiled = provider.compileQuote
          ? await provider.compileQuote(intent, graph)
          : await compileWithCache(provider, intent, graph);
        return { outcome: 'fulfilled' as const, compiled, completedAt: Date.now() };
      } catch (err) {
        return { outcome: 'rejected' as const, error: err, completedAt: Date.now() };
      }
    })
  );

  const resultCandidates: ExecutionCandidate[] = settled.map((settledOutcome, i) => {
    const provider = eligible[i];
    const providerId = provider.identify();

    // `settledOutcome.status === 'rejected'` here would mean the wrapper
    // above itself threw synchronously before returning — not a provider
    // failure, which the wrapper already converts into a normal
    // `{ outcome: 'rejected', ... }` value. Treated as a FAILED candidate
    // with `batchCompiledAt` as the least-wrong available timestamp, purely
    // as a defensive fallback; it should not be reachable in practice.
    if (settledOutcome.status === 'rejected') {
      const err = settledOutcome.reason;
      return {
        id: providerId,
        providerId,
        compile: {
          status: 'FAILED',
          failureReason: { kind: 'PROVIDER_ERROR', message: err instanceof Error ? err.message : String(err) },
        },
        executionMode: null,
        metrics: null,
        executionPlanHash,
        compiledAt: batchCompiledAt,
      };
    }

    const wrapped = settledOutcome.value;

    if (wrapped.outcome === 'rejected') {
      const err = wrapped.error;
      return {
        id: providerId,
        providerId,
        compile: {
          status: 'FAILED',
          failureReason: { kind: 'PROVIDER_ERROR', message: err instanceof Error ? err.message : String(err) },
        },
        executionMode: null,
        metrics: null,
        executionPlanHash,
        compiledAt: wrapped.completedAt,
      };
    }

    const { compiled: rawCompiled, completedAt } = wrapped;

    // Same re-stamping `compileBagExecution()` does — a provider bug (wrong
    // id, stale hash) can never leak a mismatched value past this seam.
    const compiled: CompiledExecution = { ...rawCompiled, providerId, executionPlanHash };
    const completeness = validateCandidateCompleteness(graph, compiled);

    if (!completeness.ok) {
      return {
        id: providerId,
        providerId,
        compile: { status: 'FAILED', failureReason: completeness.reason },
        executionMode: null,
        metrics: null,
        executionPlanHash,
        compiledAt: completedAt,
      };
    }

    return {
      id: providerId,
      providerId,
      compile: { status: 'COMPILED' },
      executionMode: compiled.mode,
      compiled,
      metrics: null, // Annotated by candidate-metrics.ts, a separate pass over this function's output — never computed inline here (spec item 4: "Phase 1 does NOT add simulateExecutionCandidates()", and metrics stay independently testable).
      executionPlanHash,
      compiledAt: completedAt,
    };
  });

  return { candidates: resultCandidates, executionPlanHash, compiledAt: batchCompiledAt };
}
