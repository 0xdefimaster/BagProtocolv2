import { Bag, BagPosition } from '@/types';
import { Asset } from '@/lib/create-assets-data';
import {
  AssetMetadata,
  BasketRecipe,
  ChainId,
  DEFAULT_REBALANCE_RULE,
  DEFAULT_STRATEGY_TYPE,
  RecipeAsset,
  SUPPORTED_CHAINS,
} from '@/types/basket-protocol';

// -----------------------------------------------------------------------------
// Pure adapters — no I/O, no Supabase, no randomness. These are the seam
// between the existing product layer (Bag, BagPosition, Asset — all still
// symbol/weight-only) and the new protocol layer (BasketRecipe, RecipeAsset
// — chain/address/decimals-aware). Every existing component keeps rendering
// `Bag`/`BagPosition` unchanged; only code that needs real on-chain
// execution reaches for a `BasketRecipe`.
// -----------------------------------------------------------------------------

/** Widens a legacy `Asset` (lib/create-assets-data.ts) into the richer `AssetMetadata` shape. Adds no on-chain fields — those are populated separately once an asset is mapped to a real deployment. */
export function assetToAssetMetadata(asset: Asset): AssetMetadata {
  return {
    id: asset.id,
    symbol: asset.symbol,
    name: asset.name,
    type: asset.type,
    price: asset.price,
    priceChange24h: asset.change24h,
    icon: asset.icon,
  };
}

function isChainId(chain: string): chain is ChainId {
  return (SUPPORTED_CHAINS as readonly string[]).includes(chain);
}

/**
 * Converts a `BagPosition[]` (symbol + weight, what the create flow and
 * mock data produce today) into `RecipeAsset[]`. Assets that don't yet have
 * a known on-chain address/decimals are STILL included — with a
 * `__PENDING__` placeholder address and `decimals: 18` — rather than
 * dropped, so a recipe can be previewed end-to-end in demo mode before
 * every asset has a real deployment mapped. `validateBasketRecipe()`
 * (Phase 2) is what rejects placeholder addresses when a real deploy is
 * attempted.
 */
export function bagPositionsToRecipeAssets(
  composition: BagPosition[],
  chain: ChainId,
  assetsByAddress: Partial<Record<string, { address: string; decimals: number }>> = {}
): RecipeAsset[] {
  return composition.map((pos) => {
    const known = assetsByAddress[pos.symbol.toUpperCase()];
    return {
      chain,
      address: known?.address ?? '__PENDING__',
      symbol: pos.symbol,
      decimals: known?.decimals ?? 18,
      weightBps: Math.round(pos.weight * 100),
    };
  });
}

/** Inverse of `bagPositionsToRecipeAssets` — for rendering a recipe back through existing UI (BagCard, DiversificationScore, etc). */
export function recipeAssetsToBagPositions(assets: RecipeAsset[]): BagPosition[] {
  return assets.map((a) => ({ symbol: a.symbol, weight: a.weightBps / 100 }));
}

export interface BuildRecipeInput {
  bag: Bag;
  chain?: ChainId;
  mutability?: 'IMMUTABLE' | 'MUTABLE';
  assetsByAddress?: Partial<Record<string, { address: string; decimals: number }>>;
}

/**
 * Builds a `BasketRecipe` from an existing `Bag`. This is the Phase 1
 * entry point every later phase (validation, factory, registry) is meant
 * to call — it never mutates or replaces the `Bag` it reads from.
 */
export function buildRecipeFromBag(input: BuildRecipeInput): BasketRecipe {
  const { bag } = input;
  const chain = input.chain ?? (isChainId(bag.chains[0]) ? (bag.chains[0] as ChainId) : 'ethereum');

  return {
    id: `recipe_${bag.id}_v1`,
    bagId: bag.id,
    name: bag.name,
    symbol: bag.name.replace(/[^A-Z0-9]/gi, '').slice(0, 8).toUpperCase() || 'BAG',
    description: bag.description,
    chain,
    // Phase 11: every Bag built through this adapter is a STATIC_BASKET —
    // the only strategy type this product supports today. `Bag` itself has
    // no strategy concept (see types/index.ts), so there's nothing upstream
    // to read this from; it's a constant here on purpose, not a guess.
    strategyType: DEFAULT_STRATEGY_TYPE,
    assets: bagPositionsToRecipeAssets(bag.composition, chain, input.assetsByAddress),
    rebalanceRule: {
      ...DEFAULT_REBALANCE_RULE,
      frequency: mapRebalanceFrequency(bag.rules.rebalanceFrequency),
      maxSlippageBps: Math.round(bag.rules.slippage * 100),
    },
    minInvestment: bag.rules.minInvestment,
    maxAssets: Math.max(bag.composition.length, 10),
    minWeightBps: 100, // 1%
    maxWeightBps: 7000, // 70% — no single asset can dominate a "basket"
    mutability: input.mutability ?? 'MUTABLE',
    performanceFeeBps: 0,
    version: 1,
    createdAt: new Date().toISOString(),
  };
}

function mapRebalanceFrequency(freq: string): BasketRecipe['rebalanceRule']['frequency'] {
  const normalized = freq.trim().toLowerCase();
  if (normalized.includes('day')) return 'DAILY';
  if (normalized.includes('week')) return 'WEEKLY';
  if (normalized.includes('month')) return 'MONTHLY';
  if (normalized.includes('manual') || normalized.includes('none')) return 'MANUAL';
  return 'THRESHOLD_ONLY';
}
