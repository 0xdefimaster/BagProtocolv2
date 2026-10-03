import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase/server';
import { getLeaderboard } from '@/lib/server/leaderboard-repo';
import { getCurrentSeason } from '@/lib/server/season-repo';
import { LEADERBOARD_TOP_N } from '@/lib/config/season';

// Readable without signing in — leaderboards are public — but "self" only
// resolves when there's a session, since a guest has no `users` row.
export async function GET() {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase is not configured on this deployment yet.' }, { status: 503 });
  }

  try {
    const admin = supabaseAdmin();
    const session = await getSession();
    // Production-hardening P0-6 — the real, date-derived current season.
    // No active season is a real, explicit state: an empty leaderboard,
    // never a stale one carried over from whichever season last ran.
    const season = await getCurrentSeason(admin);
    if (!season) {
      return NextResponse.json({ result: null, season: null });
    }
    const result = await getLeaderboard(admin, season.id, session?.userId ?? '', LEADERBOARD_TOP_N);
    return NextResponse.json({ result, season });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
