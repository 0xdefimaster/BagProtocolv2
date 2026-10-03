import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth/require-session';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase/server';
import { confirmBagDeployment } from '@/lib/server/deploy-bag';
import { checkRateLimit, rateLimitedResponseBody } from '@/lib/server/rate-limit';

// Production-hardening P1-10 — generous: legitimate retries/refreshes while
// waiting on a real transaction receipt are expected (see this route's own doc).
const RATE_LIMIT = { windowSeconds: 60, maxRequests: 20 };

// -----------------------------------------------------------------------------
// POST /api/bags/[id]/deploy/confirm — step 3 of the USER-SIGNED deployment
// flow. Body: { "txHash": "0x…" } — the ONLY client-supplied value. The wallet
// is the session's (`session.walletAddress`); the chain, factory, offChainRef,
// composition hash and every other expectation are derived server-side. This
// route never marks anything deployed itself: only lib/server/deploy-bag.ts's
// on-chain verification followed by the atomic `confirm_bag_deployment` RPC can.
//
// Safe to call repeatedly with the same txHash (refresh, retry, double click,
// delayed RPC): it is idempotent, and a still-pending transaction answers 202
// PENDING within a bounded wait instead of hanging.
// -----------------------------------------------------------------------------

// The bounded receipt wait (BAG_DEPLOYMENT_RECEIPT_TIMEOUT_MS, default 20s, max 55s) must fit inside the platform's function limit.
export const maxDuration = 60;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase is not configured on this deployment yet.' }, { status: 503 });
  }

  const auth = await requireSession();
  if (!auth.ok) return auth.response;

  const admin = supabaseAdmin();
  const limit = await checkRateLimit(admin, `deploy-confirm:${auth.session.userId}:${id}`, RATE_LIMIT);
  if (!limit.allowed) {
    return NextResponse.json(rateLimitedResponseBody(limit.retryAfterSeconds), { status: 429 });
  }

  const body = (await req.json().catch(() => null)) as { txHash?: unknown } | null;
  const txHash = typeof body?.txHash === 'string' ? body.txHash : '';

  const result = await confirmBagDeployment(
    admin,
    { userId: auth.session.userId, walletAddress: auth.session.walletAddress },
    id,
    txHash
  );

  if (result.ok) {
    return NextResponse.json({ deployment: result.deployment, bag: result.bag, alreadyConfirmed: result.alreadyConfirmed }, { status: 200 });
  }

  switch (result.error) {
    case 'NO_WALLET_ON_SESSION':
      return NextResponse.json({ error: 'Your session has no wallet address. Sign in again.', code: result.error }, { status: 401 });
    case 'INVALID_TX_HASH':
      return NextResponse.json({ error: 'txHash must be a 0x-prefixed 32-byte transaction hash.', code: result.error }, { status: 400 });
    case 'BAG_NOT_FOUND':
      return NextResponse.json({ error: 'Bag not found.', code: result.error }, { status: 404 });
    case 'FORBIDDEN':
      return NextResponse.json({ error: 'You do not have permission to deploy this bag.', code: result.error }, { status: 403 });
    case 'NO_VERSION':
      return NextResponse.json({ error: 'Bag has no composition version to deploy.', code: result.error }, { status: 409 });
    case 'PENDING':
      // Not a failure: the transaction is not verifiable yet. The client retries this same request.
      return NextResponse.json({ status: 'PENDING', code: result.error, message: result.message }, { status: 202 });
    case 'VERIFICATION_FAILED':
      return NextResponse.json({ error: `Transaction is not a valid deployment for this bag: ${result.message}`, code: result.error }, { status: 422 });
    case 'CONFLICTING_DEPLOYMENT':
      return NextResponse.json(
        { error: 'This bag already has a different confirmed deployment on this chain.', code: result.error, deployment: result.deployment },
        { status: 409 }
      );
    case 'STALE_VERSION':
      return NextResponse.json(
        { error: 'The bag composition changed after this transaction was prepared; it no longer matches on-chain.', code: result.error },
        { status: 409 }
      );
    case 'IDENTITY_TAKEN':
      return NextResponse.json({ error: 'This transaction is already recorded for another bag.', code: result.error }, { status: 409 });
    case 'CHAIN_UNAVAILABLE':
      return NextResponse.json({ error: `Deployment chain unavailable: ${result.message}`, code: result.error }, { status: 503 });
    case 'CHAIN_ERROR':
      return NextResponse.json({ error: `Could not verify the transaction right now: ${result.message}`, code: result.error }, { status: 502 });
  }
}
