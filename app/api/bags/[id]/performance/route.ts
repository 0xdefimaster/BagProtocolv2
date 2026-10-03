import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth/require-session';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase/server';
import { getBagById } from '@/lib/server/bag-repo';
import { computeBagPerformance, getNavSnapshots } from '@/lib/server/bag-nav-snapshots';

// Recorded NAV history for the Performance chart. Same visibility rule as
// GET /api/bags/[id]: public for ACTIVE Bags, creator-only otherwise. Reads
// only — snapshots are recorded by the Bag detail read and
// scripts/snapshot-bag-navs.ts.
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
      return NextResponse.json({ error: 'Bag not found.' }, { status: 404 });
    }
  }

  try {
    const points = await getNavSnapshots(admin, bag.id);
    return NextResponse.json({ points, performance: computeBagPerformance(points) }, { status: 200 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Could not load performance history.' }, { status: 500 });
  }
}
