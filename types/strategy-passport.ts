import type { BagMutability, BagStatus, ChainId, StrategyType } from './basket-protocol';
import type { BagPerformance } from './index';
import type { DataSource, StrategyPolicy } from './strategy-policy';

// -----------------------------------------------------------------------------
// Strategy Passport — the ONE canonical, public description of a Bag as a
// strategy: identity, on-chain record, creator, current version, composition,
// performance, policy and lineage. Served by GET /api/bags/:id/passport,
// rendered on the Bag page, and returned as-is by the future MCP
// get_strategy() tool. Field names are stable; additive changes keep
// `schemaVersion`, breaking ones bump it.
//
// No internal identifiers (user ids, row ids, BAG's internal fingerprints)
// are exposed: people are identified by wallet address, versions by number.
// -----------------------------------------------------------------------------

export const STRATEGY_PASSPORT_SCHEMA_VERSION = 1;

/** Where a section's data comes from and how fresh it is. */
export interface SourceInfo {
  source: DataSource;
  /** When the value was recorded (on-chain: when BAG recorded the confirmed tx) or computed. */
  asOf: string | null;
  /** How a reader can check it: by a transaction hash, by recomputing from public inputs, or not at all. */
  verifiableBy: 'TX_HASH' | 'NONE';
  /** Whether this response re-read the chain. Always false today: on-chain values are served from BAG's record of the confirmed transaction. */
  readFromChainThisRequest: boolean;
}

export interface PassportPerson {
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
  /** BAG's background route check (BAG_ATTESTED, may be stale; purchases re-quote live). Null until checked. */
  routeStatus: 'ROUTABLE' | 'NO_ROUTE' | null;
  routeCheckedAt: string | null;
}

export interface PassportVersionNode {
  version: number;
  /** The version this one replaced; null for v1. */
  parentVersion: number | null;
  createdAt: string;
  reason: string;
  isCurrent: boolean;
  /** Present when this version was recorded on-chain (deployed Bags only). */
  onchain: { txHash: string; onchainVersion: number; compositionHash: string; metadataUri: string | null; sourceInfo: SourceInfo } | null;
}

export interface PassportForkNode {
  bagId: string;
  /** False when the Bag is not public and the viewer is not its creator: nothing else is disclosed. */
  visible: boolean;
  name: string | null;
  symbol: string | null;
  status: BagStatus | null;
  creator: PassportPerson | null;
  createdAt: string | null;
}

export interface StrategyPassport {
  schemaVersion: typeof STRATEGY_PASSPORT_SCHEMA_VERSION;
  generatedAt: string;

  identity: {
    sourceInfo: SourceInfo;
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
    sourceInfo: SourceInfo;
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

  creator: PassportPerson & { sourceInfo: SourceInfo };

  currentVersion: {
    sourceInfo: SourceInfo;
    version: number;
    createdAt: string;
    reason: string;
    /** The bytes32 committed on-chain for this version; null if it was never recorded on-chain. */
    onchainCompositionHash: string | null;
  } | null;

  composition: {
    sourceInfo: SourceInfo;
    assets: PassportAsset[];
    totalWeightBps: number;
  };

  performance: {
    sourceInfo: SourceInfo;
    /** Decimal USD string. */
    tvlUsd: string | null;
    navPerShare: string | null;
    returns: BagPerformance | null;
    holders: number | null;
  };

  /** Same object validate_bag returns; each rule carries its value source and enforcement. Null when the Bag has no version. */
  policy: StrategyPolicy | null;

  lineage: {
    /** THIS Bag over time (v1 → current). Same strategy identity. */
    versions: { sourceInfo: SourceInfo; nodes: PassportVersionNode[] };
    /** Other Bags this one was copied from, and Bags copied from it. Separate strategies. */
    forks: {
      sourceInfo: SourceInfo;
      /** Nearest first: parent, grandparent, …, root. Empty for an original Bag. */
      ancestors: PassportForkNode[];
      rootBagId: string;
      isOriginal: boolean;
      /** Direct forks visible to this viewer (public ones, plus the viewer's own). */
      children: PassportForkNode[];
      /** All direct forks, public or not (a count only). */
      childCount: number;
      /** Royalty a fork pays the root creator on every deposit, in bps. */
      forkRoyaltyBps: number;
      /** Fork records do not store which parent version was copied, so this is always null. */
      forkedFromVersion: null;
    };
  };
}
