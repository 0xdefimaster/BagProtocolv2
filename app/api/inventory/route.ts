import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth/require-session';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase/server';
import { listInventoryForUser } from '@/lib/server/box-repo';

// -----------------------------------------------------------------------------
// Phase 18 — server-enforced inventory read. Replaces
// lib/services/inventory-service.ts's listInventory() (localStorage; that
// file no longer exists in this repo) for the box-opening loop's output.
// NFT assembly's accessory-consumption has SINCE also been migrated — see
// lib/server/nft-repo.ts's assembleBagNftForUser(), Supabase/RPC-backed
// (supabase/migrations/0010_add_assemble_bag_nft.sql).
// -----------------------------------------------------------------------------

export async function GET() {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase is not configured on this deployment yet.' }, { status: 503 });
  }
  const auth = await requireSession();
  if (!auth.ok) return auth.response;

  const items = await listInventoryForUser(supabaseAdmin(), auth.session.userId);
  return NextResponse.json({ items });
}
