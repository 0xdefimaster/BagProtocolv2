import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth/require-session';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase/server';
import { getUserPoints, listTransactions } from '@/lib/server/points-repo';
import { getCurrentSeason } from '@/lib/server/season-repo';

export async function GET() {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase is not configured on this deployment yet.' }, { status: 503 });
  }

  const auth = await requireSession();
  if (!auth.ok) return auth.response;

  try {
    const admin = supabaseAdmin();
    // Production-hardening P0-6 — the real, date-derived current season,
    // never the hardcoded GENESIS_SEASON constant. `season: null` (no
    // season's window contains `now`) is a real, explicit state: points
    // and transactions are then empty rather than scoped to a stale id.
    const season = await getCurrentSeason(admin);
    if (!season) {
      return NextResponse.json({ season: null, points: null, transactions: [] });
    }
    const [points, transactions] = await Promise.all([
      getUserPoints(admin, auth.session.userId, season.id),
      listTransactions(admin, auth.session.userId, season.id),
    ]);
    return NextResponse.json({ season, points, transactions });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
