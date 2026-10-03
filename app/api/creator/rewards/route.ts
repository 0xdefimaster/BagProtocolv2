import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth/require-session';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase/server';
import { getCreatorRewardActivities } from '@/lib/server/creator-rewards-repo';

// -----------------------------------------------------------------------------
// Phase 22 (follow-up) — GET /api/creator/rewards: the signed-in user's own
// fork-royalty + performance-fee earnings, newest first, plus a total.
// Same auth pattern as app/api/portfolio/route.ts. Read-only — these
// activities are only ever written by apply_purchase_execution()/
// apply_redeem_execution() (supabase/migrations/0013_add_creator_rewards.sql),
// never by a client request.
// -----------------------------------------------------------------------------

export async function GET() {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase is not configured on this deployment yet.' }, { status: 503 });
  }

  const auth = await requireSession();
  if (!auth.ok) return auth.response;

  try {
    const admin = supabaseAdmin();
    const rewards = await getCreatorRewardActivities(admin, auth.session.userId);
    const totalQuote = rewards
      .reduce((sum, r) => sum + Number(r.amountQuote), 0)
      .toString();

    return NextResponse.json({ rewards, totalQuote });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
