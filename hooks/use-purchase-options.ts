'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

// -----------------------------------------------------------------------------
// hooks/use-purchase-options.ts
//
// Phase 1 / item 6/8/14 — thin client for `POST /api/bags/:id/purchase-options`
// (lib/server/purchase-execution.ts's `getPurchaseOptionsForUser()`). Mirrors
// `PurchasePreviewModal`'s own preview-fetch debounce (300ms, cancel-on-change)
// so the two calls behave consistently to the user, but is otherwise fully
// independent — a purchase-options failure (including "this deployment
// doesn't have the compiler enabled", `PROVIDER_SELECTION_UNAVAILABLE`) never
// blocks the existing preview/purchase flow, it just means `options` stays
// `null` and the modal renders no comparison UI at all (see
// PurchasePreviewModal.tsx's own use of this hook).
//
// Deliberately does NOT try to interpret WHY the flag is off vs. some other
// error — every non-2xx response is treated identically ("no comparison
// available right now"), since the only thing that matters to this hook's
// caller is whether `options` came back or not.
//
// Checkpoint 8/9 — freshness/staleness fix. Two real bugs closed here:
//
// 1. STALE-RESPONSE RACE: the old "nothing to compare yet" early return
//    (empty/zero amount, or no inputAssetId) set `options`/`loading` back to
//    a clean state but never bumped `requestIdRef`. A slow in-flight request
//    started under the PREVIOUS amount could still resolve afterwards, pass
//    the (unchanged) `requestIdRef.current !== requestId` check, and write
//    stale candidate data into state for an input the user had already
//    cleared. Fixed by treating this branch as "supersede whatever's
//    in-flight" too — it now bumps `requestIdRef` exactly like starting a
//    new request does.
// 2. STALE DATA LEFT ON SCREEN DURING A REQUOTE: previously, changing
//    `amount`/`inputAssetId` left the OLD `options` (computed for the OLD
//    input) rendered on screen for the full 300ms debounce + network
//    round-trip, looking like a valid comparison for the NEW input the
//    whole time. `options` is now cleared the instant a new request is
//    kicked off, not just once the new one resolves.
//
// This file also now owns "is this comparison too old to trust" — `isStale`
// — computed from `CANDIDATE_TTL_MS`/`isCandidateStale()`
// (candidate-types.ts), which existed before this checkpoint but were never
// actually consulted by any caller. Deliberately a ONE-SHOT local timer, not
// a poll: no repeated network calls are made just because time passed (spec
// item 7) — staleness only flips a client-side flag; refreshing the actual
// quote is a separate, explicit `refresh()` call the caller (or the user, via
// a "Refresh routes" affordance) triggers on purpose.
// -----------------------------------------------------------------------------

import { CANDIDATE_TTL_MS, ExecutionCandidateView, isCandidateStale } from '@/lib/execution/candidate-types';
import { CandidateRankingWinner } from '@/lib/execution/candidate-ranking';

export type { ExecutionCandidateView };

export interface PurchaseOptionsView {
  candidates: ExecutionCandidateView[];
  failed: ExecutionCandidateView[];
  winners: CandidateRankingWinner[];
  executionPlanHash: string;
  compiledAt: number;
}

interface UsePurchaseOptionsState {
  options: PurchaseOptionsView | null;
  loading: boolean;
  /** `true` once `options.compiledAt` is older than `CANDIDATE_TTL_MS` — see this file's own header doc. Always `false` while `options` is `null` (nothing to be stale). Never itself triggers a re-fetch — see `refresh()`. */
  isStale: boolean;
  /** Explicit, caller-triggered re-quote of the SAME `(bagId, inputAssetId, amount)` — the "controlled refresh" spec item 7 asks for instead of a poll loop. A no-op while there's nothing valid to quote (mirrors the hook's own early-return condition). */
  refresh: () => void;
}

/**
 * Debounced fetch of the candidate comparison for `(bagId, inputAssetId,
 * amount)` — re-fetches whenever any of the three change, same 300ms
 * debounce/cancel convention `PurchasePreviewModal`'s own preview fetch
 * uses. `inputAssetId` null or `amount` blank/zero simply means "nothing
 * to compare yet" — `options` stays `null`, no request is made.
 */
/**
 * Set once the server answers PROVIDER_SELECTION_UNAVAILABLE (the execution
 * compiler flag is off on this deployment). The comparison can never work
 * then, so later amount changes stop asking — each ask still cost a full
 * server round trip (and, in dev, a route compile) that competed with the
 * real purchase request. Module-level: lasts for this page load only.
 */
let providerSelectionUnavailable = false;

/** Test hook. */
export function resetPurchaseOptionsAvailability() {
  providerSelectionUnavailable = false;
}

export function usePurchaseOptions(
  bagId: string,
  inputAssetId: string | null,
  amount: string,
  /** false skips the comparison entirely (e.g. the automatic launch buy, which never shows it). */
  enabled: boolean = true
): UsePurchaseOptionsState {
  const [options, setOptions] = useState<PurchaseOptionsView | null>(null);
  const [loading, setLoading] = useState(false);
  const [isStale, setIsStale] = useState(false);
  // Guards against a slow earlier response landing AFTER a newer request
  // already resolved — same "cancelled" pattern the preview fetch uses,
  // but as a ref (not a cleanup-function boolean) since this hook is
  // called with fresh primitive args each render rather than owning its
  // own effect body inline.
  const requestIdRef = useRef(0);
  const [refreshNonce, setRefreshNonce] = useState(0);

  useEffect(() => {
    const trimmedAmount = amount.trim();
    if (!enabled || providerSelectionUnavailable || !inputAssetId || trimmedAmount === '' || trimmedAmount === '0') {
      // Bump the request id here too (fix #1 above) — otherwise a request
      // already in flight from a moment ago is still "current" as far as
      // the fetch's own check is concerned, and can write stale options
      // back in after this branch already cleared them.
      requestIdRef.current += 1;
      setOptions(null);
      setLoading(false);
      return;
    }

    const requestId = ++requestIdRef.current;
    // Fix #2 above — never leave a PREVIOUS input's candidates on screen
    // while a new comparison is being fetched for the current one.
    setOptions(null);
    setLoading(true);

    const timer = setTimeout(() => {
      fetch(`/api/bags/${bagId}/purchase-options`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ inputAssetId, amount: trimmedAmount }),
      })
        .then(async (res) => {
          if (requestIdRef.current !== requestId) return; // superseded
          if (!res.ok) {
            // Includes PROVIDER_SELECTION_UNAVAILABLE (flag off), rate
            // limiting, and any other failure — none of these are shown
            // as an error to the user; the comparison UI just doesn't
            // render (see this file's own header doc).
            const failure = (await res.json().catch(() => null)) as { code?: string } | null;
            if (failure?.code === 'PROVIDER_SELECTION_UNAVAILABLE') providerSelectionUnavailable = true;
            setOptions(null);
            return;
          }
          const body = (await res.json().catch(() => null)) as { options: PurchaseOptionsView } | null;
          if (requestIdRef.current !== requestId) return; // superseded while awaiting res.json()
          setOptions(body?.options ?? null);
        })
        .catch(() => {
          if (requestIdRef.current !== requestId) return;
          setOptions(null);
        })
        .finally(() => {
          if (requestIdRef.current === requestId) setLoading(false);
        });
    }, 300);

    return () => clearTimeout(timer);
  }, [bagId, inputAssetId, amount, refreshNonce, enabled]);

  // One-shot staleness timer, rescheduled whenever a fresh `options` batch
  // arrives — NOT a poll (spec item 7): nothing here ever calls `fetch`,
  // it only flips a boolean once, locally, at the moment this specific
  // batch's TTL elapses, so the UI stops presenting these numbers as
  // current (spec item 5).
  useEffect(() => {
    if (!options) {
      setIsStale(false);
      return;
    }
    if (isCandidateStale(options)) {
      setIsStale(true);
      return;
    }
    setIsStale(false);
    const msUntilStale = options.compiledAt + CANDIDATE_TTL_MS - Date.now();
    const timer = setTimeout(() => setIsStale(true), Math.max(msUntilStale, 0));
    return () => clearTimeout(timer);
  }, [options]);

  const refresh = useCallback(() => {
    setRefreshNonce((n) => n + 1);
  }, []);

  return { options, loading, isStale, refresh };
}

/**
 * Checkpoint 8/9 fix — resolves what `selectedProviderId` should be after a
 * `PurchaseOptionsView` update, given whatever was previously selected and
 * which `executionPlanHash` that previous selection was made against.
 * Extracted as its own pure function (rather than living inline in
 * `PurchasePreviewModal`'s effect) so this decision is unit-testable
 * without rendering the modal — see `hooks/__tests__/use-purchase-options.test.ts`.
 *
 * Two cases a naive "only re-derive when `executionPlanHash` changes"
 * effect gets wrong (the actual bug this closes):
 *   - A REFRESH can return the SAME `executionPlanHash` (the basket/graph
 *     didn't change, only the quotes did) while the previously-selected
 *     provider is no longer among the executable candidates (it started
 *     failing). An effect keyed only on `executionPlanHash` never re-runs
 *     here, so the stale, now-invalid id would silently stay selected.
 *   - Conversely, a genuinely NEW graph (`executionPlanHash` changed)
 *     should always re-derive a fresh pick, even if — by coincidence — a
 *     provider with the same id happens to also be executable for the new
 *     graph; keeping the old pick in that case would just be luck, not a
 *     considered decision (see `PurchasePreviewModal`'s original doc on
 *     this effect for why that distinction mattered even before this fix).
 *
 * Returns `null` whenever there's nothing to compare (0 or 1 executable
 * candidates) — mirrors `showCandidatePicker`'s own threshold: with no real
 * choice on the table, `execution.start()` is called without a provider id
 * at all, falling straight through to `compileBagExecution()`'s ordinary
 * fallback order, exactly as before this checkpoint.
 */
export function resolveSelectedProviderId(params: {
  previousProviderId: string | null;
  previousExecutionPlanHash: string | null;
  options: PurchaseOptionsView | null;
}): string | null {
  const { previousProviderId, previousExecutionPlanHash, options } = params;
  const executableCandidates = options?.candidates.filter((c) => c.compile.status === 'COMPILED') ?? [];
  if (executableCandidates.length <= 1) return null;

  const hashUnchanged = options != null && previousExecutionPlanHash === options.executionPlanHash;
  if (hashUnchanged && previousProviderId !== null && executableCandidates.some((c) => c.providerId === previousProviderId)) {
    return previousProviderId;
  }

  // Prefer the route with the best ENFORCED floor, then the best like-for-like quote; when neither
  // comparison is valid (candidate-ranking.ts leaves the category absent), fall back to registry order.
  const winner =
    options?.winners.find((w) => w.category === 'bestGuaranteedOutput') ?? options?.winners.find((w) => w.category === 'bestQuotedOutput');
  return winner?.providerId ?? executableCandidates[0].providerId;
}
