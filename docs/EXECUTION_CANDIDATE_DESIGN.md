# Execution Candidate Comparison — As-Built Reference (Rev 4)

**Status:** IMPLEMENTED. This document was originally written pre-implementation
(Rev 1–3) as a design proposal. **Rev 4 replaces that framing entirely**: every
section below has been re-checked against the actual shipped code
(`lib/execution/candidate-types.ts`, `candidate-completeness.ts`, `compiler.ts`,
`candidate-metrics.ts`, `candidate-ranking.ts`, `providers/*.ts`,
`lib/server/purchase-execution.ts`, `hooks/use-purchase-options.ts`,
`components/app/PurchasePreviewModal.tsx`, and the corresponding test suites),
not against the original proposal. Where the code diverged from the Rev 1–3
proposal, the code wins and the text below describes the code. Anything the
proposal called out as a future phase but the code has since shipped is
described as shipped; anything the proposal assumed would ship but the code
does not do is described as not done.

**Scope:** `compileBagExecution()` (the original single-winner compiler) is
unchanged. This document describes the ADDITIONAL path,
`compileBagExecutionCandidates()`, that compiles every eligible provider
instead of stopping at the first success, so the basket purchase flow can
show every real execution alternative — with an honest "N of M routes
available" count — before the user signs anything.

---

## 0. What the registry actually gives us

`lib/execution/registry.ts` (`buildDefaultProviders()`) can register up to
three providers for the same same-chain, single-input graph, in this fixed
priority order:

| Order | Provider | File | Registered when |
|---|---|---|---|
| 1 | `bag-router` | `providers/bag-router-provider.ts` | a deployed router address, a leg builder, and a plan signer are all configured |
| 2 | `lifi-composer` | `providers/lifi-composer-provider.ts` | `LIFI_API_KEY` is set |
| 3 | `lifi-sequential` | `providers/lifi-sequential-provider.ts` | always registered — the catch-all |

All three consume the **same** `BagExecutionGraph` produced by
`buildBagExecutionGraph()` (`plan.ts`) — none of them changes the leg
topology; only the *providers* differ. A route-topology generator (hub
routing, batching) would be a genuinely separate, later change to
`plan.ts`/graph construction, not to the provider layer — still out of scope
here.

---

## A. `ExecutionCandidate`

```ts
// lib/execution/candidate-types.ts

export const CANDIDATE_COMPILE_STATUSES = ['COMPILED', 'FAILED'] as const;
export type CandidateCompileStatus = (typeof CANDIDATE_COMPILE_STATUSES)[number];

export interface CandidateFailureReason {
  kind: 'PROVIDER_ERROR' | 'INCOMPLETE_RESULT';
  message: string;
  legIds?: string[]; // only for INCOMPLETE_RESULT
}

export interface CandidateMetrics {
  quotedOutputUsd: number | null;                              // expected output (see D.5)
  quotedOutputBasis: 'PROVIDER_QUOTE' | 'SIMULATION' | 'MIXED';
  minimumGuaranteedOutputUsd: number | null;                   // enforced floor; null if any leg has none
  estimatedGasUsd: number | null;
  estimatedDurationSeconds: number | null;
  requestedSlippageBps: number;
  providerMetadata?: Record<string, unknown>;
}

export interface ExecutionCandidate {
  id: string;                 // == providerId today; kept distinct for a future multi-route-per-provider phase
  providerId: string;
  compile: { status: CandidateCompileStatus; failureReason?: CandidateFailureReason };
  executionMode: ExecutionMode | null;
  compiled?: CompiledExecution;   // set only when COMPILED
  metrics: CandidateMetrics | null; // null until annotateCandidateMetrics() runs, and always null on a FAILED candidate
  executionPlanHash: string;
  compiledAt: number;          // see "compiledAt is per-candidate" below
}
```

- **COMPILED**: the provider's compile call resolved, AND
  `validateCandidateCompleteness()` (`candidate-completeness.ts`) accepted the
  result as structurally complete. `candidate.compiled` is set.
- **FAILED**: either the provider's compile call threw
  (`failureReason.kind === 'PROVIDER_ERROR'`), or it resolved but was
  structurally incomplete (`failureReason.kind === 'INCOMPLETE_RESULT'`) — a
  missing/duplicated leg, a leg output for the wrong asset, or a fabricated
  `'0'`/non-positive `minimumOutputRaw`. A FAILED candidate is still
  RETURNED, never dropped, so the UI can say "N of M routes available."

### `compiledAt` is a per-candidate completion timestamp, not a batch timestamp

Each candidate's `compiledAt` is stamped at **that specific provider's own
settlement moment** (`Date.now()` captured the instant its compile call
resolves or rejects), not at the end of the whole `Promise.allSettled()`
batch. A provider that fails fast genuinely gets an earlier `compiledAt` than
one that's still finishing three seconds later. The batch itself has its own
separate timestamp — see `ExecutionCandidateSet.compiledAt` below — used for
"how old is this whole comparison," while each candidate's own `compiledAt`
answers "how old is *this* candidate's quote," which can legitimately differ
within one comparison response.

### `ExecutionCandidateSet` — the full result of one comparison pass

```ts
export interface ExecutionCandidateSet {
  candidates: ExecutionCandidate[];
  executionPlanHash: string; // identical across every candidate — same graph
  compiledAt: number;        // batch start time, distinct from each candidate's own compiledAt
}
```

### `ExecutionCandidateView` — the sanitized shape actually sent to the browser

```ts
export interface ExecutionCandidateView {
  id: string;
  providerId: string;
  compile: { status: CandidateCompileStatus; failureReasonKind?: CandidateFailureReason['kind'] };
  executionMode: ExecutionMode | null;
  metrics: CandidateMetrics | null;
  executionPlanHash: string;
  compiledAt: number;
  swapLegCount: number | null; // compiled.expectedOutputs.length when COMPILED, else null
}
```

**The raw `ExecutionCandidate` — and specifically its `compiled` field — is
never sent to the browser.** `toExecutionCandidateView()` strips it before
`getPurchaseOptionsForUser()` (see section G) returns anything: the full
`compiled` object carries each provider's raw transactions/calldata, LI.FI's
complete per-leg `LiFiStep` objects, and — for `bag-router` specifically — an
already-signed `ExecutionPlan` when that provider happens to be a candidate.
None of that is needed to compare-and-pick a route, and selecting a candidate
always triggers a fresh, server-side recompile of just that one provider
anyway (see section E) — the browser never executes `candidate.compiled`
directly, so there is no benefit to shipping it, only unnecessary exposure.
The view also downgrades `failureReason` to just its `kind` — the raw
`message` (a literal provider/network error string) stays server-side for
logging, since it's debugging detail, not something the purchase screen
should render as-is.

---

## B. `compileBagExecutionCandidates()` vs `compileBagExecution()`

```ts
// lib/execution/compiler.ts

export async function compileBagExecution(
  intent: BagExecutionIntent, graph: BagExecutionGraph, providers: readonly BagExecutionProvider[]
): Promise<CompiledExecution>;

export async function compileBagExecutionCandidates(
  intent: BagExecutionIntent, graph: BagExecutionGraph, providers: readonly BagExecutionProvider[]
): Promise<ExecutionCandidateSet>;
```

Both share one eligibility filter (`selectEligibleProviders()`, private to
`compiler.ts`: `allowedProviders` → `atomic` capability → each provider's own
`supports()`), extracted once so the two paths can never silently drift
apart on who's eligible. Past that shared filter, they do very different
things:

- **`compileBagExecution()`** — the ORIGINAL, unmodified single-winner path.
  Tries eligible providers **sequentially, in registry order**, and returns
  the FIRST one whose compile call succeeds. Throws
  `UNSATISFIABLE_CONSTRAINTS` / `NO_ELIGIBLE_PROVIDER` /
  `PROVIDER_COMPILE_FAILED` exactly as before. This is the function that
  actually gets executed against — see section E.
- **`compileBagExecutionCandidates()`** — compiles **every** eligible
  provider **in parallel** (`Promise.allSettled`, never `Promise.all`, so one
  provider's rejection doesn't discard the others' in-flight results), and
  turns every settled outcome — success or failure — into an
  `ExecutionCandidate`. Never throws for a per-provider failure (that becomes
  a FAILED candidate instead); only the two structural, graph-level failures
  (`assertValidExecutionGraph()`'s throw, and `UNSATISFIABLE_CONSTRAINTS`)
  are preserved as real exceptions, since there's nothing candidate-shaped to
  return for those. `NO_ELIGIBLE_PROVIDER` resolves to an **empty** candidate
  list here instead of throwing — "nobody wanted to try" is a legitimate
  comparison result. Never ranks and never touches persistence — see
  `candidate-ranking.ts` (section C) and `purchase-execution.ts` (section G)
  for what happens to its output next.

For each eligible provider, `compileBagExecutionCandidates()` prefers that
provider's `compileQuote()` method over `compile()` when the provider defines
one (`(provider.compileQuote ?? provider.compile).bind(provider)`) — see the
signing-boundary note below for why this distinction exists and matters.

### Completeness check (why a resolved compile isn't automatically COMPILED)

`LiFiSequentialProvider.compile()` never throws on a per-leg quote failure —
a failed leg is simply omitted from `expectedOutputs` while the call still
resolves normally, matching the pre-existing partial-success behavior the
legacy single-winner bridge (`purchase-intent-bridge.ts`) already knows how
to turn into a per-step FAILED row. That's correct for the legacy path, but
it is **not** safe to reuse as-is for a side-by-side comparison candidate: a
route the user can tap to select must be able to execute end to end.
`validateCandidateCompleteness()` (`candidate-completeness.ts`) is the
provider-neutral check `compileBagExecutionCandidates()` runs on every
resolved result before trusting it as COMPILED. It requires, for every leg in
the graph:

1. `expectedOutputs.length === graph.legs.length`.
2. Every graph leg id appears in `expectedOutputs` exactly once (catches both
   a missing leg and a duplicate).
3. Each `ExpectedOutput.asset` matches that same leg's `targetAsset`.
4. Each `ExpectedOutput.minimumOutputRaw` is a genuine positive-integer
   string (rejects `'0'`, empty, negative, decimal, non-numeric — a real swap
   leg never legitimately expects exactly zero of its target).

This is a no-op (always trivially true) for `bag-router` and `lifi-composer`,
which are already atomic by construction (a single failing leg throws their
whole compile call) — it is the one thing that closes the real gap for
`lifi-sequential`. A failure here produces `compile.status: 'FAILED'`,
`failureReason.kind: 'INCOMPLETE_RESULT'`, with the specific offending leg
ids attached for logging.

---

## C. Candidate ranking

```ts
// lib/execution/candidate-ranking.ts

export const CANDIDATE_RANKING_CATEGORIES = ['bestGuaranteedOutput', 'bestQuotedOutput', 'lowestGas', 'fastest'] as const;
export type CandidateRankingCategory = (typeof CANDIDATE_RANKING_CATEGORIES)[number];

export interface CandidateRankingWinner {
  category: CandidateRankingCategory;
  candidateId: string;
  providerId: string;
}

export interface CandidateRankingResult {
  executable: ExecutionCandidate[]; // COMPILED with metrics annotated — the only pool any category picks from
  failed: ExecutionCandidate[];     // never dropped
  winners: CandidateRankingWinner[]; // at most one winner per category; a category is simply absent when it has no valid winner
}

export function rankCandidates(candidates: ExecutionCandidate[]): CandidateRankingResult;
```

There are exactly **four** ranking categories today: `bestGuaranteedOutput`,
`bestQuotedOutput`, `lowestGas`, `fastest`. There is no `balanced` category and no `other`
bucket in the ranking API — see below for why, and for how the UI actually
handles "not shown as a winner."

- **`bestGuaranteedOutput`** — highest `metrics.minimumGuaranteedOutputUsd`
  (the floor each route ENFORCES at execution). Absent whenever any
  executable candidate cannot guarantee a floor (Composer today).
- **`bestQuotedOutput`** — highest `metrics.quotedOutputUsd`, only when
  every executable candidate's `quotedOutputBasis` is the same (a provider
  quote is never raced against a simulation).
- *(Removed: `bestOutput`.* It ranked a single `minimumOutputRaw` field that
  meant "slippage floor" for LI.FI Sequential / BAG Router and "simulated
  output" for Composer, so Composer "won" by roughly the slippage tolerance
  regardless of execution quality. See D.5.)
- **`lowestGas`** — lowest `metrics.estimatedGasUsd`. Deliberately named
  `lowestGas`, never "Cheapest": gas is one line item, not total cost (a
  separate, still-`null`-for-Phase-1 `estimatedFeeUsd` exists in
  `providerMetadata` for `lifi-sequential` and is not folded in here).
- **`fastest`** — lowest `metrics.estimatedDurationSeconds`.

**No `balanced` category.** Composing gas + fee + output + speed into one
score requires an invented weighting scheme, and at most one of
{gas, duration} is ever populated for the same candidate at once in
practice (see section D's table) — a weighted score built mostly from
`null` inputs would be exactly the "mysterious black-box score" this design
was written to avoid. This isn't a Phase-1 placeholder waiting to be filled
in; it's a settled decision not to ship a synthetic composite metric until
there's real per-candidate fee/gas/duration coverage to build one from
honestly.

**No `other` bucket.** `rankCandidates()`'s output is exactly `executable` /
`failed` / `winners` — every executable candidate is always in `executable`
regardless of whether it won a category, so there is no separate "leftover"
list to expose; the UI (section G/H) renders the full `executable` list and
overlays winner badges from `winners` on whichever candidates earned one.

### Completeness requirement for a category winner (bug fix)

A category only produces a winner when **every** executable candidate
reports a real (non-`null`) value for that metric. If even one executable
candidate's value is unknown, the category produces **no winner at all** —
`rankCandidates()` does not silently drop the unknown candidate from the
race and crown whichever candidate happens to have a number. Concretely:
if candidate A has `estimatedGasUsd: null` and candidate B has
`estimatedGasUsd: 1`, `lowestGas` is simply absent from `winners`, not
`{ category: 'lowestGas', candidateId: B }`. Silently excluding A and
badging B "Lowest Gas" would imply a real comparison took place when A was
never actually measured against B — that's misleading regardless of which
provider happens to be missing the figure. This applies uniformly to
every category.

**No winner without a real comparison** (supersedes the earlier C6
tie-break for badges): a category is also absent when there are fewer than
two executable candidates (one route is not "best" of anything), and when
the top value is an exact tie. Default *selection*
(`hooks/use-purchase-options.ts`) is unaffected: it prefers
`bestGuaranteedOutput`, then `bestQuotedOutput`, then registry order.

The client (`components/app/PurchasePreviewModal.tsx`) reads `winners` only
as badges layered onto the candidate list (`RANKING_LABELS`:
`bestGuaranteedOutput → "Best Guaranteed Output"`,
`bestQuotedOutput → "Best Quoted Output"`, `lowestGas → "Lowest Gas"`,
`fastest → "Fastest"`) — a candidate with no badge is not implied to be
worse on that axis, only "not compared" on it. Every card always shows the
provider's OWN output, labelled by what it is ("~$X expected", "~$X
simulated", "≥$X guaranteed min" / "no guaranteed minimum").

---

## D. Gas / duration / slippage data — per provider, current state

### D.1 — `lifi-sequential` (`LiFiSequentialProvider`)

Fully wired. Each leg's raw `LiFiStep` (already fetched by
`quoteRealSwapStep()`, `lib/blockchain/lifi-purchase-quote.ts`) is carried
through in `compiled.providerMetadata.legResults[legId].lifiStep`.
`candidate-metrics.ts`'s `extractSequentialTiming()` reads
`estimate.gasCosts` / `estimate.feeCosts` / `estimate.executionDuration` off
each leg's step — no second quote call.

- **Gas**: summed across legs. If any leg's `gasCosts` includes a `'SUM'`
  entry, only that entry is used (it already aggregates the others);
  otherwise every entry is summed. Never double-counts `APPROVE`+`SEND`
  against a `SUM` entry that includes both.
- **Duration**: **summed**, not maxed, across legs. `sum()` was chosen
  because `hooks/use-purchase-execution.ts`'s own module doc and its
  `for (const step of swapSteps) { await executeOneStep(...) }` loop confirm
  legs execute strictly one at a time (one wallet confirmation at a time),
  never in parallel — a wall-clock estimate for a serialized process is the
  sum of its steps, not the slowest one. If a future change makes legs
  execute independently, this aggregation would need to be revisited
  alongside that change.
- **Fees** (non-gas provider fees, `feeCosts`): summed into
  `providerMetadata.estimatedFeeUsd` when present — display-only, never
  folded into `estimatedGasUsd` or used for ranking.

### D.2 — `lifi-composer` (`LiFiComposerProvider`)

**Raw fields are preserved; a USD gas figure is not yet computed.**
`lib/blockchain/lifi-composer-adapter.ts` preserves `gasLimitRaw`,
`priceImpact`, and `fees` off the Compose SDK's `compile()` result (all three
are genuinely returned by the SDK call already being made — this was a pure
passthrough, not a new API call), and `lifi-composer-provider.ts` threads
them into `compiled.providerMetadata`. **`candidate-metrics.ts`'s
`extractComposerTiming()` deliberately still returns `estimatedGasUsd: null`
and `estimatedDurationSeconds: null` for Composer candidates today** —
`gasLimitRaw` is a gas UNIT count, not USD, and turning it into a comparable
`estimatedGasUsd` needs one more input (a live gas-price read) that has not
been added. The raw `gasLimitRaw` / `priceImpact` / `fees` values are
surfaced as-is in `providerMetadata` for a provider-specific UI detail row,
never forced into the universal `estimatedGasUsd` field they don't
(currently) fit. `estimatedDurationSeconds` has no source at all for
Composer — the installed Compose SDK's compile response has no
execution-duration field to read.

**Open follow-up, not yet done:** add the one gas-price read that would turn
`gasLimitRaw` into a real `estimatedGasUsd` for Composer candidates
(reusing the existing `PriceProvider` infra, no new price source).

### D.3 — `bag-router` (`BagRouterProvider`)

**Unavailable, unchanged.** The injected `legBuilder`
(`legbuilders/robinhood-uniswap-leg-builder.ts`, backed by a
`viem.simulateContract` call) returns an output amount, not a gas estimate.
`candidate-metrics.ts` returns `NO_TIMING` (`estimatedGasUsd: null`,
`estimatedDurationSeconds: null`) for `bag-router` unconditionally. Producing
a real gas figure would require an additional `estimateGas` RPC call against
the fully built (and, for the executable path, signed) transaction — a
genuinely new capability, not an extraction of already-fetched data, and not
implemented today. Duration is likewise not estimated — there is no
average-block-time source in the codebase to derive one from, and one is not
invented.

### D.4 — Slippage, across all three

`leg.slippageBps` comes from the graph (a single, shared requested
tolerance), not from any provider — every candidate compiled from the same
graph carries the same value. It's carried on
`CandidateMetrics.requestedSlippageBps` for display only, never used to rank
candidates against each other.

### D.5 — Output metrics: expected vs guaranteed (priced uniformly)

`ExpectedOutput` (lib/execution/types.ts) carries two different numbers per
leg, and each provider fills them with what it genuinely has:

| Provider | `quotedOutputRaw` (basis) | `minimumGuaranteedOutputRaw` |
|---|---|---|
| `lifi-sequential` | `estimate.toAmount` (`PROVIDER_QUOTE`) | `estimate.toAmountMin` — enforced by the LI.FI route |
| `bag-router` | Uniswap QuoterV2 `amountOut` (`PROVIDER_QUOTE`) | quote − slippage — enforced on-chain via the router's `minOutputs` |
| `lifi-composer` | `producedResources[..].simulated.amountOut` (`SIMULATION`) | `null` — BAG gets no floor for what reaches the wallet. Each swap IS protected on chain by LI.FI's own `amountOutMin` (`producedResources["swap_<i>.amountOut"].simulated.amountOutMin`), but that is the provider's floor at the swap boundary; it is recorded separately as `providerEnforcedMinOutputRaw` and never used for verification |

Both are priced identically for every provider: each leg's raw amount is
converted through the asset's known decimals and the existing
`PriceProvider.getPrice()`, then summed into `quotedOutputUsd` /
`minimumGuaranteedOutputUsd`. **Never** a provider's own self-reported USD
figure (LI.FI's `toAmountUSD`, Composer's `priceImpact.outputValueUsd`).
Each total is `null` — never a partial sum — the instant any leg has no
amount for it (e.g. no guaranteed floor), no resolvable decimals, or no
available price. Price lookups are deduped per distinct asset.

### D.6 — Summary table (current, as shipped)

| Metric | `bag-router` | `lifi-composer` | `lifi-sequential` |
|---|---|---|---|
| `quotedOutputUsd` | ✅ (quote) | ✅ (simulation) | ✅ (quote) |
| `minimumGuaranteedOutputUsd` | ✅ | ❌ (no enforced floor) | ✅ |
| `estimatedGasUsd` | ❌ (D.3, not implemented) | ❌ (D.2 — raw `gasLimitRaw` preserved in `providerMetadata`, USD conversion not implemented) | ✅ |
| `estimatedDurationSeconds` | ❌ | ❌ (no source in the SDK response) | ✅ |
| `requestedSlippageBps` | ✅ (graph input) | ✅ (graph input); `priceImpact.impactBps` also available in `providerMetadata` as a realized figure | ✅ (graph input) |

Direct implication for ranking: `fastest` only ever ranks `lifi-sequential`
candidates against each other today (or wins trivially when it's the only
executable candidate) — every other provider is genuinely `null` for
duration. `lowestGas` is in the same position — only `lifi-sequential`
reports a real figure. Per the completeness requirement in section C, this
means `lowestGas`/`fastest` will very often be **absent** in a mixed-provider
comparison (e.g. `bag-router` + `lifi-sequential` both executable) precisely
because one of them is missing the metric — this is the intended,
non-misleading behavior, not a bug.

---

## E. Staleness and revalidation

`computeBagExecutionGraphHash(graph)` hashes the graph (asset weights, legs,
chain, amounts) — identical across every candidate compiled from the same
graph. It proves "this is still the basket I asked about," never "this
quote is still fresh"; these are two different invariants.

- **`CANDIDATE_TTL_MS = 30_000`** (`candidate-types.ts`) — a comparison
  screen's own, shorter TTL, distinct from `PURCHASE_INTENT_TTL_MS` (which
  governs a single, already-chosen, signed-later commitment). `isCandidateStale(candidate, now?, ttlMs?)`
  checks `now - candidate.compiledAt > ttlMs`.
- **Client-side staleness handling** (`hooks/use-purchase-options.ts`):
  a one-shot local timer (never a poll — no repeated network calls just
  because time passed) flips `isStale` once `CANDIDATE_TTL_MS` elapses since
  the comparison was fetched. The UI (`PurchasePreviewModal.tsx`) shows a
  "These routes may be outdated" banner with a "Refresh routes" button when
  stale, and visually dims (never hides) the candidate picker so the numbers
  are never mistaken for a just-quoted figure while still letting the user
  re-select once refreshed.
  - Two staleness/freshness races were specifically fixed here: (1) a
    slow in-flight request for an amount the user had already cleared could
    previously land after the "nothing to compare yet" early-return path had
    reset local state, writing stale data back in — fixed by having that
    early-return path also bump the request-id guard, so a superseded
    request's late resolution is always discarded. (2) changing
    `amount`/`inputAssetId` used to leave the OLD comparison rendered on
    screen for the full debounce + network round trip before the new one
    arrived, looking like a valid comparison for the new input the whole
    time — fixed by clearing `options` the instant a new request starts,
    not only once it resolves.
- **Revalidation on selection is mandatory.** Selecting a candidate never
  persists or executes its (possibly seconds-old) `compiled`/`compiledAt`
  data directly. Instead, `createPurchaseIntentForUser()` is called with
  `selectedProviderId`, which sets
  `constraints: { allowedProviders: [selectedProviderId] } }` on a freshly
  re-derived `BagExecutionIntent`/`BagExecutionGraph` and calls the EXISTING,
  unmodified `compileBagExecution()` — the single-winner path — constrained
  to just that one provider. This produces a brand-new `CompiledExecution`
  with a fresh quote, fresh `executionPlanHash`, and (for `bag-router`) a
  freshly-signed plan, then proceeds through the existing
  persist/execute/reconcile path unchanged. `compileBagExecutionCandidates()`
  is strictly a comparison-time helper; nothing it produces is ever the
  thing that gets executed.

---

## F. Candidate lifecycle

```
BUILD INTENT                     (existing: purchaseIntentToBagExecutionIntent / buildBagExecutionGraph)
   ↓
DISCOVER ELIGIBLE PROVIDERS      (selectEligibleProviders(), shared with compileBagExecution())
   ↓
COMPILE ALL CANDIDATES           (compileBagExecutionCandidates(), Promise.allSettled, parallel,
                                   compileQuote() preferred over compile() per provider — see signing note)
   ↓
VALIDATE COMPLETENESS            (validateCandidateCompleteness() — resolved but partial ⇒ FAILED/INCOMPLETE_RESULT)
   ↓
ANNOTATE METRICS                 (annotateCandidateMetrics() — uses the existing PriceProvider)
   ↓
RANK                             (rankCandidates() → { executable, failed, winners })
   ↓
SANITIZE FOR CLIENT              (toExecutionCandidateView() — drops raw `compiled`, message detail)
   ↓
USER SELECTS one candidate
   ↓
RE-VERIFY SELECTED PROVIDER      (compileBagExecution(intent, graph, providers, {allowedProviders:[selected]})
                                   ← EXISTING, unmodified; this is the fresh, server-side recompile)
   ↓
EXECUTE / PERSIST / RECONCILE    (existing purchase-execution.ts path, unmodified)
```

---

## G. Bag Router signing architecture: `compile()` vs `compileQuote()`

`BagExecutionProvider` (`providers/types.ts`) has two compile-shaped methods:

- **`compile(intent, graph): Promise<CompiledExecution>`** — the EXECUTABLE
  path. `compileBagExecution()` (the single-winner path that actually gets
  persisted/executed) always calls this, never `compileQuote()`. A provider
  that must produce a real, irreversible authorization artifact as part of
  compiling does that here.
- **`compileQuote?(intent, graph): Promise<CompiledExecution>`** — OPTIONAL,
  comparison-only. `compileBagExecutionCandidates()` calls this instead of
  `compile()` whenever a provider defines it, falling back to `compile()`
  only when it doesn't. A provider implementing `compileQuote()` must not do
  anything inside it that a real execution needs done exactly once (signing,
  nonce consumption, any other one-shot side effect).

`LiFiComposerProvider` and `LiFiSequentialProvider` have no meaningful
irreversible step at compile time — both only build calldata the connected
wallet signs afterward, client-side — so neither defines `compileQuote()`;
`compileBagExecutionCandidates()` simply falls back to their `compile()` for
both, which is safe.

**`BagRouterProvider` is the provider this seam exists for.** Its `compile()`
calls a server-held EIP-712 plan signer (`config.signPlan`) exactly once,
producing a real signed `ExecutionPlan` and the corresponding `execute()`
calldata — this must never happen for a route the user hasn't chosen yet.
`BagRouterProvider.compileQuote()` builds the identical unsigned plan
(same real leg-builder quotes, same `expectedOutputs`, same
`executionPlanHash`) but stops there: `signPlan()` is never called, no
`execute()` calldata is encoded, and `transactions` is returned empty (there
is nothing valid to encode without a signature). `providerMetadata` on a
`compileQuote()` result carries no `signedPlan` — only a `quoteOnly: true`
marker and the wallet the eventual signed plan would bind to, for
server-side debugging. Selecting a `bag-router` candidate always triggers a
fresh `compile()` call through the existing `compileBagExecution()` path
(section E) — that is the one and only place `signPlan()` may run for a
given purchase.

This is what keeps `POST /purchase-options` (the route backed by
`getPurchaseOptionsForUser()`, section H) side-effect-free: running a pure
comparison, before the user has picked anything, never mints a real signed
execution authorization.

---

## H. Server response shape (`getPurchaseOptionsForUser()`)

```ts
// lib/server/purchase-execution.ts

export interface PurchaseOptionsResult {
  candidates: ExecutionCandidateView[]; // executable (COMPILED) candidates, sanitized
  failed: ExecutionCandidateView[];     // never dropped — "N of M routes available"
  winners: CandidateRankingResult['winners'];
  executionPlanHash: string;
  compiledAt: number; // batch-level: when this whole comparison was run
}

export async function getPurchaseOptionsForUser(
  params: Omit<CreatePurchaseIntentParams, 'selectedProviderId'>
): Promise<PurchaseExecutionOutcome<PurchaseOptionsResult>>;
```

`getPurchaseOptionsForUser()`:

- Never persists anything (no `insertPurchaseIntent()`, no
  `findActivePurchaseIntentForBag()` check) — a pure read has no business
  colliding with the write-side "one active intent per bag" guard.
- Reuses every other step (bag/version/registry/input-asset/NAV/allocation,
  graph+intent+provider-registry construction, Bag Router on-chain-id
  wiring) from the exact same shared helpers `createPurchaseIntentForUser()`
  uses — there is no second, independently-implemented version of any of
  this.
- Runs `compileBagExecutionCandidates()` → `annotateCandidateMetrics()` →
  `rankCandidates()`, in that order, then maps `executable`/`failed` through
  `toExecutionCandidateView()` before returning. **This is the point where
  the raw `compiled` object is stripped** — the client only ever receives
  the sanitized view described in section A, never the raw candidate array.
- Returns `PROVIDER_SELECTION_UNAVAILABLE` when the compiler flag
  (`isBagExecutionCompilerEnabled()`) is off — there is no legacy
  candidate-comparison behavior to fall back to.

The client hook (`hooks/use-purchase-options.ts`) wraps `POST
/api/bags/:id/purchase-options`, treating every non-2xx response identically
("no comparison available right now" — `options` stays `null`, the modal
simply renders no comparison UI) rather than trying to distinguish why.

---

## I. Known, current open items (only genuinely unresolved ones)

1. **Composer gas-price read.** `gasLimitRaw` is preserved (D.2) but not yet
   converted to a comparable `estimatedGasUsd` — needs one live gas-price
   read, reusing the existing `PriceProvider`. Until this lands, `lowestGas`
   effectively only ever compares `lifi-sequential` candidates (or wins
   trivially with one executable candidate).
2. **BAG Router gas estimation (D.3).** Would require a new
   `estimateGas`/`publicClient.estimateGas` RPC call against the fully built
   transaction — not yet implemented; `bag-router` candidates report
   `estimatedGasUsd: null` unconditionally today.
3. **Rate limits.** A worst case of up to ~12 concurrent LI.FI-bound network
   calls per comparison (3 providers × ≤4 legs) has not been validated
   against LI.FI's actual plan/quota.
4. **Composer eligibility vs. router eligibility overlap.** When both
   `bag-router` and `lifi-composer` are eligible for the same graph, the user
   is choosing between BAG's own trust boundary and a third-party
   aggregator with no comparable `estimatedGasUsd` today (item 1 above) —
   whether `estimatedOutputUsd`-only ranking is a good enough signal for
   that choice, or whether the two should be visually distinguished as
   "different trust models" regardless of metrics, is still an open product
   question.
5. **Per-candidate realized slippage/price-impact.** `requestedSlippageBps`
   is a requested tolerance, identical across candidates from the same
   graph, and is never used to rank. A genuine realized-slippage comparison
   (using each candidate's own `estimatedOutputUsd` against a slippage-free
   reference price) is possible with data already available but has not been
   built.

**Settled, no longer open** (kept here only so a reader of an older revision
of this doc doesn't go looking for them as live decisions): whether to add a
`balanced`/weighted score (decided against — see section C); the value of
`CANDIDATE_TTL_MS` (decided: `30_000`, `candidate-types.ts`); whether
`lifi-sequential` duration aggregates via `sum()` or `max()` (decided:
`sum()` — see D.1); whether a partial-leg `lifi-sequential` compile can be
shown as a normal COMPILED candidate (decided: no — see
`candidate-completeness.ts`, section B).

---

## J. Changelog

**Rev 1–3 (pre-implementation design review).** Five inconsistencies caught
before any code was written and fixed in the original proposal: the
Composer gas-field contradiction between sections, the "Cheapest" label
conflating gas with total cost, `totalQuotedFeeUsd` conflating gas with total
fee, the sequential duration aggregation bug (`max()` vs `sum()`), and
partial-leg LI.FI Sequential compiles being silently accepted as fully
COMPILED candidates. All five landed as designed; see the corresponding
sections above (B, C, D.1) for how each is implemented today.

**Rev 4 (this revision) — documentation sync against shipped code, plus one
correctness fix found during that sync.**

- Rewrote every section against the actual shipped files rather than the
  pre-implementation proposal. Notable corrections:
  - Removed `balanced` and `other` from the ranking API description — the
    shipped `rankCandidates()` never had them; only `executable` / `failed`
    / `winners` over `bestOutput` / `lowestGas` / `fastest` exist.
  - Corrected `compiledAt` from "batch timestamp" to "per-candidate
    completion timestamp" (`ExecutionCandidateSet.compiledAt` is the
    separate batch-level field).
  - Documented `ExecutionCandidateView` and the client-response sanitization
    step (section A/H) — the raw `compiled` object, and unfiltered
    `failureReason.message`, are never sent to the browser.
  - Documented the `compile()`/`compileQuote()` signing-boundary split for
    Bag Router (section G) — comparison requests never trigger
    `signPlan()`.
  - Corrected Composer's status from "gas available now (small follow-up)"
    to "raw fields preserved, USD conversion not yet implemented" (D.2/D.6)
    — the passthrough shipped, the gas-price read did not.
  - Updated the staleness section (E) with the two request-race fixes that
    shipped in `hooks/use-purchase-options.ts` after the original proposal
    was written.
  - Trimmed "Unresolved questions" down to the items that are still actually
    open (section I), moving settled ones (no `balanced`, `CANDIDATE_TTL_MS`
    value, `sum()` vs `max()`, partial-compile handling) out of that list.
- **Ranking correctness fix.** `rankCandidates()` (`candidate-ranking.ts`)
  previously produced a winner for `lowestGas`/`fastest`/`bestOutput` by
  silently excluding any candidate whose metric was `null` and crowning
  whichever remaining candidate had the best number — e.g. candidate A with
  `estimatedGasUsd: null` and candidate B with `estimatedGasUsd: 0.50` would
  be reported as `lowestGas: B`, implying a real comparison had taken place
  when A was never actually measured against B. Fixed so that a category
  only produces a winner when **every** executable candidate reports a real
  value for that metric; otherwise the category is simply absent from
  `winners`, exactly like the existing "no candidate has this metric at all"
  case. Applied uniformly to all three categories. Covered by new tests in
  `lib/execution/__tests__/candidate-ranking.test.ts` (the two pre-existing
  tests that encoded the old, misleading behavior for `lowestGas` and
  `fastest` were updated to assert the corrected "no winner" outcome; all
  other existing ranking tests were left unchanged and still pass).

---

This document describes the current implementation as of this revision;
source of truth is the code/tests.
