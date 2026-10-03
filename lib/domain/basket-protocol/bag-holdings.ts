import { AssetHolding, BagHolding } from '@/types/basket-protocol';

// -----------------------------------------------------------------------------
// The one, pure seam between `BagHolding` (persisted, tied to a bag,
// carries `updatedAt`) and `AssetHolding` (the NAV Engine's calculation
// primitive — lib/domain/basket-protocol/nav/nav.ts never imports Supabase
// or knows what a "Bag" is). No I/O here — `lib/server/bag-holdings-repo.ts`
// is where persistence happens; this file just reshapes already-loaded data.
// -----------------------------------------------------------------------------

export function bagHoldingToAssetHolding(holding: BagHolding): AssetHolding {
  return {
    asset: holding.asset,
    quantityRaw: holding.quantityRaw,
    decimals: holding.decimals,
  };
}

export function bagHoldingsToAssetHoldings(holdings: BagHolding[]): AssetHolding[] {
  return holdings.map(bagHoldingToAssetHolding);
}
