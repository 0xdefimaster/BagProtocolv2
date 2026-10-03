import type { RebalanceFrequency, UnroutablePolicy } from './basket-protocol';

// -----------------------------------------------------------------------------
// Strategy Policy — the machine-readable rules a Bag runs under, each with
// where its value comes from and who makes it hold. Built from the rules BAG
// already applies (lib/server/strategy-policy.ts); no placeholder rules.
// Used by the Strategy Passport (GET /api/bags/:id/passport) and by
// validate_bag (POST /api/bags/validate), so both read a rule the same way.
// Shared enums for data provenance live here too.
// -----------------------------------------------------------------------------

export const STRATEGY_POLICY_SCHEMA_VERSION = 1;

/**
 * Where a piece of data comes from:
 * - `ONCHAIN`: recorded from a confirmed transaction/event; checkable on-chain via its tx hash.
 * - `DATABASE`: BAG's database is the source of truth.
 * - `BAG_DERIVED`: computed by BAG from other data (NAV, returns, prices).
 * - `BAG_ATTESTED`: BAG's own claim that cannot be checked independently (e.g. a route check).
 */
export type DataSource = 'ONCHAIN' | 'DATABASE' | 'BAG_DERIVED' | 'BAG_ATTESTED';

/**
 * Who makes a rule hold:
 * - `ONCHAIN_ENFORCED`: the executed transaction reverts otherwise.
 * - `COMPOSER_ENFORCED`: LI.FI Composer refuses to compile the transaction otherwise.
 * - `DATABASE_TRIGGER`: a Postgres constraint/trigger rejects the write.
 * - `SERVER_ENFORCED`: BAG's server refuses before building anything (not a chain guarantee).
 * - `ATTESTED_ONLY`: BAG states it; nothing blocks on it.
 * - `DECLARED_ONLY`: the creator states it; nothing executes it today.
 */
export type Enforcement = 'ONCHAIN_ENFORCED' | 'COMPOSER_ENFORCED' | 'DATABASE_TRIGGER' | 'SERVER_ENFORCED' | 'ATTESTED_ONLY' | 'DECLARED_ONLY';

/** Who chose the value: the creator's recipe, a BAG protocol constant/default, or LI.FI Composer's default. */
export type RuleValueSource = 'CREATOR_RECIPE' | 'BAG_PROTOCOL' | 'LIFI_COMPOSER';

/** `LOCKED`: can no longer change. `NOT_EXECUTED`: stated but nothing acts on it today. */
export type RuleStatus = 'ACTIVE' | 'LOCKED' | 'NOT_EXECUTED';

/** Where in BAG's flow the rule is checked. */
export type EnforcementPoint = 'VERSION_CREATE' | 'PURCHASE_CREATE' | 'PURCHASE_TRANSACTION' | 'COMPOSER_COMPILE' | 'DATABASE_WRITE';

export interface PolicyRule<T> {
  value: T;
  source: RuleValueSource;
  enforcement: Enforcement;
  enforcedAt: EnforcementPoint[];
  status: RuleStatus;
}

export type CompositionChangeMode = 'IMMUTABLE' | 'ONCHAIN_VERSION_ONLY' | 'CREATOR_EDITABLE';

export interface StrategyPolicy {
  schemaVersion: typeof STRATEGY_POLICY_SCHEMA_VERSION;
  maxSingleAssetWeightBps: PolicyRule<number>;
  minSingleAssetWeightBps: PolicyRule<number>;
  maxAssets: PolicyRule<number>;
  /** USD; 0 means no minimum. */
  minInvestmentUsd: PolicyRule<number>;
  /** Per swap; each swap's minimum output is in the transaction. */
  maxSlippageBps: PolicyRule<number>;
  /** Whole purchase. A buyer may accept more, up to `consentCeilingBps` (enforced by BAG's server). */
  maxPriceImpactBps: PolicyRule<number> & { consentCeilingBps: number };
  /** On realized profit at redemption. Capped by the database at `maxBps`. */
  performanceFeeBps: PolicyRule<number> & { maxBps: number };
  /** What a purchase does with assets that have no route; skipped assets may total at most `maxUnroutableWeightBps`. */
  noRouteAssetPolicy: PolicyRule<UnroutablePolicy> & { maxUnroutableWeightBps: number };
  rebalanceRule: PolicyRule<{ frequency: RebalanceFrequency; driftThresholdBps: number }>;
  compositionChanges: PolicyRule<CompositionChangeMode>;
}

export type StrategyPolicyKey = Exclude<keyof StrategyPolicy, 'schemaVersion'>;
