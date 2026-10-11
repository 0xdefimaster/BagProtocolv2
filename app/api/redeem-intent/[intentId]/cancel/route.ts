import { NextResponse } from 'next/server';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase/server';
import { requireSession } from '@/lib/auth/require-session';
import { cancelOpenRedeemIntent } from '@/lib/server/redeem-execution';
import { redeemExecutionErrorResponse } from '@/lib/server/redeem-intent-http';
import { checkRateLimit, rateLimitedResponseBody } from '@/lib/server/rate-limit';

// POST /api/redeem-intent/:intentId/cancel — the owner closes an open sale that blocks a new one. Closed only once the
// chain shows its transaction cannot still land unbooked (cancelOpenRedeemIntent); a sale that did land is booked.
//   -> { result: 'CLOSED' | 'BOOKED' | 'ALREADY_FINAL' | 'REFUSED', status, reason? }

export const maxDuration = 60;
const RATE_LIMIT = { windowSeconds: 60, maxRequests: 10 };

export async function POST(_req: Request, { params }: { params: Promise<{ intentId: string }> }) {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase is not configured on this deployment yet.' }, { status: 503 });
  }
  const auth = await requireSession();
  if (!auth.ok) return auth.response;

  const { intentId } = await params;
  const admin = supabaseAdmin();
  const limit = await checkRateLimit(admin, `redeem-intent-cancel:${auth.session.userId}`, RATE_LIMIT);
  if (!limit.allowed) return NextResponse.json(rateLimitedResponseBody(limit.retryAfterSeconds), { status: 429 });

  const outcome = await cancelOpenRedeemIntent(admin, auth.session, intentId);
  if (!outcome.ok) return redeemExecutionErrorResponse(outcome.error);
  return NextResponse.json(outcome.value);
}
