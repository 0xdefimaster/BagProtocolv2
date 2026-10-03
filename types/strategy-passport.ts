import type { BagMutability, BagStatus, ChainId, StrategyType } from './basket-protocol';
import type { BagPerformance } from './index';

// -----------------------------------------------------------------------------
// Strategy Passport — the ONE canonical description of a Bag as a strategy:
// identity, current version, composition, creator, performance, policy and
// lineage. Served by GET /api/bags/:id/passport, rendered on the Bag page, and
// meant to be returned as-is by the future MCP `get_strategy()` tool.
//
// Every section states where its data comes from (`Provenance`), and every
// policy rule states who enforces it (`Enforcement`), so a reader — human or
// agent — never mistakes a database value or a BAG computation for something
// the chain guarantees.
// -----------------------------------------------------------------------------

export const STRATEGY_PASSPORT_SCHEMA_VERSION = 1;

/**
 * - `ONCHAIN_RECORDED`: copied from a confirmed transaction / event when it was
 *   confirmed (deployment, on-chain version). Verifiable on-chain via the tx
 *   hash; this endpoint does not re-read the chain on every request.
 * - `DATABASE`: BAG's database (Supabase) is the source of truth.
 * - `BAG_COMPUTED`: computed by BAG's server at request time or by its jobs
 *   (NAV, TVL, returns from recorded snapshots, prices from BAG's price providers).
 */
export type Provenance = 'ONCHAIN_RECORDED' | 'DATABASE' | 'BAG_COMPUTED';

/**
 * Who makes a rule hold:
 * - `ONCHAIN`: a contract or the executed transaction itself reverts otherwise.
 * - `DATABASE`: a Postgres constraint/trigger rejects the write.
 * - `BAG_SERVER`: BAG's server checks it before building a transaction (an attestation, not a chain guarantee).
 * - `PROVIDER`: the routing provider (LI.FI) refuses to compile otherwise.
 * - `DECLARED`: stated by the creator; nothing executes it automatically today.
 */
export type Enforcement = 'ONCHAIN' | 'DATABASE' | 'BAG_SERVER' | 'PROVIDER' | 'DECLARED';

export interface PassportCreator {
  userId: string;
  name: string | null;
  walletAddress: string | null;
  avatarUrl: string | null;
}

export interface PassportAsset {
  chain: ChainId;
  address: string;
  symbol: string;
  name: string | null;
  assetType: string | null;
  decimals: number;
  weightBps: number;
  /** Background route check from the asset registry; null until checked. Display only. */
  routeStatus: 'ROUTABLE' | 'NO_ROUTE' | null;
  routeCheckedAt: string | null;
}

export interface PassportPolicyRule {
  key: string;
  label: string;
  /** Machine value (number, string or boolean); `display` is the human form. */
  value: number | string | boolean | null;
  display: string;
  enforcement: Enforcement;
  note?: string;
}

export interface PassportVersionNode {
  versionId: string;
  version: number;
  /** The version this one replaced (version − 1); null for v1. */
  parentVersion: number | null;
  createdAt: string;
  reason: string;
  compositionHash: string;
  isCurrent: boolean;
  /** Present when this version was recorded on-chain (deployed Bags only). */
  onchain: { txHash: string; onchainVersion: number; compositionHash: string; metadataUri: string | null } | null;
}

export interface PassportForkNode {
  bagId: string;
  /** False when the Bag is not public (DRAFT/ARCHIVED) and the viewer is not its creator: no details are disclosed. */
  visible: boolean;
  name: string | null;
  symbol: string | null;
  status: BagStatus | null;
  creator: PassportCreator | null;
  createdAt: string | null;
}

export interface StrategyPassport {
  schemaVersion: typeof STRATEGY_PASSPORT_SCHEMA_VERSION;
  generatedAt: string;

  identity: {
    provenance: 'DATABASE';
    bagId: string;
    slug: string;
    name: string;
    symbol: string;
    description: string;
    chain: ChainId;
    strategyType: StrategyType;
    mutability: BagMutability;
    status: BagStatus;
    createdAt: string;
  };

  /** Null until the Bag is deployed on-chain. */
  onchain: {
    provenance: 'ONCHAIN_RECORDED';
    chain: ChainId;
    chainId: number | null;
    onChainBagId: string | null;
    onChainCreator: string | null;
    contractAddress: string | null;
    factoryAddress: string | null;
    deploymentTxHash: string | null;
    deploymentBlock: number | null;
    onChainVersion: number;
    explorerUrl: string | null;
  } | null;

  creator: PassportCreator & { provenance: 'DATABASE' };

  currentVersion: {
    provenance: 'DATABASE';
    versionId: string;
    version: number;
    createdAt: string;
    reason: string;
    /** BAG's off-chain fingerprint of the composition. */
    compositionHash: string;
    /** The bytes32 committed on-chain for this version; null if this version was never recorded on-chain. */
    onchainCompositionHash: string | null;
  } | null;

  composition: {
    provenance: 'DATABASE';
    assets: PassportAsset[];
    totalWeightBps: number;
  };

  performance: {
    provenance: 'BAG_COMPUTED';
    tvlUsd: string | null;
    navPerShare: string | null;
    navAsOf: string | null;
    returns: BagPerformance | null;
    holders: number | null;
  };

  policy: {
    rules: PassportPolicyRule[];
  };

  lineage: {
    /** The chain of versions of THIS Bag (v1 → current). Same strategy, edited over time. */
    versions: { provenance: 'DATABASE'; nodes: PassportVersionNode[] };
    /** Other Bags this one was copied from, and Bags copied from it. Different strategies sharing an origin. */
    forks: {
      provenance: 'DATABASE';
      /** Nearest first: parent, grandparent, …, root. Empty for an original Bag. */
      ancestors: PassportForkNode[];
      rootBagId: string;
      isOriginal: boolean;
      /** Direct forks of this Bag (public ones, plus the viewer's own). */
      children: PassportForkNode[];
      /** All direct forks, public or not. */
      childCount: number;
      /** Royalty a fork pays the root creator on every deposit, in bps. */
      forkRoyaltyBps: number;
      /** Fork records do not store which parent version was copied. */
      forkedFromVersion: null;
    };
  };

  /** Shorthand for clients: section → provenance. */
  provenance: Record<string, Provenance>;
}

