import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase/server';
import { requireSession } from '@/lib/auth/require-session';
import { createRedeemIntentForUser } from '@/lib/server/redeem-execution';
import { redeemExecutionErrorResponse } from '@/lib/server/redeem-intent-http';
import { checkRateLimit, rateLimitedResponseBody } from '@/lib/server/rate-limit';

// Same reasoning as .../purchase-intent/route.ts's rate limit — per
// authenticated user, generous for real usage, bounds scripted abuse.
const RATE_LIMIT = { windowSeconds: 60, maxRequests: 10 };

// -----------------------------------------------------------------------------
// Phase 21 — exit-side counterpart to .../purchase-intent/route.ts. Same
// invariants: requires a real signed-in session (never a placeholder
// wallet), never lets the client supply chain/address/decimals directly
// for the output asset (registry id only, same as `inputAssetId` on the
// deposit side).
//
//   POST /api/bags/:id/redeem-intent   { fractionBps, outputAssetId } -> RedeemIntent
//
// A4: the amount is a fraction of the position (basis points, 1..10000 =
// 0.01%..100%) of what the wallet effectively holds for this strategy — not a
// share count (shares are no longer an economic quantity, D1).
// -----------------------------------------------------------------------------

interface CreateRedeemIntentBody {
  fractionBps: number;
  outputAssetId: string;
}

function isCreateRedeemIntentBody(value: unknown): value is CreateRedeemIntentBody {
  if (typeof value !== 'object' || value === null) return false;
  const body = value as Record<string, unknown>;
  return typeof body.fractionBps === 'number' && typeof body.outputAssetId === 'string';
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase is not configured on this deployment yet.' }, { status: 503 });
  }

  const auth = await requireSession();
  if (!auth.ok) return auth.response;

  const admin = supabaseAdmin();
  const limit = await checkRateLimit(admin, `redeem-intent:${auth.session.userId}`, RATE_LIMIT);
  if (!limit.allowed) {
    return NextResponse.json(rateLimitedResponseBody(limit.retryAfterSeconds), { status: 429 });
  }

  const { id } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }
  if (!isCreateRedeemIntentBody(body)) {
    return NextResponse.json({ error: 'Expected { fractionBps: number, outputAssetId: string }.' }, { status: 400 });
  }

  const outcome = await createRedeemIntentForUser({
    admin,
    session: auth.session,
    bagId: id,
    fractionBps: body.fractionBps,
    outputAssetId: body.outputAssetId,
  });

  if (!outcome.ok) return redeemExecutionErrorResponse(outcome.error);
  return NextResponse.json({ intent: outcome.value });
}
