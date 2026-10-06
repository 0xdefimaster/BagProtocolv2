import type { BagDefinition, Mutability, NoRouteAssetPolicy, RebalanceFrequency, StrategyKind } from './types';

// -----------------------------------------------------------------------------
// v1 default resolution. NORMATIVE and FROZEN.
//
// A `null` rule in a definition means "not set by the creator". It is never
// written into the document or the hash. Every reader, however, must give it
// the SAME meaning, or one definitionHash would mean two different strategies.
// So the meaning of `null` is part of the v1 standard: the table below, applied
// by `resolveV1Rules`. Changing any value is bag.json/v2.
//
// These values equal BAG's defaults at the time v1 was frozen (a test in the
// app keeps the two equal).
// -----------------------------------------------------------------------------

export const V1_DEFAULTS = Object.freeze({
  kind: 'STATIC_BASKET' as StrategyKind,
  mutability: 'MUTABLE' as Mutability,
  minWeightBps: 100,
  maxWeightBps: 7000,
  /** `maxAssets: null` allows max(asset count, 10). */
  maxAssetsFloor: 10,
  /** No minimum. */
  minInvestmentAmount: '0',
  swapSlippageBps: 100,
  rebalanceFrequency: 'THRESHOLD_ONLY' as RebalanceFrequency,
  driftThresholdBps: 500,
  /** No fee. */
  performanceFeeBps: 0,
  /** Refuse a purchase while any asset has no route. */
  noRouteAssetPolicy: 'BLOCK' as NoRouteAssetPolicy,
});

export type RuleSource = 'DECLARED' | 'V1_DEFAULT';

export interface Resolved<T> {
  value: T;
  /** DECLARED: the creator set it; V1_DEFAULT: `null` in the definition, resolved by the table above. */
  source: RuleSource;
}

/** The effective v1 rules of a definition: what a strategy MEANS, independent of who reads it. */
export interface ResolvedV1Rules {
  kind: Resolved<StrategyKind>;
  mutability: Resolved<Mutability>;
  minWeightBps: Resolved<number>;
  maxWeightBps: Resolved<number>;
  maxAssets: Resolved<number>;
  minInvestmentAmount: Resolved<string>;
  swapSlippageBps: Resolved<number>;
  rebalanceFrequency: Resolved<RebalanceFrequency>;
  driftThresholdBps: Resolved<number>;
  performanceFeeBps: Resolved<number>;
  noRouteAssetPolicy: Resolved<NoRouteAssetPolicy>;
}

const pick = <T>(declared: T | null | undefined, fallback: T): Resolved<T> =>
  declared === null || declared === undefined ? { value: fallback, source: 'V1_DEFAULT' } : { value: declared, source: 'DECLARED' };

/** Resolves every `null` rule with the frozen v1 table. Pure; never changes the definition. */
export function resolveV1Rules(def: BagDefinition): ResolvedV1Rules {
  const r = def.rules;
  return {
    kind: pick(def.kind, V1_DEFAULTS.kind),
    mutability: pick(def.mutability, V1_DEFAULTS.mutability),
    minWeightBps: pick(r.weightBounds.minBps, V1_DEFAULTS.minWeightBps),
    maxWeightBps: pick(r.weightBounds.maxBps, V1_DEFAULTS.maxWeightBps),
    maxAssets: pick(r.maxAssets, Math.max(def.assets.length, V1_DEFAULTS.maxAssetsFloor)),
    minInvestmentAmount: pick(r.minInvestment?.amount, V1_DEFAULTS.minInvestmentAmount),
    swapSlippageBps: pick(r.swapSlippageBps, V1_DEFAULTS.swapSlippageBps),
    rebalanceFrequency: pick(r.rebalance?.frequency, V1_DEFAULTS.rebalanceFrequency),
    driftThresholdBps: pick(r.rebalance?.driftThresholdBps, V1_DEFAULTS.driftThresholdBps),
    performanceFeeBps: pick(r.performanceFeeBps, V1_DEFAULTS.performanceFeeBps),
    noRouteAssetPolicy: pick(r.noRouteAssetPolicy, V1_DEFAULTS.noRouteAssetPolicy),
  };
}
