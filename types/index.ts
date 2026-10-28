import { StrategyType } from './basket-protocol';

/**
 * One asset the Bag actually holds right now (`bag_holdings`), priced by the
 * SAME NAV calculation that produces `Bag.tvl` — so the rows' `value`s add up
 * to the TVL. `price` is the price of ONE token; `value` is what the Bag's
 * whole quantity of it is worth. Both null when no live price is available.
 */
export interface BagHoldingView {
  symbol: string;
  chain: string;
  address: string;
  quantityRaw: string;
  decimals: number;
  price: string | null;
  value: string | null;
  quoteCurrency: string;
}

export interface Bag {
  id: string;
  name: string;
  /** DRAFT | ACTIVE | ARCHIVED — mirrors `BagRecord.status` (types/basket-protocol.ts). Optional: mock/local
   * bags predate this field and are treated as already-live (ACTIVE) wherever it's read. */
  status?: string;
  /** Live Bags: the current strategy version (1 = as created). Shown as "Name v2" once the creator edits it. */
  version?: number;
  /** Live Bags: whether the creator can publish new versions. */
  mutability?: 'IMMUTABLE' | 'MUTABLE';
  creator: CreatorProfile;
  description: string;
  thesis: string;
  tvl: number;
  /** What the Bag holds, per asset (detail endpoint only; absent in listings). */
  holdings?: BagHoldingView[];
  /** Live Bags: wallets that still hold some of the Bag's assets. Absent for demo/mock Bags. */
  holders?: number;
  /** Live Bags: how current the figures are against the chain (lib/server/bag-verification.ts). */
  verification?: { checkedAt: string | null; pendingOutflows: number };
  /** Live Bags: returns from recorded NAV snapshots (detail endpoint only). Absent for demo/mock Bags. */
  performanceRecorded?: BagPerformance;
  followers: number;
  forks: number;
  performance7d: number;
  performance30d: number;
  performanceYtd: number;
  chains: string[];
  composition: BagPosition[];
  category?: string;
  /**
   * What kind of strategy this Bag is — mirrors
   * `BasketRecipe.strategyType` (types/basket-protocol.ts). Optional
   * because plenty of existing mock/local `Bag`s (lib/mock-data.ts,
   * lib/user-bags-store.ts's offline fallback) were built before this
   * field existed and never set it; every UI reading it must fall back to
   * `'STATIC_BASKET'` rather than assume it's present. `'STATIC_BASKET'`
   * is the only value that exists today — see `STRATEGY_TYPES` in
   * types/basket-protocol.ts.
   */
  strategyType?: StrategyType;
  rules: {
    rebalanceFrequency: string;
    slippage: number;
    minInvestment: number;
    /** 'BLOCK' | 'HOLD_INPUT' | 'REFUND' — see UNROUTABLE_POLICIES in types/basket-protocol.ts. */
    unroutablePolicy?: string;
  };
  social: { followers: number; forks: number };
  performance: { returnsYTD: number };
  updateLog: UpdateLog[];
}

export interface BagPosition {
  symbol: string;
  weight: number;
  /** From the asset registry when the API could resolve it — lets category/diversification views tell a stock token from a coin without guessing by symbol. */
  assetType?: 'crypto' | 'stock';
  /** The chain's pinned settlement stablecoin (lib/domain/discovery/stablecoin.ts), matched by address. */
  stable?: boolean;
  logoUrl?: string;
  /** Live Bags: the asset's token address and exact target weight, for the Edit strategy screen. */
  address?: string;
  weightBps?: number;
}

export interface UpdateLog {
  date: string;
  change: string;
  reason: string;
}

export interface CreatorProfile {
  id?: string;
  name: string;
  handle?: string;
  avatar: string;
  /** Uploaded profile photo (users.avatar_url); `avatar` is the emoji fallback. */
  avatarUrl?: string;
  address: string;
  verified?: boolean;
  creatorScore?: number;
  followers: number;
  tvl?: string;
  forks: number;
  winningChallenges?: number;
  status?: string;
}

export interface User {
  address: string;
  balance: number;
  network: string;
  myBags: number;
  following: number;
  followers: number;
  forks: number;
  joinedAt: string; // ISO date
  reputation: number; // 0-100
}

/** One recorded NAV snapshot (bag_nav_snapshots). Decimal strings in the quote currency. */
export interface NavSnapshotPoint {
  capturedAt: string;
  grossNav: string;
  /** Legacy display only (null where the Bag had no shares): never used for returns. */
  navPerShare: string | null;
  /** Chained price index (migration 0055), the basis of every return; null on snapshots recorded before it. */
  priceIndex: string | null;
}

/** Returns (%) of NAV per share from recorded snapshots; null when the history does not reach back that far. */
export interface BagPerformance {
  '7D': number | null;
  '30D': number | null;
  YTD: number | null;
  sinceFirst: number | null;
  firstSnapshotAt: string | null;
  snapshots: number;
}
