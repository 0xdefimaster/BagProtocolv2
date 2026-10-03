import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase/server';
import { requireSession } from '@/lib/auth/require-session';
import { recordRedeemStepEvent, RedeemStepReportEvent } from '@/lib/server/redeem-execution';
import { redeemExecutionErrorResponse } from '@/lib/server/redeem-intent-http';
import { REDEEM_INTENT_FAILURE_CODES, RedeemIntentFailureCode } from '@/types/redeem-intent';
import { checkRateLimit, rateLimitedResponseBody } from '@/lib/server/rate-limit';

// Production-hardening P1-10 — mirrors purchase-intent's own step-report rate limit.
const RATE_LIMIT = { windowSeconds: 60, maxRequests: 60 };

// -----------------------------------------------------------------------------
// Phase 21 — exit-side counterpart to .../purchase-intent/[intentId]/step/
// [stepIndex]/report/route.ts. Same restriction: the client's wallet flow
// reports what its OWN signing/broadcast attempt did — it can never report
// `COMPLETED` (see `recordRedeemStepEvent()`'s doc) — only `.../verify`'s
// on-chain check can ever mark a step done.
//
//   POST /api/redeem-intent/:intentId/step/:stepIndex/report
//   body: { type: 'APPROVAL_REQUIRED' | ... }  (see RedeemStepReportEvent)
// -----------------------------------------------------------------------------

const FAILURE_CODE_SET = new Set<string>(REDEEM_INTENT_FAILURE_CODES);

function isFailureCode(value: unknown): value is RedeemIntentFailureCode {
  return typeof value === 'string' && FAILURE_CODE_SET.has(value);
}

function parseEvent(body: unknown): RedeemStepReportEvent | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  switch (b.type) {
    case 'APPROVAL_REQUIRED':
    case 'APPROVAL_AWAITING_SIGNATURE':
    case 'APPROVAL_CONFIRMED':
    case 'AWAITING_SIGNATURE':
      return { type: b.type };
    case 'APPROVAL_SUBMITTED':
      return typeof b.txHash === 'string' ? { type: 'APPROVAL_SUBMITTED', txHash: b.txHash } : null;
    case 'SUBMITTED':
      return typeof b.txHash === 'string' ? { type: 'SUBMITTED', txHash: b.txHash } : null;
    case 'REJECTED':
      return { type: 'REJECTED', failureCode: 'USER_REJECTED' };
    case 'FAILED':
      return isFailureCode(b.failureCode)
        ? { type: 'FAILED', failureCode: b.failureCode, message: typeof b.message === 'string' ? b.message : undefined }
        : { type: 'FAILED', failureCode: 'UNKNOWN_ERROR' };
    default:
      return null;
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ intentId: string; stepIndex: string }> }) {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase is not configured on this deployment yet.' }, { status: 503 });
  }
  const auth = await requireSession();
  if (!auth.ok) return auth.response;

  const { intentId, stepIndex } = await params;
  const admin = supabaseAdmin();
  const limit = await checkRateLimit(admin, `redeem-intent-step-report:${auth.session.userId}:${intentId}`, RATE_LIMIT);
  if (!limit.allowed) {
    return NextResponse.json(rateLimitedResponseBody(limit.retryAfterSeconds), { status: 429 });
  }
  const parsedIndex = Number(stepIndex);
  if (!Number.isInteger(parsedIndex) || parsedIndex < 0) {
    return NextResponse.json({ error: 'Invalid step index.' }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }
  const event = parseEvent(body);
  if (!event) {
    return NextResponse.json({ error: 'Invalid or unrecognized step event.' }, { status: 400 });
  }

  const outcome = await recordRedeemStepEvent(admin, auth.session, intentId, parsedIndex, event);
  if (!outcome.ok) return redeemExecutionErrorResponse(outcome.error);
  return NextResponse.json({ intent: outcome.value });
}
