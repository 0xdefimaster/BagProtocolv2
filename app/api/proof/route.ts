import { NextResponse } from 'next/server';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase/server';
import { loadProtocolProof } from '@/lib/server/protocol-proof';

// GET /api/proof — public, protocol-wide figures anyone can check against the
// chain: TVL by verification state, execution outcomes, fees paid to creators,
// realized results of verified exits, and the latest transactions
// (lib/server/protocol-proof.ts). No session; never names a wallet.
// Cached at the edge for a minute: the underlying passes run every 5 minutes.

export const dynamic = 'force-dynamic';

export async function GET() {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase is not configured on this deployment yet.' }, { status: 503 });
  }
  try {
    const proof = await loadProtocolProof(supabaseAdmin());
    return NextResponse.json(proof, { headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120' } });
  } catch (err) {
    console.error('[api/proof] failed', err);
    return NextResponse.json({ error: 'Could not load the proof figures.' }, { status: 500 });
  }
}
