import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase/server';
import { listAssets } from '@/lib/server/asset-repo';
import { AssetType, ChainId, SUPPORTED_CHAINS } from '@/types/basket-protocol';

// -----------------------------------------------------------------------------
// Phase 17 — first read path from the asset registry (Phase 16) out to the
// client. Public, read-only, always VERIFIED-only: this is what feeds an
// asset picker (Create Basket's `AssetSelector`), so it must never leak an
// `UNKNOWN` (not-yet-reviewed) or `DEPRECATED` (possibly-delisted) asset as
// something a creator can pick — same VERIFIED-only stance
// `getVerifiedIdentityKeys()` / `validateRecipeAssetsAgainstRegistry()`
// already take at execution time.
//
// No auth required — the registry's `status = 'VERIFIED'` rows are meant
// to be publicly browsable (matches the assets table's own "assets_select"
// RLS policy in supabase/schema.sql), same trust level as `GET /api/bags`.
//
//   GET /api/assets                        all VERIFIED assets, any chain
//   GET /api/assets?chain=robinhood        VERIFIED assets on one chain
//   GET /api/assets?assetType=crypto       VERIFIED assets of one type
//   GET /api/assets?chain=base&assetType=crypto   both filters together
// -----------------------------------------------------------------------------

function isChainId(value: string | null): value is ChainId {
  return typeof value === 'string' && (SUPPORTED_CHAINS as readonly string[]).includes(value);
}

function isAssetType(value: string | null): value is AssetType {
  return value === 'crypto' || value === 'stock';
}

export async function GET(req: NextRequest) {
  // Deliberately NOT a 503 here (unlike /api/bags): this route backs a
  // client-side asset picker that has its own static-data fallback for
  // local/dev environments without Supabase configured, so an empty list
  // is the correct "nothing live yet" response, not an error.
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ assets: [] }, { status: 200 });
  }

  const { searchParams } = new URL(req.url);
  const chainParam = searchParams.get('chain');
  const assetTypeParam = searchParams.get('assetType');

  const admin = supabaseAdmin();
  const assets = await listAssets(admin, {
    status: 'VERIFIED',
    chain: isChainId(chainParam) ? chainParam : undefined,
    assetType: isAssetType(assetTypeParam) ? assetTypeParam : undefined,
  });

  return NextResponse.json({ assets }, { status: 200 });
}
