import { NextResponse } from 'next/server';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase/server';
import { requireSession } from '@/lib/auth/require-session';
import { getPurchaseIntentForUser } from '@/lib/server/purchase-intent-repo';

// -----------------------------------------------------------------------------
// Phase 17 — read-only status poll for a PurchaseIntent. The client polls
// this (and/or POST .../verify to actively trigger a status check) while
// showing "Confirming...". Ownership enforced the same way every other
// user-scoped route in this codebase is (spec Aşama 12: "user başka
// user'ın PurchaseIntent'ini execute edemiyor" — reading is scoped the
// same way execution is).
// -----------------------------------------------------------------------------

export async function GET(_req: Request, { params }: { params: Promise<{ intentId: string }> }) {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase is not configured on this deployment yet.' }, { status: 503 });
  }
  const auth = await requireSession();
  if (!auth.ok) return auth.response;

  const { intentId } = await params;
  const result = await getPurchaseIntentForUser(supabaseAdmin(), intentId, auth.session.userId);

  if (!result.ok) {
    return NextResponse.json(
      { error: result.error === 'NOT_FOUND' ? 'Purchase intent not found.' : 'This purchase intent does not belong to you.' },
      { status: result.error === 'NOT_FOUND' ? 404 : 403 }
    );
  }

  return NextResponse.json({ intent: result.intent });
}
