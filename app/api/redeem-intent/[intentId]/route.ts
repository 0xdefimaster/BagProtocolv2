import { NextResponse } from 'next/server';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase/server';
import { requireSession } from '@/lib/auth/require-session';
import { getRedeemIntentForUser } from '@/lib/server/redeem-intent-repo';

// -----------------------------------------------------------------------------
// Phase 21 — read-only status poll for a RedeemIntent, exit-side
// counterpart to .../purchase-intent/[intentId]/route.ts. Same ownership
// enforcement (reading is scoped the same way execution is).
// -----------------------------------------------------------------------------

export async function GET(_req: Request, { params }: { params: Promise<{ intentId: string }> }) {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase is not configured on this deployment yet.' }, { status: 503 });
  }
  const auth = await requireSession();
  if (!auth.ok) return auth.response;

  const { intentId } = await params;
  const result = await getRedeemIntentForUser(supabaseAdmin(), intentId, auth.session.userId);

  if (!result.ok) {
    return NextResponse.json(
      { error: result.error === 'NOT_FOUND' ? 'Redeem intent not found.' : 'This redeem intent does not belong to you.' },
      { status: result.error === 'NOT_FOUND' ? 404 : 403 }
    );
  }

  return NextResponse.json({ intent: result.intent });
}
