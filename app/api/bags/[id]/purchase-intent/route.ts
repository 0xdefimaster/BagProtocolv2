import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase/server';
import { requireSession } from '@/lib/auth/require-session';
import { createPurchaseIntentForUser } from '@/lib/server/purchase-execution';
import { purchaseExecutionErrorResponse } from '@/lib/server/purchase-intent-http';
import { checkRateLimit, rateLimitedResponseBody } from '@/lib/server/rate-limit';

// Per authenticated user, not per IP: a purchase-intent is meaningless
// without a session, so the user id is a stable, non-spoofable key already
// — no need for an IP fallback the way the unauthenticated nonce route
// needs one. 10/minute is generous for real usage (one basket purchase is
// one intent) while still bounding someone scripting repeated
// intent-creation (each of which fans out to real provider compiles —
// see the execution-candidate design doc's own concurrency note).
const RATE_LIMIT = { windowSeconds: 60, maxRequests: 10 };

// -----------------------------------------------------------------------------
// Phase 17 — spec Aşama 2/6: creates the server-side `PurchaseIntent` that
// backs the "Purchase" button in `PurchasePreviewModal`. Deliberately a
// SEPARATE route from `.../purchase-preview` (which stays exactly as it
// was — Phase 12/14, unauthenticated, no wallet needed, still used for the
// live "Allocation vs Live Quote" display before a wallet is even
// connected): this route requires a signed-in session (spec Aşama 1 —
// "Wallet disconnected ise execution disabled olsun") and its result is
// bound to that session's real wallet address, never a placeholder.
//
//   POST /api/bags/:id/purchase-intent   { inputAssetId, amount } -> PurchaseIntent
// -----------------------------------------------------------------------------

interface CreatePurchaseIntentBody {
  inputAssetId: string;
  /** Human decimal string, e.g. "100" — same convention as .../purchase-preview. */
  amount: string;
  /**
   * Item 11 — optional, set only after the client compared candidates via
   * `.../purchase-options` and the user tapped one. Just an id
   * (`identify()` name, e.g. `'lifi-composer'`) — never a compiled
   * execution, calldata, a price, or a route (see
   * `createPurchaseIntentForUser`'s own doc on `selectedProviderId`: the
   * server re-derives and re-compiles everything from `inputAssetId`/`amount`
   * above regardless of what was shown on the comparison screen).
   */
  providerId?: string;
  /** Set only after the buyer accepted a reported Composer price impact (bps). See `createPurchaseIntentForUser`. */
  acceptedPriceImpactBps?: number;
}

function isCreatePurchaseIntentBody(value: unknown): value is CreatePurchaseIntentBody {
  if (typeof value !== 'object' || value === null) return false;
  const body = value as Record<string, unknown>;
  if (typeof body.inputAssetId !== 'string' || typeof body.amount !== 'string') return false;
  if (body.providerId !== undefined && typeof body.providerId !== 'string') return false;
  if (
    body.acceptedPriceImpactBps !== undefined &&
    (typeof body.acceptedPriceImpactBps !== 'number' || !Number.isInteger(body.acceptedPriceImpactBps) || body.acceptedPriceImpactBps < 0 || body.acceptedPriceImpactBps > 10000)
  ) {
    return false;
  }
  return true;
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase is not configured on this deployment yet.' }, { status: 503 });
  }

  // Wallet disconnected / not signed in -> 401, which the client reads as
  // "show Connect Wallet" (spec Aşama 1/6) rather than proceeding with any
  // placeholder identity.
  const auth = await requireSession();
  if (!auth.ok) return auth.response;

  const admin = supabaseAdmin();
  const limit = await checkRateLimit(admin, `purchase-intent:${auth.session.userId}`, RATE_LIMIT);
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
  if (!isCreatePurchaseIntentBody(body)) {
    return NextResponse.json({ error: 'Expected { inputAssetId: string, amount: string }.' }, { status: 400 });
  }

  // Timing log: how long the server takes before the wallet prompt can open
  // (quotes + provider compile). Printed in the server console only.
  const startedAt = Date.now();
  const outcome = await createPurchaseIntentForUser({
    admin,
    session: auth.session,
    bagId: id,
    inputAssetId: body.inputAssetId,
    amount: body.amount,
    ...(body.providerId ? { selectedProviderId: body.providerId } : {}),
    ...(body.acceptedPriceImpactBps !== undefined ? { acceptedPriceImpactBps: body.acceptedPriceImpactBps } : {}),
  });

  console.info(`[timing] purchase-intent ${id}: ${Date.now() - startedAt}ms (${outcome.ok ? 'ok' : outcome.error.kind})`);

  if (!outcome.ok) return purchaseExecutionErrorResponse(outcome.error);
  return NextResponse.json({ intent: outcome.value });
}
