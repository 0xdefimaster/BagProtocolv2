import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase/server';
import { requireSession } from '@/lib/auth/require-session';
import { recordStepEvent, StepReportEvent } from '@/lib/server/purchase-execution';
import { purchaseExecutionErrorResponse } from '@/lib/server/purchase-intent-http';
import { PURCHASE_INTENT_FAILURE_CODES, PurchaseIntentFailureCode } from '@/types/purchase-intent';
import { checkRateLimit, rateLimitedResponseBody } from '@/lib/server/rate-limit';

// Production-hardening P1-10 — LI.FI's updateRouteHook can tick fairly
// often per step (hooks/use-purchase-execution.ts dedupes most of it
// client-side already), so this is generous per user+intent.
const RATE_LIMIT = { windowSeconds: 60, maxRequests: 60 };

// -----------------------------------------------------------------------------
// Phase 17 — spec Aşama 7: server-side transaction status tracking. The
// client's wallet flow reports what its own signing/broadcast attempt did
// — approval requested/signed/submitted, main tx signed/submitted, or a
// rejection/failure with a reason. Deliberately CANNOT report `COMPLETED`
// (see recordStepEvent()'s doc, lib/server/purchase-execution.ts) — a
// client claiming success is not evidence of success; only
// `.../verify`'s on-chain check can ever mark a step done (spec Aşama
// 12/13: no "fake success").
//
//   POST /api/purchase-intent/:intentId/step/:stepIndex/report
//   body: { type: 'APPROVAL_REQUIRED' | ... }  (see StepReportEvent)
// -----------------------------------------------------------------------------

const FAILURE_CODE_SET = new Set<string>(PURCHASE_INTENT_FAILURE_CODES);

function isFailureCode(value: unknown): value is PurchaseIntentFailureCode {
  return typeof value === 'string' && FAILURE_CODE_SET.has(value);
}

function parseEvent(body: unknown): StepReportEvent | null {
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

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ intentId: string; stepIndex: string }> }
) {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase is not configured on this deployment yet.' }, { status: 503 });
  }
  const auth = await requireSession();
  if (!auth.ok) return auth.response;

  const { intentId, stepIndex } = await params;
  const admin = supabaseAdmin();
  const limit = await checkRateLimit(admin, `purchase-intent-step-report:${auth.session.userId}:${intentId}`, RATE_LIMIT);
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

  const outcome = await recordStepEvent(admin, auth.session, intentId, parsedIndex, event);
  if (!outcome.ok) return purchaseExecutionErrorResponse(outcome.error);
  return NextResponse.json({ intent: outcome.value });
}
