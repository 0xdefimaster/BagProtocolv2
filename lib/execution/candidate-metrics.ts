import { AssetIdentity } from '@/types/basket-protocol';
import { PriceProvider, PriceUnavailableError } from '@/lib/domain/basket-protocol/pricing/provider';
import { toProtocolPrice } from '@/lib/domain/basket-protocol/pricing/price-precision';
import { formatNavValue, NAV_VALUE_DECIMALS } from '@/lib/domain/basket-protocol/nav/nav';
import { assetIdentityKey } from '@/lib/domain/basket-protocol/asset-identity';
import { CompiledExecution, ExpectedOutput, OutputQuoteBasis } from './types';
import { CandidateMetrics, ExecutionCandidate, ExecutionCandidateSet } from './candidate-types';
import { LegQuoteResult } from './providers/lifi-sequential-provider';
import { BAG_ROUTER_PROVIDER_ID } from './providers/bag-router-provider';

// -----------------------------------------------------------------------------
// lib/execution/candidate-metrics.ts
//
// Phase 1 checkpoints 3/4/4b — annotates the `ExecutionCandidate[]`
// `compileBagExecutionCandidates()` (compiler.ts) already produced with
// `CandidateMetrics` (candidate-types.ts). Deliberately a SEPARATE pass
// (spec item 4: no second simulation, no `simulateExecutionCandidates()`)
// — every number here comes from data a provider's `compile()` ALREADY
// returned; this module never makes another network/RPC call to a
// provider. The only I/O this file performs is `PriceProvider.getPrice()`
// (existing repository infrastructure — spec item 5: "Do not introduce a
// new price service").
//
// UNIFORM vs PROVIDER-SPECIFIC, kept deliberately separate:
//   - OUTPUT metrics are priced the SAME WAY for every provider — raw
//     amount × `getPriceProvider()`'s own price — but there are TWO of them,
//     because providers report two different things (see `ExpectedOutput`,
//     types.ts):
//       `quotedOutputUsd`            ← `quotedOutputRaw` (expected; basis
//                                      PROVIDER_QUOTE or SIMULATION)
//       `minimumGuaranteedOutputUsd` ← `minimumGuaranteedOutputRaw`
//                                      (enforced floor; null if any leg
//                                      has none)
//     They are never merged into one "output" figure: ranking a Composer
//     simulation against a LI.FI slippage floor made the former look better
//     by roughly the slippage tolerance, regardless of real execution
//     quality. A provider's own self-reported USD figure (LI.FI's
//     `toAmountUSD`, Composer's `priceImpact.outputValueUsd`) is NEVER used,
//     on purpose — different pricing sources at different times.
//   - `estimatedGasUsd`/`estimatedDurationSeconds` are PROVIDER-SPECIFIC:
//     only LI.FI Sequential's `compile()` result carries a real one (see
//     `extractSequentialTiming()` below). Composer's `gasLimit` is a gas
//     UNIT, never converted to USD without a live gas-price read this
//     phase deliberately doesn't add (spec item 6) — it is surfaced only
//     in `providerMetadata.gasLimitRaw`, kept OUT of `estimatedGasUsd` so
//     nothing ever compares a unit count against a dollar figure. BAG
//     Router reports neither (item 6's explicit "may remain null").
//
// NO FABRICATED VALUES, anywhere in this file: every field is `null` when
// the underlying data isn't genuinely available — see each function's own
// comment for the specific "why null here" reasoning.
// -----------------------------------------------------------------------------

export interface AnnotateCandidateMetricsOptions {
  /** Every leg in the graph these candidates were compiled from shares one requested slippage tolerance in practice (a single deposit's per-leg `slippageBps` all come from the same `DEFAULT_COMPOSER_SLIPPAGE_BPS`/intent default — see plan.ts) — passed straight through for display (spec item 7), never used for ranking. */
  requestedSlippageBps: number;
  /** The SAME `PriceProvider` every other real-money path in this codebase uses (`getPriceProvider()`) — this module never constructs its own. */
  priceProvider: PriceProvider;
  /**
   * Synchronous decimals lookup for an `ExpectedOutput.asset`. Deliberately
   * sync, not another DB call: every asset a candidate can possibly target
   * is already one of the recipe's own `RecipeAsset[]` (which carries
   * `decimals`) or the purchase's input asset — both already fetched by
   * the caller (`purchase-execution.ts`/the new purchase-options service)
   * before candidates are even compiled. Returning `null` for an
   * unresolvable asset makes the output USD metrics `null` for any candidate
   * that needed it, rather than silently 0 or thrown.
   */
  resolveAssetDecimals: (asset: AssetIdentity) => number | null;
}

/**
 * Annotates every COMPILED candidate in `candidateSet` with real metrics,
 * leaving `metrics: null` on every FAILED one untouched (nothing to
 * measure — spec item 5's "correct decimals handling" / "no fabricated
 * zero values" applies just as much to "don't invent metrics for a
 * candidate that didn't compile" as it does to a missing price). Price
 * lookups are DEDUPED across every candidate + leg targeting the same
 * asset (a Composer and a Sequential candidate for the same graph very
 * often share every target asset) — one `getPrice()` call per distinct
 * asset, not one per leg.
 */
export async function annotateCandidateMetrics(
  candidateSet: ExecutionCandidateSet,
  options: AnnotateCandidateMetricsOptions
): Promise<ExecutionCandidateSet> {
  // Caches the in-flight PROMISE, not just the resolved value — every
  // candidate is annotated concurrently (`Promise.all` below), so two
  // candidates sharing an asset can both reach this function before either
  // resolution lands. Caching only a resolved value would race and still
  // fire two real `getPrice()` calls; caching the promise itself means the
  // second caller just awaits the first's in-flight request.
  const priceCache = new Map<string, Promise<string | null>>(); // assetIdentityKey -> AssetPrice.price, or null if unavailable
  const getCachedPrice = (asset: AssetIdentity): Promise<string | null> => {
    const key = assetIdentityKey(asset);
    const cached = priceCache.get(key);
    if (cached) return cached;
    const pending = options.priceProvider.getPrice(asset).then(
      (price) => price.price,
      (err) => {
        if (err instanceof PriceUnavailableError) return null;
        throw err; // A real infra failure, not "unpriced" — never swallowed into a silent null (same fail-closed convention as nav.ts).
      }
    );
    priceCache.set(key, pending);
    return pending;
  };

  const candidates = await Promise.all(
    candidateSet.candidates.map(async (candidate): Promise<ExecutionCandidate> => {
      if (candidate.compile.status !== 'COMPILED' || !candidate.compiled) return candidate;

      const outputs = candidate.compiled.expectedOutputs;
      const quotedOutputUsd = await computeOutputUsd(outputs, (o) => o.quotedOutputRaw, options.resolveAssetDecimals, getCachedPrice);
      const minimumGuaranteedOutputUsd = await computeOutputUsd(outputs, (o) => o.minimumGuaranteedOutputRaw, options.resolveAssetDecimals, getCachedPrice);
      const timing = extractProviderReportedMetrics(candidate.providerId, candidate.compiled);

      const metrics: CandidateMetrics = {
        quotedOutputUsd,
        quotedOutputBasis: summarizeQuoteBasis(outputs),
        minimumGuaranteedOutputUsd,
        estimatedGasUsd: timing.estimatedGasUsd,
        estimatedDurationSeconds: timing.estimatedDurationSeconds,
        requestedSlippageBps: options.requestedSlippageBps,
        ...(timing.providerMetadata ? { providerMetadata: timing.providerMetadata } : {}),
      };

      return { ...candidate, metrics };
    })
  );

  return { ...candidateSet, candidates };
}

/** One basis for the whole candidate, or `'MIXED'` when its legs disagree (such a candidate is never ranked on quoted output). */
function summarizeQuoteBasis(outputs: ExpectedOutput[]): OutputQuoteBasis | 'MIXED' {
  const bases = new Set(outputs.map((o) => o.quotedOutputBasis));
  return bases.size === 1 ? [...bases][0] : 'MIXED';
}

/**
 * Sums every leg's `pick(output)` raw amount × its asset's price, at
 * `NAV_VALUE_DECIMALS`-scaled bigint precision — the exact same
 * (quantityRaw, decimals, price) -> scaled-value formula
 * `lib/domain/basket-protocol/nav/nav.ts`'s `toNavValue()` uses for NAV,
 * reproduced here (rather than importing that module-private function)
 * so this file has no dependency on NAV's own error types
 * (`StalePriceError`, share-supply concerns) that don't apply to a
 * pre-execution estimate. `BigInt(raw)` is safe without a format check
 * here: metrics only ever run on a COMPILED candidate, and
 * `validateCandidateCompleteness()` (candidate-completeness.ts) already
 * guarantees every such candidate's quoted/guaranteed amounts are genuine
 * positive integer strings (or, for the guarantee, `null`).
 *
 * Returns `null` — never a partial sum — the instant ANY leg has no amount
 * for `pick` (e.g. no guaranteed floor), no resolvable decimals, or no
 * available price, so a total is never silently incomplete. An empty output
 * list is also `null` (nothing was measured), never a fabricated `0`.
 */
async function computeOutputUsd(
  outputs: ExpectedOutput[],
  pick: (output: ExpectedOutput) => string | null,
  resolveDecimals: (asset: AssetIdentity) => number | null,
  getPrice: (asset: AssetIdentity) => Promise<string | null>
): Promise<number | null> {
  if (outputs.length === 0) return null;
  let totalScaled = BigInt(0);
  for (const output of outputs) {
    const rawAmount = pick(output);
    if (rawAmount === null) return null;
    const decimals = resolveDecimals(output.asset);
    if (decimals === null) return null;
    const price = await getPrice(output.asset);
    if (price === null) return null;
    const priceScaled = toProtocolPrice(price, NAV_VALUE_DECIMALS);
    const raw = BigInt(rawAmount);
    totalScaled += (raw * priceScaled) / BigInt(10) ** BigInt(decimals);
  }
  // A single float conversion at the very end, for a DISPLAY estimate —
  // never fed back into further money math (same "protocol precision
  // internally, display precision at the boundary" split price-precision.ts
  // itself draws between toProtocolPrice/toDisplayPrice).
  return Number(formatNavValue(totalScaled, NAV_VALUE_DECIMALS));
}

interface ProviderReportedTiming {
  estimatedGasUsd: number | null;
  estimatedDurationSeconds: number | null;
  providerMetadata?: Record<string, unknown>;
}

const NO_TIMING: ProviderReportedTiming = { estimatedGasUsd: null, estimatedDurationSeconds: null };

/** Dispatches to the one provider-specific extractor that has real data — every other provider (including any future one this file doesn't know about yet) gets `NO_TIMING`, never a guessed value. */
function extractProviderReportedMetrics(providerId: string, compiled: CompiledExecution): ProviderReportedTiming {
  if (providerId === 'lifi-sequential') return extractSequentialTiming(compiled);
  if (providerId === 'lifi-composer') return extractComposerTiming(compiled);
  if (providerId === BAG_ROUTER_PROVIDER_ID) return NO_TIMING; // spec item 6 — explicitly no gas/duration estimate for the router this phase.
  return NO_TIMING;
}

/** Mirrors `@lifi/types@18.4.0`'s actual `Estimate` shape (verified against the installed package, not assumed) — kept minimal/local rather than importing the SDK type here, since this file only ever reads three fields off it. */
interface LiFiEstimateShape {
  /** `type` is `@lifi/types@18.4.0`'s real discriminant (verified against the installed package) — `'SUM'` is documented by LI.FI as "an aggregate of the other entries", so an array containing a `SUM` alongside `APPROVE`/`SEND`/`FEE` entries must use ONLY the `SUM` one; summing everything would double- (or triple-) count. See `sumGasCostsUsd()` below. */
  gasCosts?: { type?: string; amountUSD?: string }[];
  feeCosts?: { amountUSD?: string }[];
  /** Required (not optional) on the installed SDK's own `Estimate` type — every real `LiFiStep` this app receives from `getQuote()` has one. */
  executionDuration?: number;
}

function readLiFiEstimate(lifiStep: unknown): LiFiEstimateShape | null {
  if (!lifiStep || typeof lifiStep !== 'object') return null;
  const estimate = (lifiStep as { estimate?: unknown }).estimate;
  if (!estimate || typeof estimate !== 'object') return null;
  return estimate as LiFiEstimateShape;
}

function parseUsd(value: string | undefined): number | null {
  if (value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Sums one leg's `gasCosts` entries into a single USD figure, WITHOUT
 * double-counting. `@lifi/types@18.4.0`'s own `GasCost.type` is
 * `'SUM' | 'APPROVE' | 'SEND' | 'FEE'`; LI.FI's docs describe `'SUM'` as
 * "an aggregate of the other entries" and note it is not returned today
 * (only `'SEND'` is, in practice) but say to "handle APPROVE, FEE, and SUM
 * if they appear, so your integration stays forward-compatible". Naively
 * summing every entry regardless of `type` would therefore double-count
 * the moment LI.FI starts returning a `SUM` entry alongside its
 * components (`SUM` + `APPROVE` + `SEND` all present at once) — this
 * candidate's `estimatedGasUsd`, and the "Lowest Gas" ranking built on it
 * (candidate-ranking.ts), would silently overstate real gas cost. If a
 * `SUM` entry is present, it alone represents the total; anything else in
 * the array is a component already folded into it. Only when NO `SUM`
 * entry is present (today's actual behavior) do the individual entries
 * get summed, since they are then the only cost information available.
 */
function sumGasCostsUsd(gasCosts: { type?: string; amountUSD?: string }[] | undefined): { total: number; have: boolean } {
  const entries = gasCosts ?? [];
  const sumEntry = entries.find((g) => g.type === 'SUM');
  const entriesToUse = sumEntry ? [sumEntry] : entries;

  let total = 0;
  let have = false;
  for (const entry of entriesToUse) {
    const usd = parseUsd(entry.amountUSD);
    if (usd !== null) {
      total += usd;
      have = true;
    }
  }
  return { total, have };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * `lib/execution/providers/lifi-sequential-provider.ts` puts every leg's
 * raw `LiFiStep` in `providerMetadata.legResults[legId].lifiStep` — the
 * SAME object `quoteRealSwapStep()` (lifi-purchase-quote.ts) already got
 * back from `getQuote()`. No second quote call; this only reads what's
 * already there.
 *
 * DURATION IS SUMMED, NOT MAXED: `hooks/use-purchase-execution.ts`'s own
 * module doc states plainly that the fallback (non-Composer) path executes
 * every SWAP step "ONE AT A TIME" ("SEQUENTIAL, not parallel, in the
 * fallback case" — see that file's header comment) so the wallet only ever
 * shows one signature prompt at once. A wall-clock estimate for a
 * genuinely serialized process is the SUM of its steps' durations, never
 * the slowest one — `max()` would be the right aggregation for legs that
 * actually ran in parallel, which is not what this codebase's execution
 * hook does today.
 */
function extractSequentialTiming(compiled: CompiledExecution): ProviderReportedTiming {
  const legResults = (compiled.providerMetadata?.legResults ?? {}) as Record<string, LegQuoteResult>;
  let gasUsdTotal = 0;
  let feeUsdTotal = 0;
  let durationTotal = 0;
  let haveGas = false;
  let haveFee = false;
  let haveDuration = false;

  for (const output of compiled.expectedOutputs) {
    const legResult = legResults[output.legId];
    if (!legResult || !legResult.ok) continue; // Should not happen for a COMPILED candidate (completeness already required every leg to be `ok`), but never assumed.
    const estimate = readLiFiEstimate(legResult.lifiStep);
    if (!estimate) continue;

    if (typeof estimate.executionDuration === 'number' && Number.isFinite(estimate.executionDuration)) {
      durationTotal += estimate.executionDuration;
      haveDuration = true;
    }
    for (const feeCost of estimate.feeCosts ?? []) {
      const usd = parseUsd(feeCost.amountUSD);
      if (usd !== null) {
        feeUsdTotal += usd;
        haveFee = true;
      }
    }
    const gasResult = sumGasCostsUsd(estimate.gasCosts);
    if (gasResult.have) {
      gasUsdTotal += gasResult.total;
      haveGas = true;
    }
  }

  return {
    estimatedGasUsd: haveGas ? round2(gasUsdTotal) : null,
    estimatedDurationSeconds: haveDuration ? durationTotal : null,
    providerMetadata: haveFee ? { estimatedFeeUsd: round2(feeUsdTotal) } : undefined,
  };
}

/**
 * Composer never reports `estimatedGasUsd`/`estimatedDurationSeconds` —
 * `gasLimit` (lifi-composer-provider.ts's `providerMetadata.gasLimitRaw`)
 * is a gas UNIT count, not a USD figure (spec item 6's explicit warning
 * against confusing the two), and the installed Compose SDK's compile
 * response has no execution-duration field to read at all (verified
 * against `@lifi/compose-spec@0.5.0`'s actual types — see
 * lifi-composer-adapter.ts). `gasLimitRaw`/`priceImpact`/`fees` are
 * surfaced as-is in `providerMetadata` for a provider-specific UI detail
 * row (spec item 6's own instruction), never forced into a universal
 * numeric field they don't fit.
 */
function extractComposerTiming(compiled: CompiledExecution): ProviderReportedTiming {
  const meta = compiled.providerMetadata ?? {};
  const providerMetadata: Record<string, unknown> = {};
  if (typeof meta.gasLimitRaw === 'string') providerMetadata.gasLimitRaw = meta.gasLimitRaw;
  if (meta.priceImpact && typeof meta.priceImpact === 'object') providerMetadata.priceImpact = meta.priceImpact;
  if (Array.isArray(meta.fees) && meta.fees.length > 0) providerMetadata.fees = meta.fees;

  return {
    estimatedGasUsd: null,
    estimatedDurationSeconds: null,
    providerMetadata: Object.keys(providerMetadata).length > 0 ? providerMetadata : undefined,
  };
}
