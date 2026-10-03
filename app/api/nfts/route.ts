import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth/require-session';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase/server';
import { listBagNftsForUser } from '@/lib/server/nft-repo';

// -----------------------------------------------------------------------------
// Phase 19 — server-enforced NFT read. Replaces
// lib/services/nft-service.ts's listBagNFTs() (localStorage).
// -----------------------------------------------------------------------------

export async function GET() {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase is not configured on this deployment yet.' }, { status: 503 });
  }
  const auth = await requireSession();
  if (!auth.ok) return auth.response;

  const nfts = await listBagNftsForUser(supabaseAdmin(), auth.session.userId);
  return NextResponse.json({ nfts });
}
