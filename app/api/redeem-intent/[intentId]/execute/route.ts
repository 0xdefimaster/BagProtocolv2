import { NextResponse } from 'next/server';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase/server';
import { requireSession } from '@/lib/auth/require-session';
import { prepareRedeemExecution } from '@/lib/server/redeem-execution';
import { redeemExecutionErrorResponse } from '@/lib/server/redeem-intent-http';
import { checkRateLimit, rateLimitedResponseBody } from '@/lib/server/rate-limit';

// Production-hardening P1-10 — per user + intent, mirrors purchase-intent's own execute rate limit.
const RATE_LIMIT = { windowSeconds: 60, maxRequests: 10 };

// -----------------------------------------------------------------------------
// Phase 21 — exit-side counterpart to .../purchase-intent/[intentId]/
// execute/route.ts. Same idempotency guarantee (repeated calls never
// create a second transaction — see `prepareRedeemExecution()`'s doc) and
// same signing boundary: this never signs or sends anything itself, only
// advances server-side status and hands back the per-step LI.FI payload
// for the client's own wallet to sign.
//
//   POST /api/redeem-intent/:intentId/execute -> RedeemIntent (with steps[].lifiStep)
// -----------------------------------------------------------------------------

export async function POST(_req: Request, { params }: { params: Promise<{ intentId: string }> }) {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase is not configured on this deployment yet.' }, { status: 503 });
  }
  const auth = await requireSession();
  if (!auth.ok) return auth.response;

  const { intentId } = await params;
  const admin = supabaseAdmin();
  const limit = await checkRateLimit(admin, `redeem-intent-execute:${auth.session.userId}:${intentId}`, RATE_LIMIT);
  if (!limit.allowed) {
    return NextResponse.json(rateLimitedResponseBody(limit.retryAfterSeconds), { status: 429 });
  }
  const outcome = await prepareRedeemExecution(admin, auth.session, intentId);

  if (!outcome.ok) return redeemExecutionErrorResponse(outcome.error);
  return NextResponse.json({ intent: outcome.value });
}
