import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase/server';
import { requireSession } from '@/lib/auth/require-session';
import { getBagById, getCurrentBagVersion } from '@/lib/server/bag-repo';
import { listAssets } from '@/lib/server/asset-repo';
import { getDisplayPriceProvider } from '@/lib/server/price-provider';
import { getChainPublicClient } from '@/lib/blockchain/rpc/clients';
import { assetKey, observeUserHoldings, sellableHoldingsForBag } from '@/lib/server/position-valuation';
import { assetIdentityKey } from '@/lib/domain/basket-protocol/asset-identity';
import { previewPositionRebalance } from '@/lib/domain/basket-protocol/rebalance/position-rebalance';
import { checkRateLimit, rateLimitedResponseBody } from '@/lib/server/rate-limit';
import type { AssetPrice, ChainId } from '@/types/basket-protocol';

// -----------------------------------------------------------------------------
// GET /api/bags/:id/rebalance-preview — R1, read-only. How far THIS investor's
// position has drifted from the strategy's current version, and what a
// rebalance back to it would trade (lib/domain/basket-protocol/rebalance/
// position-rebalance.ts). Holdings are what the wallet holds attributed to the
// strategy (position-valuation.ts), at one block; prices are BAG's verified
// display prices. No quote, no route, no transaction.
// -----------------------------------------------------------------------------

const RATE_LIMIT = { windowSeconds: 60, maxRequests: 20 };
const priceProvider = getDisplayPriceProvider();

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase is not configured on this deployment yet.' }, { status: 503 });
  }
  const auth = await requireSession();
  if (!auth.ok) return auth.response;

  const { id } = await params;
  const admin = supabaseAdmin();
  const limit = await checkRateLimit(admin, `rebalance-preview:${auth.session.userId}`, RATE_LIMIT);
  if (!limit.allowed) return NextResponse.json(rateLimitedResponseBody(limit.retryAfterSeconds), { status: 429 });

  const bag = await getBagById(admin, id);
  if (!bag || (bag.status !== 'ACTIVE' && bag.creatorId !== auth.session.userId)) {
    return NextResponse.json({ error: 'Bag not found.' }, { status: 404 });
  }

  const current = await getCurrentBagVersion(admin, bag.id);
  if (!current) return NextResponse.json({ error: 'This Bag has no current version.' }, { status: 409 });
  const recipe = { ...current.recipe, version: current.version };

  const observed = await observeUserHoldings(admin, getChainPublicClient('robinhood'), auth.session);
  const holdings = sellableHoldingsForBag(observed, bag.id);

  // A price for every asset the position holds and every asset the current version targets.
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
  return NextResponse.json({ bag: { id: bag.id, name: bag.name, symbol: bag.symbol }, blockNumber: observed.blockNumber, symbols, preview });
}
