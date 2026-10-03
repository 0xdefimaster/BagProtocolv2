import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase/server';
import { requireSession } from '@/lib/auth/require-session';
import { getPurchaseOptionsForUser } from '@/lib/server/purchase-execution';
import { purchaseExecutionErrorResponse } from '@/lib/server/purchase-intent-http';
import { checkRateLimit, rateLimitedResponseBody } from '@/lib/server/rate-limit';

// -----------------------------------------------------------------------------
// Phase 1 / item 9/10/15 — "basket-level execution candidate comparison".
//
//   POST /api/bags/:id/purchase-options   { inputAssetId, amount } -> { options }
//
// Deliberately its OWN, separate route from `.../purchase-intent` (item 10:
// "The candidate comparison request should NOT create a persistent
// PurchaseIntent for every candidate... Do NOT write rows merely because
// the user opened the route comparison screen") — this is a pure,
// side-effect-free read that runs the SAME preparation
// (`getPurchaseOptionsForUser()` shares `prepareBagPurchaseContext()` and
// `buildBagExecutionIntentAndProviders()` with `createPurchaseIntentForUser()`
// — item 10's "reuse the existing functions") but never calls
// `insertPurchaseIntent()`.
//
// RATE LIMITED more tightly than `.../purchase-intent` (item 15: "one
// comparison can create up to N provider compile operations, and LI.FI
// Sequential itself may quote multiple legs" — this route's real cost per
// call is a small multiple of that route's, not "1 network call"), same
// per-authenticated-user key convention.
// -----------------------------------------------------------------------------

const RATE_LIMIT = { windowSeconds: 60, maxRequests: 6 };

interface PurchaseOptionsBody {
  inputAssetId: string;
  /** Human decimal string, e.g. "100" — same convention as .../purchase-intent and .../purchase-preview. */
  amount: string;
}

function isPurchaseOptionsBody(value: unknown): value is PurchaseOptionsBody {
  if (typeof value !== 'object' || value === null) return false;
  const body = value as Record<string, unknown>;
  return typeof body.inputAssetId === 'string' && typeof body.amount === 'string';
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase is not configured on this deployment yet.' }, { status: 503 });
  }

  // Same session requirement as .../purchase-intent (item 10: "require the
  // same authenticated session as purchase-intent creation") — candidate
  // comparison still quotes against the real, session-bound wallet address,
  // never an unauthenticated/placeholder one, even though nothing is
  // persisted.
  const auth = await requireSession();
  if (!auth.ok) return auth.response;

  const admin = supabaseAdmin();
  const limit = await checkRateLimit(admin, `purchase-options:${auth.session.userId}`, RATE_LIMIT);
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
  if (!isPurchaseOptionsBody(body)) {
    return NextResponse.json({ error: 'Expected { inputAssetId: string, amount: string }.' }, { status: 400 });
  }

  const outcome = await getPurchaseOptionsForUser({
    admin,
    session: auth.session,
    bagId: id,
    inputAssetId: body.inputAssetId,
    amount: body.amount,
  });

  if (!outcome.ok) return purchaseExecutionErrorResponse(outcome.error);
  return NextResponse.json({ options: outcome.value });
}
