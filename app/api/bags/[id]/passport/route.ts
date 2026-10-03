import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase/server';
import { getBagById } from '@/lib/server/bag-repo';
import { loadStrategyPassport } from '@/lib/server/strategy-passport';

// GET /api/bags/:id/passport — the canonical Strategy Passport
// (types/strategy-passport.ts): identity, on-chain record, creator, current
// version, composition, performance, policy (with who enforces each rule) and
// lineage (versions vs forks). Same visibility as GET /api/bags/:id: public for
// ACTIVE Bags, creator-only otherwise. The future MCP get_strategy() returns this.

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase is not configured on this deployment yet.' }, { status: 503 });
  }

  const admin = supabaseAdmin();
  const bag = await getBagById(admin, id);
  if (!bag) return NextResponse.json({ error: 'Bag not found.' }, { status: 404 });

  const session = await getSession();
  const viewerUserId = session?.userId ?? null;
  if (bag.status !== 'ACTIVE' && viewerUserId !== bag.creatorId) {
    return NextResponse.json({ error: 'Bag not found.' }, { status: 404 });
  }

  try {
    return NextResponse.json({ passport: await loadStrategyPassport(admin, bag, viewerUserId) });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
