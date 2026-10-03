import { Bag, BagHoldingView, BagPerformance, BagPosition, CreatorProfile } from '@/types';
import {
  BagRecord,
  BagVersionRecord,
  CanonicalAsset,
  ChainId,
  DEFAULT_MAX_WEIGHT_BPS,
  DEFAULT_MIN_WEIGHT_BPS,
  DEFAULT_STRATEGY_TYPE,
  DEFAULT_UNROUTABLE_POLICY,
  RebalanceFrequency,
  RecipeAsset,
  SUPPORTED_CHAINS,
  UNROUTABLE_POLICIES,
  UnroutablePolicy,
  defaultMaxAssets,
} from '@/types/basket-protocol';
import { recipeAssetsToBagPositions } from '@/lib/domain/basket-protocol/recipe';
import { assetIdentityKey } from '@/lib/domain/basket-protocol/asset-identity';
import { CreateBagInput } from '@/lib/server/bag-repo';

// -----------------------------------------------------------------------------
// API-boundary mapper layer.
//
//   UI Create Payload  --mapCreateBagRequestToRecipeInput-->  CreateBagInput (repo)
//   BagRecord+Version   --mapBagRecordToApiResponse-------->  Bag (existing UI type)
//
// Deliberately does NOT introduce a brand-new `BagViewModel` type yet.
// `types/index.ts`'s `Bag` is already what every existing component
// (BagCard, Dashboard, PortfolioPage, etc.) renders, so making these two
// mappers target that same shape means the API boundary can go live
// without touching component code. If/when the UI's needs diverge enough
// from `Bag` to warrant it, introduce `BagViewModel` and change ONLY
// `mapBagRecordToApiResponse`'s return type + the two call sites that read
// it — the repository/domain layer underneath never has to change again.
//
// Two mappers, one direction each — never a single "generic" mapper, same
// reasoning as bag-repo.ts keeping updateBagMetadata/updateBagStatus/
// setProtocolDeployment separate: request shape and response shape are
// different trust levels (client-authored vs server-derived) and mixing
// them into one function is how a client payload accidentally ends up
// deciding a server-owned field.
// -----------------------------------------------------------------------------

function isChainId(value: string | undefined): value is ChainId {
  return typeof value === 'string' && (SUPPORTED_CHAINS as readonly string[]).includes(value);
}

/**
 * Phase 17 — server-resolved identity lookup, keyed by uppercased symbol.
 * The route builds this from the VERIFIED asset registry (`listAssets`)
 * BEFORE calling this mapper — never from anything in the request body, so
 * a client can't claim an arbitrary `chain`/`address` for a symbol just by
 * putting it in the composition. Symbols the registry doesn't know yet
 * (e.g. crypto not registered as a canonical asset) fall back to the
 * bag-level `chain` and the `__PENDING__` placeholder, same as before
 * Phase 17 — this is a lookup MISS, not a validation failure; whether that
 * pending asset is acceptable is still decided later by
 * `validateBasketRecipe`/`validateRecipeAssetsAgainstRegistry`.
 */
export type AssetAddressLookup = Partial<Record<string, { chain: ChainId; address: string; decimals: number }>>;

export interface CreateBagApiRequest {
  name: string;
  description?: string;
  thesis?: string;
  chain?: string;
  composition: Array<{ symbol: string; weight: number }>;
  minInvestment?: number;
  rebalanceFrequency?: string;
  slippageBps?: number;
  mutability?: 'IMMUTABLE' | 'MUTABLE';
  // No parentBagId/rootBagId: lineage is never client input (it decides the fork royalty recipient).
  // A fork is created only by POST /api/bags/:id/fork, which derives lineage server-side.
  reason?: string;
  /** Basis points of realized profit paid to this bag's creator on redemption — see types/basket-protocol.ts's Phase 22 doc block. Omitted/0 = no fee. */
  performanceFeeBps?: number;
  /** What a purchase does when some assets have no swap route — see `UNROUTABLE_POLICIES`. Anything else falls back to the default. */
  unroutablePolicy?: string;
}

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const suffix = crypto.randomUUID().slice(0, 6);
  return `${base || 'bag'}-${suffix}`;
}

/** Creator-chosen max slippage, clamped to what the create form offers (0.1%–3%); 1% when absent. */
export const MIN_BAG_SLIPPAGE_BPS = 10;
export const MAX_BAG_SLIPPAGE_BPS = 300;
function clampSlippageBps(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 100;
  return Math.min(MAX_BAG_SLIPPAGE_BPS, Math.max(MIN_BAG_SLIPPAGE_BPS, Math.round(value)));
}

/** Minimum deposit in quote currency (USD); 0 = no minimum. */
function sanitizeMinInvestment(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0;
  return Math.min(Math.round(value * 100) / 100, 1_000_000_000);
}

function mapRebalanceFrequency(freq: string | undefined): RebalanceFrequency {
  const normalized = (freq ?? '').trim().toLowerCase();
  if (normalized.includes('day')) return 'DAILY';
  if (normalized.includes('week')) return 'WEEKLY';
  if (normalized.includes('month')) return 'MONTHLY';
  if (normalized.includes('manual') || normalized.includes('none')) return 'MANUAL';
  return 'THRESHOLD_ONLY';
}

/**
 * UI create-form payload -> `CreateBagInput` for `lib/server/bag-repo.ts#createBag`.
 * `creatorId` always comes from the caller's authenticated session — NEVER
 * from the request body — so it's a separate parameter, not a field this
 * function reads off `body`.
 */
export function mapCreateBagRequestToRecipeInput(
  body: CreateBagApiRequest,
  creatorId: string,
  assetsByAddress: AssetAddressLookup = {}
): CreateBagInput {
  const chain: ChainId = isChainId(body.chain) ? (body.chain as ChainId) : 'ethereum';
  const symbol =
    body.name
      .replace(/[^A-Z0-9]/gi, '')
      .slice(0, 8)
      .toUpperCase() || 'BAG';

  const assets: RecipeAsset[] = body.composition.map((pos) => {
    const known = assetsByAddress[pos.symbol.toUpperCase()];
    return {
      // Per-asset chain from the registry lookup when we have one — a
      // basket mixing a registered Robinhood stock token with an
      // as-yet-unregistered crypto symbol no longer gets the crypto leg's
      // fallback chain incorrectly forced onto the stock leg (or vice
      // versa). Falls back to the bag-level `chain` only on a lookup miss.
      chain: known?.chain ?? chain,
      address: known?.address ?? '__PENDING__',
      symbol: pos.symbol,
      decimals: known?.decimals ?? 18,
      weightBps: Math.round(pos.weight * 100),
    };
  });

  return {
    slug: slugify(body.name),
    creatorId,
    mutability: body.mutability ?? 'MUTABLE',
    // DRAFT: a new Bag has no on-chain deployment yet — user-signed deployment
    // (lib/server/deploy-bag.ts) is what moves it to ACTIVE, atomically, only
    // after a verified on-chain `BagCreated`. A Bag created here as ACTIVE
    // would be publicly visible (Explore/`listBags()` default) and forkable
    // with no contract behind it at all.
    status: 'DRAFT',
    reason: body.reason ?? 'Initial creation',
    recipe: {
      name: body.name,
      symbol,
      description: body.description ?? '',
      chain,
      // Not read from `body` — the create form never lets the caller pick
      // a strategy type (spec §6: "kullanıcı başka strategy seçemez"), and
      // `STATIC_BASKET` is the only value that exists, so trusting a
      // client-supplied one here would be a no-op at best and a forged
      // field at worst. Same trust boundary as `creatorId` above.
      strategyType: DEFAULT_STRATEGY_TYPE,
      assets,
      rebalanceRule: {
        frequency: mapRebalanceFrequency(body.rebalanceFrequency),
        driftThresholdBps: 500,
        maxSlippageBps: clampSlippageBps(body.slippageBps),
      },
      minInvestment: sanitizeMinInvestment(body.minInvestment),
      maxAssets: defaultMaxAssets(assets.length),
      minWeightBps: DEFAULT_MIN_WEIGHT_BPS,
      maxWeightBps: DEFAULT_MAX_WEIGHT_BPS,
      mutability: body.mutability ?? 'MUTABLE',
      performanceFeeBps: body.performanceFeeBps ?? 0,
      unroutablePolicy: parseUnroutablePolicy(body.unroutablePolicy),
    },
  };
}

function parseUnroutablePolicy(value: string | undefined): UnroutablePolicy {
  return (UNROUTABLE_POLICIES as readonly string[]).includes(value ?? '') ? (value as UnroutablePolicy) : DEFAULT_UNROUTABLE_POLICY;
}

export interface BagResponseContext {
  /** Display info for the creator — not stored on `BagRecord` (only `creatorId` is). Callers should resolve this from their own user/profile source; falls back to a minimal stub built from the id so the response is never missing the field. */
  creator?: CreatorProfile;
  forkCount?: number;
  /** Wallets with a non-zero position. */
  holderCount?: number;
  /** Registry rows for the recipe's assets, keyed by `assetIdentityKey` (see `lib/server/bag-asset-context.ts`). Missing entries just leave `assetType`/`logoUrl` unset. */
  assetsByKey?: Map<string, CanonicalAsset>;
  /** Live TVL (the Bag's gross NAV from `bag_holdings`, quote currency). Omitted where it isn't computed (listings) — then 0. */
  tvl?: number;
  /** Per-asset holdings priced by the same NAV as `tvl` (detail endpoint only). */
  holdings?: BagHoldingView[];
  /** Returns from recorded NAV snapshots (detail endpoint only). */
  performance?: BagPerformance;
}

/** `BagRecord` + its current `BagVersionRecord` -> the existing `Bag` UI type. This is the ONLY place a route should build a `Bag` from domain records — never inline in a route handler. */
export function mapBagRecordToApiResponse(
  bag: BagRecord,
  version: BagVersionRecord | null,
  ctx: BagResponseContext = {}
): Bag {
  const composition: BagPosition[] = version
    ? recipeAssetsToBagPositions(version.recipe.assets).map((pos, i) => {
        const asset = version.recipe.assets[i];
        const known = ctx.assetsByKey?.get(assetIdentityKey({ chain: asset.chain, address: asset.address }));
        return known ? { ...pos, assetType: known.assetType, logoUrl: known.logoUrl } : pos;
      })
    : [];
  const creator: CreatorProfile = ctx.creator ?? {
    id: bag.creatorId,
    name: bag.creatorId.slice(0, 6),
    avatar: '👤',
    address: bag.creatorId,
    followers: 0,
    forks: 0,
  };

  return {
    id: bag.id,
    name: bag.name,
    status: bag.status,
    creator,
    description: bag.description,
    thesis: version ? '' : '',
    tvl: ctx.tvl ?? 0,
    ...(ctx.holdings ? { holdings: ctx.holdings } : {}),
    ...(ctx.performance ? { performanceRecorded: ctx.performance } : {}),
    ...(ctx.holderCount !== undefined ? { holders: ctx.holderCount } : {}),
    followers: 0,
    forks: ctx.forkCount ?? 0,
    performance7d: 0,
    performance30d: 0,
    performanceYtd: 0,
    chains: [bag.chain],
    composition,
    category: undefined,
    // From `BagRecord.strategyType` (the denormalized `bags.strategy_type`
    // column), not `version.recipe.strategyType` — the row column is
    // `not null` with a migration-backfilled default, so it's never
    // missing even for a Bag whose stored recipe predates Phase 11.
    strategyType: bag.strategyType ?? DEFAULT_STRATEGY_TYPE,
    rules: {
      rebalanceFrequency: version?.recipe.rebalanceRule.frequency ?? 'THRESHOLD_ONLY',
      slippage: version ? version.recipe.rebalanceRule.maxSlippageBps / 100 : 0,
      minInvestment: version?.recipe.minInvestment ?? 0,
      unroutablePolicy: version?.recipe.unroutablePolicy ?? DEFAULT_UNROUTABLE_POLICY,
    },
    social: { followers: 0, forks: ctx.forkCount ?? 0 },
    performance: { returnsYTD: 0 },
    updateLog: [
      {
        date: bag.createdAt.slice(0, 10),
        change: 'Bag created',
        reason: 'Initial creation',
      },
    ],
  };
}

export function mapBagRecordsToApiResponse(
  bags: BagRecord[],
  versionsById: Map<string, BagVersionRecord | null>,
  creatorsById: Map<string, CreatorProfile> = new Map(),
  assetsByKey?: Map<string, CanonicalAsset>,
  /** TVL + recorded returns per Bag from NAV snapshots (`getNavSummaries`); Bags without one show TVL 0 and no returns. */
  navSummariesById: Map<string, { tvl: number; performance: BagPerformance }> = new Map(),
  /** Real fork / holder counts per Bag (`getBagSocialCounts`). */
  socialById: Map<string, { forks: number; holders: number }> = new Map()
): Bag[] {
  return bags.map((bag) => {
    const summary = navSummariesById.get(bag.id);
    const social = socialById.get(bag.id);
    return mapBagRecordToApiResponse(bag, versionsById.get(bag.id) ?? null, {
      creator: creatorsById.get(bag.creatorId),
      assetsByKey,
      ...(summary ? { tvl: summary.tvl, performance: summary.performance } : {}),
      ...(social ? { forkCount: social.forks, holderCount: social.holders } : {}),
    });
  });
}
