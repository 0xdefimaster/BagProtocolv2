import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth/require-session';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase/server';
import { prepareBagDeployment } from '@/lib/server/deploy-bag';
import { checkRateLimit, rateLimitedResponseBody } from '@/lib/server/rate-limit';

// Production-hardening P1-10 — a real on-chain deployment attempt per call; per user + bag.
const RATE_LIMIT = { windowSeconds: 60, maxRequests: 10 };

// -----------------------------------------------------------------------------
// POST /api/bags/[id]/deploy/prepare — step 1 of the USER-SIGNED deployment
// flow (see lib/server/deploy-bag.ts). Returns unsigned `createBag` calldata
// for the person's own wallet to sign. STATELESS: no deployment row, no status
// change, no transaction, no signature, no server key.
//
// The request body is deliberately IGNORED. The user id and wallet address come
// from the signed session cookie only (`session.walletAddress`, the same source
// lib/server/purchase-execution.ts uses); the chain is derived from the Bag.
// A client cannot choose a wallet, a chain, or anything else here.
// -----------------------------------------------------------------------------

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase is not configured on this deployment yet.' }, { status: 503 });
  }

  const auth = await requireSession();
  if (!auth.ok) return auth.response;

  const admin = supabaseAdmin();
  const limit = await checkRateLimit(admin, `deploy-prepare:${auth.session.userId}:${id}`, RATE_LIMIT);
  if (!limit.allowed) {
    return NextResponse.json(rateLimitedResponseBody(limit.retryAfterSeconds), { status: 429 });
  }

  // Timing log: server time before the deploy wallet prompt can open.
  const startedAt = Date.now();
  const result = await prepareBagDeployment(
    admin,
    { userId: auth.session.userId, walletAddress: auth.session.walletAddress },
    id
  );

  console.info(`[timing] deploy/prepare ${id}: ${Date.now() - startedAt}ms (${result.ok ? 'ok' : result.error})`);

  if (result.ok) {
    return NextResponse.json(
      {
        transaction: result.transaction,
        wallet: result.wallet,
        chain: result.chain,
        factoryAddress: result.factoryAddress,
        offChainRef: result.offChainRef,
        compositionHash: result.compositionHash,
      },
      { status: 200 }
    );
  }

  switch (result.error) {
    case 'NO_WALLET_ON_SESSION':
      return NextResponse.json({ error: 'Your session has no wallet address. Sign in again.', code: result.error }, { status: 401 });
    case 'BAG_NOT_FOUND':
      return NextResponse.json({ error: 'Bag not found.', code: result.error }, { status: 404 });
    case 'FORBIDDEN':
      // Never reveal *why* — not "this bag belongs to someone else".
      return NextResponse.json({ error: 'You do not have permission to deploy this bag.', code: result.error }, { status: 403 });
    case 'BAG_ARCHIVED':
      return NextResponse.json({ error: 'An archived bag cannot be deployed.', code: result.error }, { status: 409 });
    case 'NO_VERSION':
      return NextResponse.json({ error: 'Bag has no composition version to deploy.', code: result.error }, { status: 409 });
    case 'ALREADY_DEPLOYED':
      return NextResponse.json({ error: 'This bag is already deployed on its chain.', code: result.error, deployment: result.deployment }, { status: 409 });
    case 'ALREADY_CREATED_ON_CHAIN':
      return NextResponse.json(
        {
          error: result.txHash
            ? 'A Bag for this wallet already exists on-chain but was never confirmed. Its transaction was found; confirming it now.'
            : 'A Bag for this wallet already exists on-chain but was never confirmed, and its transaction could not be found automatically. Confirm it with the hash of the original transaction instead of sending a new one.',
          code: result.error,
          ...(result.txHash ? { txHash: result.txHash } : {}),
        },
        { status: 409 }
      );
    case 'CHAIN_UNAVAILABLE':
      return NextResponse.json({ error: `Deployment chain unavailable: ${result.message}`, code: result.error }, { status: 503 });
  }
}
