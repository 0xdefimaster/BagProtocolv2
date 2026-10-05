import { NextResponse } from 'next/server';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase/server';
import { requireSession } from '@/lib/auth/require-session';
import {
  signFeeAttestation,
  RouterNotConfiguredError,
  NoLiquidityError,
  SaleNoLongerCoveredError,
  BalanceUnavailableError,
  PositionBusyError,
  FeeBasisUnavailableError,
  SaleQuoteExpiredError,
  ExecutionPriceTooLowError,
  PriceUnavailableForSaleError,
} from '@/lib/server/redeem-fee-attestation';
import { checkRateLimit, rateLimitedResponseBody } from '@/lib/server/rate-limit';

// Production-hardening P1-10 — signs a real, one-time-use fee attestation
// per call; per user + intent, same limit family as the other redeem-intent routes.
const RATE_LIMIT = { windowSeconds: 60, maxRequests: 10 };

// -----------------------------------------------------------------------------
// V11 — the signing endpoint RedeemFeeRouter.redeem() needs before it can
// be called at all: the client cannot construct a valid attestation itself
// (it doesn't have REDEEM_FEE_ATTESTOR_PRIVATE_KEY, by design — see
// RedeemFeeRouter.sol's own module doc). Every value in the returned
// attestation was loaded and computed server-side by signFeeAttestation()
// — this route is pure I/O + auth + error mapping, same split as every
// other redeem-intent route.
//
//   POST /api/redeem-intent/:intentId/attest-fee -> FeeAttestation
//
// signFeeAttestation() now builds one RedeemLeg per distinct asset in the
// redemption (multi-asset support, V11) — the MultiAssetRedemptionNotSupportedError
// fail-closed path from the prior single-leg design no longer exists; this
// route was updated to match (previously imported that removed symbol,
// which no longer compiled — fixed here).
//
// Deliberately fails closed (503/422), never with a fabricated attestation:
// RouterNotConfiguredError (REDEEM_FEE_ROUTER_ADDRESS/CREATOR_REWARDS_VAULT_ADDRESS
// unset — nothing has been deployed yet) and NoLiquidityError (no Uniswap
// v3 pool could quote one of the redemption's legs — see V12 note in
// signFeeAttestation()'s own module doc) are the two known ways this can
// honestly fail rather than sign something unverified.
// -----------------------------------------------------------------------------

export async function POST(_req: Request, { params }: { params: Promise<{ intentId: string }> }) {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase is not configured on this deployment yet.' }, { status: 503 });
  }
  const auth = await requireSession();
  if (!auth.ok) return auth.response;

  const { intentId } = await params;
  const admin = supabaseAdmin();
  const limit = await checkRateLimit(admin, `redeem-intent-attest-fee:${auth.session.userId}:${intentId}`, RATE_LIMIT);
  if (!limit.allowed) {
    return NextResponse.json(rateLimitedResponseBody(limit.retryAfterSeconds), { status: 429 });
  }

  try {
    const attestation = await signFeeAttestation(admin, auth.session.userId, intentId);
    return NextResponse.json({ attestation });
  } catch (err) {
    if (err instanceof RouterNotConfiguredError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    if (err instanceof SaleNoLongerCoveredError) {
      return NextResponse.json({ error: err.message, failureCode: 'ROUTE_EXPIRED' }, { status: 409 });
    }
    if (err instanceof BalanceUnavailableError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    if (err instanceof NoLiquidityError) {
      return NextResponse.json({ error: err.message }, { status: 422 });
    }
    if (err instanceof ExecutionPriceTooLowError) {
      return NextResponse.json({ error: err.message, code: 'EXECUTION_PRICE_TOO_LOW', deviationBps: err.deviationBps, maxDeviationBps: err.maxDeviationBps }, { status: 422 });
    }
    if (err instanceof PriceUnavailableForSaleError) {
      return NextResponse.json({ error: err.message, code: 'PRICE_UNAVAILABLE' }, { status: 422 });
    }
    if (err instanceof SaleQuoteExpiredError) {
      return NextResponse.json({ error: err.message, failureCode: 'ROUTE_EXPIRED' }, { status: 409 });
    }
    if (err instanceof PositionBusyError) {
      return NextResponse.json({ error: err.message, code: 'PURCHASE_IN_PROGRESS' }, { status: 409 });
    }
    if (err instanceof FeeBasisUnavailableError) {
      return NextResponse.json({ error: err.message, code: 'FEE_BASIS_UNAVAILABLE', reason: err.reason }, { status: 422 });
    }
    const message = err instanceof Error ? err.message : 'Failed to sign fee attestation.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
