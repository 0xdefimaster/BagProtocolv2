import type { RebalanceFrequency, UnroutablePolicy } from './basket-protocol';

// -----------------------------------------------------------------------------
// Strategy Policy — the machine-readable rules a Bag runs under, each with
// where its value comes from and who makes it hold. Built from the rules BAG
// already applies (lib/server/strategy-policy.ts); no placeholder rules.
// Used by the Strategy Passport (GET /api/bags/:id/passport) and by
// validate_bag (POST /api/bags/validate), so both read a rule the same way.
// Shared enums for data provenance live here too.
// -----------------------------------------------------------------------------

// 2: rules carry `scope`; the price-impact consent ceiling is its own rule
// (`priceImpactConsentCeilingBps`, SERVER_ENFORCED) instead of a field on the
// Composer-enforced `maxPriceImpactBps`.
export const STRATEGY_POLICY_SCHEMA_VERSION = 2;

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
 * - `SERVER_ENFORCED`: BAG's backend refuses before it writes or builds a transaction. Not on-chain, not
 *   immutable (a BAG release can change it) and not binding on a direct database write by an operator.
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

/** Which flows a rule applies to. */
export type PolicyFlow = 'VERSION' | 'PURCHASE' | 'REDEEM';

/** Execution providers BAG can record. Unknown values from future providers map to `UNKNOWN`. */
export type ExecutionProviderKind = 'BAG_ROUTER' | 'LIFI_COMPOSER' | 'LIFI_SEQUENTIAL' | 'UNKNOWN';

export interface PolicyScope {
  flows: PolicyFlow[];
  /** Null: applies whichever provider executes. Otherwise only these providers apply the rule. */
  providers: ExecutionProviderKind[] | null;
}

export interface PolicyRule<T> {
  value: T;
  scope: PolicyScope;
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
  /**
   * 0 means no minimum. Compared against the payment-token amount of a purchase (USDG, counted 1:1 as
   * USD — no price conversion), at purchase time only; validate_bag checks the value itself, not a deposit.
   */
  minInvestmentUsd: PolicyRule<number> & { measuredAs: 'PAYMENT_TOKEN_AMOUNT' };
  /** Per swap of a purchase; each swap's minimum output is in the transaction. Redeem swaps use the routing provider's own slippage. */
  maxSlippageBps: PolicyRule<number>;
  /** Whole purchase, LI.FI Composer only: Composer refuses to compile above it. Nothing checks it on-chain. */
  maxPriceImpactBps: PolicyRule<number>;
  /** The most a buyer may accept when Composer reports a higher impact; BAG's backend refuses more. */
  priceImpactConsentCeilingBps: PolicyRule<number>;
  /** On realized profit at redemption. Capped by the database at `maxBps`. */
  performanceFeeBps: PolicyRule<number> & { maxBps: number };
  /** What a purchase does with assets that have no route; skipped assets may total at most `maxUnroutableWeightBps`. */
  noRouteAssetPolicy: PolicyRule<UnroutablePolicy> & { maxUnroutableWeightBps: number };
  rebalanceRule: PolicyRule<{ frequency: RebalanceFrequency; driftThresholdBps: number }>;
  compositionChanges: PolicyRule<CompositionChangeMode>;
}

export type StrategyPolicyKey = Exclude<keyof StrategyPolicy, 'schemaVersion'>;
