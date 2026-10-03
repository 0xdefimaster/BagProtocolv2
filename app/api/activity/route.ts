import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth/require-session';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase/server';
import { loadUserActivity } from '@/lib/server/user-activity';
import { settleUnsettledPurchasesForUser } from '@/lib/server/purchase-execution';

// GET /api/activity — the signed-in user's own activity (purchases, redemptions,
// fees and royalties earned), from the database records the accounting writes.
// Purchases left unverified (window closed before confirmation) are settled
// first, so they appear. Never another user's activity.

export async function GET() {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase is not configured on this deployment yet.' }, { status: 503 });
  }
  const auth = await requireSession();
  if (!auth.ok) return auth.response;
  try {
    const admin = supabaseAdmin();
    await settleUnsettledPurchasesForUser(admin, auth.session);
    return NextResponse.json({ activity: await loadUserActivity(admin, auth.session.userId) });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
