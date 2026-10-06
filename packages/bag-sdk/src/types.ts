import type { BagChain } from './chains';

// -----------------------------------------------------------------------------
// bag.json v1 document types. Spec: packages/bag-sdk/README.md and
// docs/BAG_JSON_V1_DESIGN.md. The JSON Schema of a document served by BAG is
// docs/schemas/bag.v1.schema.json.
// -----------------------------------------------------------------------------

export const BAG_JSON_FORMAT_VERSION = 1;
/** Domain prefix hashed in front of the canonical definition. */
export const BAG_JSON_HASH_DOMAIN = 'bag.json/v1\n';

export const STRATEGY_KINDS = ['STATIC_BASKET'] as const;
export const MUTABILITIES = ['MUTABLE', 'IMMUTABLE'] as const;
export const REBALANCE_FREQUENCIES = ['MANUAL', 'DAILY', 'WEEKLY', 'MONTHLY', 'THRESHOLD_ONLY'] as const;
export const NO_ROUTE_ASSET_POLICIES = ['BLOCK', 'HOLD_INPUT', 'REFUND'] as const;

export type StrategyKind = (typeof STRATEGY_KINDS)[number];
export type Mutability = (typeof MUTABILITIES)[number];
export type RebalanceFrequency = (typeof REBALANCE_FREQUENCIES)[number];
export type NoRouteAssetPolicy = (typeof NO_ROUTE_ASSET_POLICIES)[number];

/** One asset: identity (chain + address), the unit of its amounts (decimals) and its target weight. */
export interface BagDefinitionAsset {
  chain: BagChain;
  address: string;
  decimals: number;
  weightBps: number;
}

/**
 * The hashed part of bag.json. Every key is required; `null` means "not set by the creator" and is never
 * replaced by a default.
 */
export interface BagDefinition {
  kind: StrategyKind | null;
  chain: BagChain;
  mutability: Mutability | null;
  assets: BagDefinitionAsset[];
  rules: {
    weightBounds: { minBps: number | null; maxBps: number | null };
    maxAssets: number | null;
    minInvestment: { amount: string; measuredAs: 'PAYMENT_TOKEN_AMOUNT' } | null;
    swapSlippageBps: number | null;
    rebalance: { frequency: RebalanceFrequency | null; driftThresholdBps: number | null } | null;
    performanceFeeBps: number | null;
    noRouteAssetPolicy: NoRouteAssetPolicy | null;
  };
}

export interface BagAssetDisplay {
  chain: BagChain;
  address: string;
  symbol: string;
}

/** Display only. Not hashed and never a rule. */
export interface BagMetadata {
  name: string;
  symbol: string;
  description: string;
  assets: BagAssetDisplay[];
}

/**
 * A bag.json v1 document. Only `bagJson` and `definition` are required (D3): a file written by anyone, with
 * no record in BAG's database, is a complete bag.json. The other fields are what BAG adds when it serves a
 * stored version. None of them is hashed, and none of them is authority:
 *  - `definitionHash` is always recomputed; a stated value that differs is an error.
 *  - `commitments` is BAG's own claim. The SDK never reads authority from it (the registry creator in
 *    particular is a verification INPUT, see `verifyRegistryCommitment`).
 */
export interface BagDocument {
  bagJson: typeof BAG_JSON_FORMAT_VERSION;
  definition: BagDefinition;
  metadata?: BagMetadata;
  definitionHash?: string;
  ref?: { strategyId: string; version: number; parentVersion: number | null; createdAt: string };
  network?: { chainId: number | null };
  commitments?: Record<string, unknown>;
  forkedFrom?: { strategyId: string; version: number | null } | null;
}

export type IssueSeverity = 'error' | 'warning';

export interface BagIssue {
  code: string;
  severity: IssueSeverity;
  /** Dot path into the document, e.g. `definition.assets[1].decimals`. */
  path: string;
  message: string;
}

export type Hex = `0x${string}`;
