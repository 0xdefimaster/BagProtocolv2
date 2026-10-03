import { NextResponse } from 'next/server';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase/server';
import { requireSession } from '@/lib/auth/require-session';
import { verifyExecution } from '@/lib/server/purchase-execution';
import { purchaseExecutionErrorResponse } from '@/lib/server/purchase-intent-http';
import { checkRateLimit, rateLimitedResponseBody } from '@/lib/server/rate-limit';

// Production-hardening P1-10 — the client polls this every ~4s
// (hooks/use-purchase-execution.ts) while an intent is in flight, so this
// is deliberately generous per user+intent — bounding a runaway/scripted
// poll loop, not real usage.
const RATE_LIMIT = { windowSeconds: 60, maxRequests: 60 };

// -----------------------------------------------------------------------------
// Phase 17 — spec Aşama 10/11: post-execution verification + idempotent
// accounting. The client calls this after reporting `SUBMITTED` for every
// SWAP step (and may call it repeatedly while polling — every call is safe
// to repeat, see `verifyExecution()`'s doc). This is the ONLY path that can
// ever move an intent to `COMPLETED` — it only does so after checking real
// on-chain status via LI.FI's `getStatus()` and confirming the received
// asset matches the registry-verified expected asset, never from the
// client's own say-so.
//
//   POST /api/purchase-intent/:intentId/verify -> PurchaseIntent
// -----------------------------------------------------------------------------

export async function POST(_req: Request, { params }: { params: Promise<{ intentId: string }> }) {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase is not configured on this deployment yet.' }, { status: 503 });
  }
  const auth = await requireSession();
  if (!auth.ok) return auth.response;

  const { intentId } = await params;
  const admin = supabaseAdmin();
  const limit = await checkRateLimit(admin, `purchase-intent-verify:${auth.session.userId}:${intentId}`, RATE_LIMIT);
  if (!limit.allowed) {
    return NextResponse.json(rateLimitedResponseBody(limit.retryAfterSeconds), { status: 429 });
  }
  const outcome = await verifyExecution(admin, auth.session, intentId);

  if (!outcome.ok) return purchaseExecutionErrorResponse(outcome.error);
  return NextResponse.json({ intent: outcome.value });
}
