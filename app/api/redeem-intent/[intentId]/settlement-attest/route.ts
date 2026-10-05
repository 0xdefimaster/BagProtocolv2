import { NextResponse } from 'next/server';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase/server';
import { requireSession } from '@/lib/auth/require-session';
import { attestSettlement } from '@/lib/server/redeem-settlement-attestation';
import { settlementErrorResponse } from '@/lib/server/redeem-settlement-errors';
import { checkRateLimit, rateLimitedResponseBody } from '@/lib/server/rate-limit';

const RATE_LIMIT = { windowSeconds: 60, maxRequests: 10 };

// Phase 2 of the settlement attestation: re-check the state against phase 1's plan, sign, compile the final
// Composer transaction. POST /api/redeem-intent/:intentId/settlement-attest → { composerTransaction, message, signature, deadline }
export async function POST(_req: Request, { params }: { params: Promise<{ intentId: string }> }) {
  if (!isSupabaseConfigured()) return NextResponse.json({ error: 'Supabase is not configured on this deployment yet.' }, { status: 503 });
  const auth = await requireSession();
  if (!auth.ok) return auth.response;
  const { intentId } = await params;
  const admin = supabaseAdmin();
  const limit = await checkRateLimit(admin, `redeem-intent-settlement-attest:${auth.session.userId}:${intentId}`, RATE_LIMIT);
  if (!limit.allowed) return NextResponse.json(rateLimitedResponseBody(limit.retryAfterSeconds), { status: 429 });
  try {
    return NextResponse.json(await attestSettlement(admin, auth.session.userId, intentId));
  } catch (err) {
    return settlementErrorResponse(err);
  }
}
