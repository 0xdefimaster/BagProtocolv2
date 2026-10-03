import { NextResponse } from 'next/server';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase/server';
import { requireSession } from '@/lib/auth/require-session';
import { verifyRedeemExecution } from '@/lib/server/redeem-execution';
import { redeemExecutionErrorResponse } from '@/lib/server/redeem-intent-http';
import { checkRateLimit, rateLimitedResponseBody } from '@/lib/server/rate-limit';

// Production-hardening P1-10 — generous for legitimate polling, mirrors purchase-intent's own verify rate limit.
const RATE_LIMIT = { windowSeconds: 60, maxRequests: 60 };

// -----------------------------------------------------------------------------
// Phase 21 — exit-side counterpart to .../purchase-intent/[intentId]/
// verify/route.ts. The ONLY path that can ever move a RedeemIntent to
// COMPLETED (and thereby actually burn shares / remove holdings) — only
// after checking real on-chain status and confirming the received asset
// matches what was quoted, never from the client's own say-so. Safe to
// call repeatedly (see `verifyRedeemExecution()`'s doc).
//
//   POST /api/redeem-intent/:intentId/verify -> RedeemIntent
// -----------------------------------------------------------------------------

export async function POST(_req: Request, { params }: { params: Promise<{ intentId: string }> }) {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase is not configured on this deployment yet.' }, { status: 503 });
  }
  const auth = await requireSession();
  if (!auth.ok) return auth.response;

  const { intentId } = await params;
  const admin = supabaseAdmin();
  const limit = await checkRateLimit(admin, `redeem-intent-verify:${auth.session.userId}:${intentId}`, RATE_LIMIT);
  if (!limit.allowed) {
    return NextResponse.json(rateLimitedResponseBody(limit.retryAfterSeconds), { status: 429 });
  }
  const outcome = await verifyRedeemExecution(admin, auth.session, intentId);

  if (!outcome.ok) return redeemExecutionErrorResponse(outcome.error);
  return NextResponse.json({ intent: outcome.value });
}
