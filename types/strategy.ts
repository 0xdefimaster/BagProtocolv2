import type { BagMutability, BagStatus, ChainId, RebalanceFrequency, StrategyType, UnroutablePolicy } from './basket-protocol';
import type { SourceInfo, StrategyPassport } from './strategy-passport';
import type { StrategyPolicy } from './strategy-policy';
import type { ValidateBagResult } from '@/lib/server/validate-bag';

// -----------------------------------------------------------------------------
// bag.json v1 — the canonical DEFINITION of one strategy version: only what the
// creator committed to in that version. Never state (NAV, TVL, routes), never
// BAG's enforcement claims (policy view), never execution data (receipts).
// Built from `bag_versions.recipe`; design: docs/BAG_JSON_V1_DESIGN.md.
//
// `null` always means "not set by the creator in this version" — the policy
// view says which protocol default applies today. Defaults are never written
// into bag.json, so a stored version's bag.json (and hash) never changes.
// -----------------------------------------------------------------------------

export const BAG_JSON_FORMAT_VERSION = 1;
/** Domain prefix hashed in front of the canonical definition (defined once, in the SDK). */
export { BAG_JSON_HASH_DOMAIN } from '../packages/bag-sdk/src/types';

/**
 * One asset of the definition: identity (chain + address), the unit its amounts are expressed in (decimals,
 * from the asset registry) and its target weight. No symbol: display names live in `metadata.assets`, so a
 * renamed token never changes the strategy's definition or hash.
 */
export interface BagDefinitionAsset {
  chain: ChainId;
  /** Lowercase for EVM chains; as-is for case-sensitive chains. Identity is chain + address. */
  address: string;
  decimals: number;
  weightBps: number;
}

/** Display name of one asset, as recorded with the version. Not hashed; never a rule. */
export interface BagAssetDisplay {
  chain: ChainId;
  address: string;
  symbol: string;
}

export interface BagDefinition {
  kind: StrategyType | null;
  chain: ChainId;
  mutability: BagMutability | null;
  /** Sorted by chain, then address (UTF-16 code unit order). */
  assets: BagDefinitionAsset[];
  rules: {
    weightBounds: { minBps: number | null; maxBps: number | null };
    maxAssets: number | null;
    /** Decimal string, compared against the payment-token amount of a purchase. */
    minInvestment: { amount: string; measuredAs: 'PAYMENT_TOKEN_AMOUNT' } | null;
    /** Per-swap purchase slippage (stored as `rebalanceRule.maxSlippageBps`). */
    swapSlippageBps: number | null;
    rebalance: { frequency: RebalanceFrequency | null; driftThresholdBps: number | null } | null;
    /** As declared in this version. The effective fee can be locked at Bag level: see Strategy `state.performanceFee`. */
    performanceFeeBps: number | null;
    noRouteAssetPolicy: UnroutablePolicy | null;
  };
}

export interface BagJson {
  bagJson: typeof BAG_JSON_FORMAT_VERSION;
  /** The only hashed part. */
  definition: BagDefinition;
  /** keccak256(utf8(BAG_JSON_HASH_DOMAIN + JCS(definition))). */
  definitionHash: string;
  ref: { strategyId: string; version: number; parentVersion: number | null; createdAt: string };
  /** EIP-155 chain id from BAG's chain config; null for non-EVM chains. */
  network: { chainId: number | null };
  /**
   * Display only, as recorded with this version (current Bag display values are in Strategy `state.display`).
   * Not hashed, and never a rule: an agent must not read intent or constraints from these strings.
   */
  metadata: { name: string; symbol: string; description: string; assets: BagAssetDisplay[] };
  commitments: {
    /** The bytes32 recorded for this version from its on-chain version event; null if none was recorded. */
    onchainCompositionHash: string | null;
    onchainTxHash: string | null;
    onchainComposition: OnchainCompositionCheck;
    /** This version's StrategyRegistry commitment, as BAG verified it (docs/STRATEGY_REGISTRY_DESIGN.md). */
    registry: RegistryCommitment;
  };
  /**
   * The Bag this one was forked from, and the exact parent version it was forked from. `version` is null only
   * for forks made before BAG recorded it (migration 0052): never inferred.
   */
  forkedFrom: { strategyId: string; version: number | null } | null;
}

/**
 * What BAG can say about this version's StrategyRegistry commitment:
 * - `REGISTERED`: BAG verified a creator-signed registry transaction whose committed definitionHash equals this
 *   version's bag.json hash (`recordedFrom: VERIFIED_TX_RECEIPT`). Anyone can re-check it on-chain
 *   (scripts/verify-strategy-commitment.ts) without trusting BAG.
 * - `NOT_REGISTERED`: no verified registration is recorded for this version.
 * Never a chain read made by this response.
 */
export interface RegistryCommitment {
  status: 'REGISTERED' | 'NOT_REGISTERED';
  chainId: number | null;
  registryAddress: string | null;
  /** keccak256(abi.encode(creator, offChainRef)) — the creator-bound id in the registry. */
  registryStrategyId: string | null;
  creator: string | null;
  txHash: string | null;
  blockNumber: number | null;
  /** Set on a fork's version 1: the registered parent and version it was forked from. */
  forkOf: { registryStrategyId: string; version: number } | null;
  recordedFrom: 'VERIFIED_TX_RECEIPT' | null;
  verifiedBy: 'BAG' | null;
  readFromChainThisRequest: false;
}

/**
 * What BAG can say about this version's on-chain composition commitment, and how it knows it:
 * - `MATCHES_RECORDED` / `MISMATCH`: BAG recomputed the on-chain composition hash from the version's stored
 *   recipe and compared it with the hash it recorded from the version's verified transaction receipt.
 * - `NOT_RECORDED`: no on-chain hash is recorded for this version (never recorded on-chain, or version 1,
 *   whose deploy-time hash is checked at deploy but not stored).
 * Never a chain read made by this response (`readFromChainThisRequest: false`).
 */
export interface OnchainCompositionCheck {
  status: 'MATCHES_RECORDED' | 'MISMATCH' | 'NOT_RECORDED';
  /** Where the recorded hash came from; null when nothing is recorded. */
  recordedFrom: 'VERIFIED_TX_RECEIPT' | null;
  /** Who compared it: BAG's server, against its own record. */
  comparedBy: 'BAG' | null;
  readFromChainThisRequest: false;
}

// ----------------------------- Unified Strategy API ----------------------------

export const STRATEGY_API_SCHEMA_VERSION = 1;

export interface StrategyVersionSummary {
  version: number;
  parentVersion: number | null;
  createdAt: string;
  reason: string;
  isCurrent: boolean;
  definitionHash: string;
  commitments: BagJson['commitments'];
}

export interface StrategyRouteState {
  chain: ChainId;
  address: string;
  /** BAG's background route check (BAG_ATTESTED, may be stale). Null until checked. */
  routeStatus: 'ROUTABLE' | 'NO_ROUTE' | null;
  routeCheckedAt: string | null;
}

/** GET /api/strategies/:id */
export interface StrategyObject {
  schemaVersion: typeof STRATEGY_API_SCHEMA_VERSION;
  generatedAt: string;
  strategyId: string;
  /** bag.json of the current version; null if the Bag has no version. */
  definition: BagJson | null;
  /** What the strategy looks like now. Every section says where it comes from. */
  state: {
    status: BagStatus;
    slug: string;
    display: { sourceInfo: SourceInfo; name: string; symbol: string; description: string };
    creator: StrategyPassport['creator'];
    onchain: StrategyPassport['onchain'];
    performance: StrategyPassport['performance'];
    routes: { sourceInfo: SourceInfo; assets: StrategyRouteState[] };
    performanceFee: { declaredBps: number | null; effectiveBps: number | null; locked: boolean };
  };
  /** How BAG applies each rule today (StrategyPolicy v2). Null if the Bag has no version. */
  policy: StrategyPolicy | null;
  lineage: {
    currentVersion: number | null;
    versionCount: number;
    forks: StrategyPassport['lineage']['forks'];
  };
  links: { self: string; versions: string; currentDefinition: string | null; myExecutions: string; passport: string };
}

/** GET /api/strategies/:id/versions (newest first) */
export interface StrategyVersionsResponse {
  schemaVersion: typeof STRATEGY_API_SCHEMA_VERSION;
  strategyId: string;
  currentVersion: number | null;
  versions: StrategyVersionSummary[];
}

/** POST /api/strategies/validate */
export interface StrategyValidationResponse {
  schemaVersion: typeof STRATEGY_API_SCHEMA_VERSION;
  /** Hash of the submitted definition after canonicalization. Says nothing about validity. */
  definitionHash: string;
  /** The submitted definition, canonicalized (what the hash covers). */
  definition: BagDefinition;
  /** validate_bag's result; `field` paths point into the definition. */
  validation: ValidateBagResult;
}
