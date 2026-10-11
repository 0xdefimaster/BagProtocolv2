import type { SupabaseClient } from '@supabase/supabase-js';
import type { PublicClient } from 'viem';
import { getBagById, getCurrentBagVersion } from '@/lib/server/bag-repo';
import { listAssets } from '@/lib/server/asset-repo';
import { assetKey, observeUserHoldings, sellableHoldingsForBag } from '@/lib/server/position-valuation';
import { assetIdentityKey } from '@/lib/domain/basket-protocol/asset-identity';
import { previewPositionRebalance, type PositionRebalancePreview } from '@/lib/domain/basket-protocol/rebalance/position-rebalance';
import type { PriceProvider } from '@/lib/domain/basket-protocol/pricing';
import type { AssetPrice, BagRecord, BasketRecipe, ChainId } from '@/types/basket-protocol';
import type { RedeemHoldingInput } from '@/lib/domain/basket-protocol/redeem/allocation';

// -----------------------------------------------------------------------------
// The I/O half of a position rebalance preview (the pure half is
// lib/domain/basket-protocol/rebalance/position-rebalance.ts), shared by the
// preview route and the quote: the Bag and its CURRENT version, the investor's
// effective holdings at one block, a verified price for every held and every
// targeted asset, display symbols.
// -----------------------------------------------------------------------------

export type LoadedRebalancePreview =
  | { ok: false; status: number; error: string }
  | {
      ok: true;
      bag: BagRecord;
      recipe: BasketRecipe;
      holdings: RedeemHoldingInput[] | null;
      blockNumber: string | null;
      symbols: Record<string, string>;
      preview: PositionRebalancePreview;
    };

export async function loadRebalancePreview(
  admin: SupabaseClient,
  client: PublicClient,
  priceProvider: PriceProvider,
  session: { userId: string; walletAddress: string },
  bagId: string
): Promise<LoadedRebalancePreview> {
  const bag = await getBagById(admin, bagId);
  if (!bag || (bag.status !== 'ACTIVE' && bag.creatorId !== session.userId)) return { ok: false, status: 404, error: 'Bag not found.' };
  const current = await getCurrentBagVersion(admin, bag.id);
  if (!current) return { ok: false, status: 409, error: 'This Bag has no current version.' };
  const recipe = { ...current.recipe, version: current.version };

  const observed = await observeUserHoldings(admin, client, session);
  const holdings = sellableHoldingsForBag(observed, bag.id);

  const assets = new Map<string, { chain: ChainId; address: string }>();
  for (const h of holdings ?? []) assets.set(assetIdentityKey({ chain: h.chain, address: h.address }), { chain: h.chain, address: h.address });
  for (const a of recipe.assets) assets.set(assetIdentityKey({ chain: a.chain, address: a.address }), { chain: a.chain, address: a.address });
  const prices = new Map<string, AssetPrice>();
  await Promise.all(
    [...assets.entries()].map(async ([key, asset]) => {
      try {
        const p = await priceProvider.getPrice(asset);
        if (/^\d+(\.\d+)?$/.test(p.price)) prices.set(key, p);
      } catch {
        // A refused price stays missing: the preview reports it, never a fallback.
      }
    })
  );

  const preview = previewPositionRebalance({
    recipe,
    holdings: holdings && holdings.map((h) => ({ chain: h.chain, address: h.address, decimals: h.decimals, sellableRaw: h.sellableRaw })),
    prices,
  });
  const chainAssets = await listAssets(admin, { chain: bag.chain });
  const symbols = Object.fromEntries(chainAssets.map((a) => [assetKey(a.chain, a.address), a.symbol]));
  return { ok: true, bag, recipe, holdings, blockNumber: observed.blockNumber, symbols, preview };
}
