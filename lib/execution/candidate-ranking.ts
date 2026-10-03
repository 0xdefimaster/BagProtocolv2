import { ExecutionCandidate } from './candidate-types';

// -----------------------------------------------------------------------------
// lib/execution/candidate-ranking.ts
//
// Phase 1 checkpoint 5 / spec item 8. Takes `compileBagExecutionCandidates()`
// + `annotateCandidateMetrics()`'s output and separates it into:
//   - `executable` / `failed` — spec item 8's own split ("2 of 3 routes
//     available" — a FAILED candidate is never silently dropped here; the
//     caller decides what to show for it).
//   - transparent, named CATEGORIES over `executable` only — never a
//     mystery weighted score (spec item 8: "Do NOT create a mysterious
//     universal weighted score").
//
// EVERY category requires REAL comparable data across at least one
// candidate; a category with no eligible candidate (e.g. every provider is
// gas-silent) is simply absent from the result, never populated with a
// guess or a `0`-ranked placeholder.
//
// NAMING, deliberately literal (spec item 8's explicit warnings):
//   - `lowestGas`  — NOT "Cheapest". Gas alone is not total cost (fees are
//     a separate, often-absent figure) — see `estimatedFeeUsd` in
//     candidate-metrics.ts's `providerMetadata`, which this file does NOT
//     fold into `lowestGas` for exactly that reason.
//   - `fastest`    — compares `estimatedDurationSeconds`.
//   - `bestGuaranteedOutput` — compares `minimumGuaranteedOutputUsd`, the
//     floor each route ENFORCES at execution. The one output metric that is
//     apples-to-apples by construction; absent whenever any executable
//     candidate cannot guarantee a floor (e.g. Composer's simulation-only
//     output) — the UI then shows each provider's own output instead.
//   - `bestQuotedOutput` — compares `quotedOutputUsd` (EXPECTED output), and
//     only when every executable candidate's `quotedOutputBasis` is the SAME
//     (all PROVIDER_QUOTE, or all SIMULATION). A quote is never raced
//     against a simulation.
//   There is deliberately no generic "bestOutput" any more: it used to rank
//   one field that meant "slippage floor" for LI.FI/BAG Router and
//   "simulation" for Composer, so the winner mostly reflected which
//   semantic a provider happened to report.
//
// COMPLETENESS REQUIREMENT (bug fix, post-Phase-1): a category is only
// allowed to name a winner when EVERY executable candidate reports a real
// (non-null) value for that metric. If even one executable candidate's
// value is unknown, this file does NOT silently drop that candidate out of
// the race and crown whichever candidate happens to have a number —
// that would imply the unknown candidate lost the comparison when in fact
// it was never actually compared. In that case the category is simply
// absent from `winners` (same as when no candidate has the metric at all).
// The caller/UI must not read an absent category as "the other route is
// worse" — only as "not enough data to compare on this axis". This applies
// uniformly to every category.
//
// NO WINNER WITHOUT A REAL COMPARISON: a category also stays absent when
// fewer than TWO executable candidates exist (one route is not "best" of
// anything — "2 of 3 routes available" is shown via `failed` instead), and
// when the top value is an exact TIE (naming one of two equal routes "best"
// would claim a difference that doesn't exist). This supersedes the earlier
// C6 "first in registry order wins a tie" rule for BADGES; default
// SELECTION is unaffected — callers still fall back to registry order
// (hooks/use-purchase-options.ts).
//
// NO "balanced" CATEGORY IN PHASE 1: composing gas + fee + output + speed
// into one score requires a weighting scheme, and spec item 8 is explicit
// that an invented weighting must never be presented as "optimized" or
// "data-derived". Because today's real registries surface AT MOST two
// candidates (spec item 0) and gas/duration are frequently `null` for one
// of them (bag-router, Composer), there is rarely enough comparable data
// across candidates to make a "balanced" figure meaningfully different
// from the output categories anyway — so this phase deliberately ships the
// transparent categories only, and revisits "balanced" only once a design
// can name its weights explicitly and explain the result (spec item 8's
// own bar for adding it).
// -----------------------------------------------------------------------------

export const CANDIDATE_RANKING_CATEGORIES = ['bestGuaranteedOutput', 'bestQuotedOutput', 'lowestGas', 'fastest'] as const;
export type CandidateRankingCategory = (typeof CANDIDATE_RANKING_CATEGORIES)[number];

export interface CandidateRankingWinner {
  category: CandidateRankingCategory;
  candidateId: string;
  providerId: string;
}

export interface CandidateRankingResult {
  /** `compile.status === 'COMPILED'` AND metrics were annotated — the only candidates any category can pick from. */
  executable: ExecutionCandidate[];
  /** Never dropped — spec item 8: "2 of 3 routes available" needs these too. */
  failed: ExecutionCandidate[];
  /** At most one winner per category in `CANDIDATE_RANKING_CATEGORIES` order; a category is simply absent when no executable candidate has the metric it needs. */
  winners: CandidateRankingWinner[];
}

function isExecutable(candidate: ExecutionCandidate): boolean {
  return candidate.compile.status === 'COMPILED' && candidate.compiled != null && candidate.metrics != null;
}

/**
 * Picks the candidate with the strictly extreme (lowest/highest, per
 * `better`) value of `metric(candidate)` — or `undefined` (category absent)
 * when the comparison would not be real:
 *   - fewer than two candidates (nothing to compare against);
 *   - ANY candidate's value is null (never race only the ones with data —
 *     see this module's header doc);
 *   - the extreme value is shared by two or more candidates (a tie has no
 *     "best").
 */
function pickExtreme(
  candidates: ExecutionCandidate[],
  metric: (c: ExecutionCandidate) => number | null,
  better: (candidate: number, current: number) => boolean
): ExecutionCandidate | undefined {
  if (candidates.length < 2) return undefined;

  const values: { candidate: ExecutionCandidate; value: number }[] = [];
  for (const candidate of candidates) {
    const value = metric(candidate);
    if (value === null) return undefined;
    values.push({ candidate, value });
  }

  let best = values[0];
  for (const entry of values.slice(1)) {
    if (better(entry.value, best.value)) best = entry;
  }
  const tied = values.filter((entry) => entry.value === best.value).length > 1;
  return tied ? undefined : best.candidate;
}

const pickLowest = (candidates: ExecutionCandidate[], metric: (c: ExecutionCandidate) => number | null) =>
  pickExtreme(candidates, metric, (value, current) => value < current);

const pickHighest = (candidates: ExecutionCandidate[], metric: (c: ExecutionCandidate) => number | null) =>
  pickExtreme(candidates, metric, (value, current) => value > current);

/** Quoted outputs are only comparable when every candidate's quote has the SAME basis (and none is MIXED). */
function haveSameQuoteBasis(candidates: ExecutionCandidate[]): boolean {
  const bases = new Set(candidates.map((c) => c.metrics!.quotedOutputBasis));
  return bases.size === 1 && !bases.has('MIXED');
}

/**
 * Splits `candidates` into executable/failed and computes the transparent
 * ranking categories over the executable set only. Never mutates its
 * input, never ranks a FAILED candidate into any category, never invents a
 * value for a category with no real data — see this module's own header
 * doc for the full reasoning.
 */
export function rankCandidates(candidates: ExecutionCandidate[]): CandidateRankingResult {
  const executable = candidates.filter(isExecutable);
  const failed = candidates.filter((c) => !isExecutable(c));

  const winners: CandidateRankingWinner[] = [];

  const bestGuaranteed = pickHighest(executable, (c) => c.metrics!.minimumGuaranteedOutputUsd);
  if (bestGuaranteed) winners.push({ category: 'bestGuaranteedOutput', candidateId: bestGuaranteed.id, providerId: bestGuaranteed.providerId });

  const bestQuoted = haveSameQuoteBasis(executable) ? pickHighest(executable, (c) => c.metrics!.quotedOutputUsd) : undefined;
  if (bestQuoted) winners.push({ category: 'bestQuotedOutput', candidateId: bestQuoted.id, providerId: bestQuoted.providerId });

  const lowestGas = pickLowest(executable, (c) => c.metrics!.estimatedGasUsd);
  if (lowestGas) winners.push({ category: 'lowestGas', candidateId: lowestGas.id, providerId: lowestGas.providerId });

  const fastest = pickLowest(executable, (c) => c.metrics!.estimatedDurationSeconds);
  if (fastest) winners.push({ category: 'fastest', candidateId: fastest.id, providerId: fastest.providerId });

  return { executable, failed, winners };
}
