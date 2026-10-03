import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth/require-session';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase/server';
import { getBagById, getCurrentBagVersion, updateBagMetadata } from '@/lib/server/bag-repo';
import { mapBagRecordToApiResponse } from '@/lib/mappers/bag-mapper';
import { loadRecipeAssets } from '@/lib/server/bag-asset-context';
import { validateBagText } from '@/lib/server/bag-text';
import { loadCreatorProfiles } from '@/lib/server/user-profile-repo';
import { getBagNavSafe } from '@/lib/server/bag-nav';
import { getDisplayPriceProvider } from '@/lib/server/price-provider';
import { getBagHoldings } from '@/lib/server/bag-holdings-repo';
import { getBagSocialCounts } from '@/lib/server/bag-social-counts';
import { computeBagPerformance, getNavSnapshots, recordNavSnapshot } from '@/lib/server/bag-nav-snapshots';
import type { NavResult } from '@/types/basket-protocol';
import type { BagHoldingView, BagPerformance } from '@/types';

/**
 * Live TVL = the Bag's gross NAV over `bag_holdings` (same NAV math as
 * purchase/redeem), plus the per-asset rows of that SAME calculation, so the
 * page's holdings breakdown always adds up to the TVL. Detail page only —
 * listings don't price every Bag per request. If prices are unavailable the
 * holdings are still listed (quantities only) and TVL shows 0; any other
 * read failure shows 0 and no rows rather than failing the whole page.
 */
async function loadNavView(
  admin: ReturnType<typeof supabaseAdmin>,
  bagId: string,
  recipeAssets: { chain: string; address: string; symbol: string }[]
): Promise<{ tvl: number; holdings: BagHoldingView[]; nav: NavResult | null }> {
  const symbolOf = (chain: string, address: string) =>
    recipeAssets.find((a) => a.chain === chain && a.address.toLowerCase() === address.toLowerCase())?.symbol ?? `${address.slice(0, 6)}…`;
  try {
    const outcome = await getBagNavSafe(admin, bagId, getDisplayPriceProvider());
    if (outcome.ok) {
      const tvl = Number(outcome.nav.grossNav);
      return {
        nav: outcome.nav,
        tvl: Number.isFinite(tvl) ? tvl : 0,
        holdings: outcome.nav.components.map((c) => ({
          symbol: symbolOf(c.asset.chain, c.asset.address),
          chain: c.asset.chain,
          address: c.asset.address,
          quantityRaw: c.quantityRaw,
          decimals: c.decimals,
          price: c.price.price,
          value: c.value,
          quoteCurrency: outcome.nav.quoteCurrency,
        })),
      };
    }
    const held = await getBagHoldings(admin, bagId);
    return {
      nav: null,
      tvl: 0,
      holdings: held.map((h) => ({
        symbol: symbolOf(h.asset.chain, h.asset.address),
        chain: h.asset.chain,
        address: h.asset.address,
        quantityRaw: h.quantityRaw,
        decimals: h.decimals,
        price: null,
        value: null,
        quoteCurrency: 'USD',
      })),
    };
  } catch {
    return { tvl: 0, holdings: [], nav: null };
  }
}

/**
 * Records a NAV snapshot from the NAV this request already priced (at most one
 * per SNAPSHOT_MIN_INTERVAL_MS per Bag), then computes 7D/30D/YTD from the
 * recorded history. Failures here never fail the page: no figures are shown.
 */
async function loadPerformance(admin: ReturnType<typeof supabaseAdmin>, bagId: string, nav: NavResult | null): Promise<BagPerformance | undefined> {
  try {
    if (nav) await recordNavSnapshot(admin, bagId, { nav });
    return computeBagPerformance(await getNavSnapshots(admin, bagId));
  } catch {
    return undefined;
  }
}

// -----------------------------------------------------------------------------
// Single-bag read/edit route. Same ownership contract `bag-repo.ts` already
// documents: GET is public for ACTIVE bags (mirrors the `bags` RLS read
// policy) but requires the caller to be the creator for DRAFT/ARCHIVED
// bags, and PATCH always requires session.userId === bag.creatorId — this
// is the first route that actually enforces that check, per the note in
// bag-repo.ts's header ("whichever route calls updateBagMetadata() ...
// MUST ... reject with 403 if session.userId !== bag.creatorId").
// -----------------------------------------------------------------------------

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase is not configured on this deployment yet.' }, { status: 503 });
  }

  const admin = supabaseAdmin();
  const bag = await getBagById(admin, id);
  if (!bag) return NextResponse.json({ error: 'Bag not found.' }, { status: 404 });

  if (bag.status !== 'ACTIVE') {
    const auth = await requireSession();
    if (!auth.ok || auth.session.userId !== bag.creatorId) {
      // Same "don't confirm existence" reasoning as the deploy route.
      return NextResponse.json({ error: 'Bag not found.' }, { status: 404 });
    }
  }

  const version = await getCurrentBagVersion(admin, bag.id);
  const [assetsByKey, creators, navView, social] = await Promise.all([
    loadRecipeAssets(admin, [version]),
    loadCreatorProfiles(admin, [bag.creatorId]),
    loadNavView(admin, bag.id, version?.recipe.assets ?? []),
    getBagSocialCounts(admin, [bag.id])
      .then((m) => m.get(bag.id))
      .catch(() => undefined),
  ]);
  const performance = await loadPerformance(admin, bag.id, navView.nav);
  return NextResponse.json(
    {
      bag: mapBagRecordToApiResponse(bag, version, {
        assetsByKey,
        creator: creators.get(bag.creatorId),
        tvl: navView.tvl,
        holdings: navView.holdings,
        performance,
        ...(social ? { forkCount: social.forks, holderCount: social.holders } : {}),
      }),
    },
    { status: 200 }
  );
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase is not configured on this deployment yet.' }, { status: 503 });
  }

  const auth = await requireSession();
  if (!auth.ok) return auth.response;

  const admin = supabaseAdmin();
  const bag = await getBagById(admin, id);
  if (!bag) return NextResponse.json({ error: 'Bag not found.' }, { status: 404 });
  if (bag.creatorId !== auth.session.userId) {
    return NextResponse.json({ error: 'You do not have permission to edit this bag.' }, { status: 403 });
  }

  const body = (await req.json().catch(() => ({}))) as { name?: unknown; symbol?: unknown; description?: unknown };
  const textIssue = validateBagText(body);
  if (textIssue) return NextResponse.json({ error: textIssue }, { status: 400 });
  if (body.symbol !== undefined && (typeof body.symbol !== 'string' || !/^[A-Z0-9]{1,8}$/.test(body.symbol))) {
    return NextResponse.json({ error: 'symbol must be 1–8 uppercase letters or digits.' }, { status: 400 });
  }
  const updated = await updateBagMetadata(admin, bag.id, {
    name: typeof body.name === 'string' ? body.name.trim() : undefined,
    symbol: body.symbol as string | undefined,
    description: typeof body.description === 'string' ? body.description.trim() : undefined,
  });

  const version = await getCurrentBagVersion(admin, updated.id);
  const [assetsByKey, creators] = await Promise.all([loadRecipeAssets(admin, [version]), loadCreatorProfiles(admin, [updated.creatorId])]);
  return NextResponse.json(
    { bag: mapBagRecordToApiResponse(updated, version, { assetsByKey, creator: creators.get(updated.creatorId) }) },
    { status: 200 }
  );
}
