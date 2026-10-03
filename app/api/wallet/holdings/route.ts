import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth/require-session';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase/server';
import { getRobinhoodPublicClient } from '@/lib/blockchain/robinhood-public-client';
import { getDisplayPriceProvider } from '@/lib/server/price-provider';
import { checkRateLimit, rateLimitedResponseBody } from '@/lib/server/rate-limit';
import { getWalletHoldings } from '@/lib/server/wallet-holdings';

// GET /api/wallet/holdings — the signed-in wallet's tokens on Robinhood Chain,
// read from the chain (lib/server/wallet-holdings.ts). Only ever the session's
// own wallet, so this is not a lookup service for arbitrary addresses.

const RATE_LIMIT = { windowSeconds: 60, maxRequests: 20 };

export async function GET() {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase is not configured on this deployment yet.' }, { status: 503 });
  }
  const auth = await requireSession();
  if (!auth.ok) return auth.response;

  const admin = supabaseAdmin();
  const limit = await checkRateLimit(admin, `wallet-holdings:${auth.session.userId}`, RATE_LIMIT);
  if (!limit.allowed) return NextResponse.json(rateLimitedResponseBody(limit.retryAfterSeconds), { status: 429 });

  try {
    const holdings = await getWalletHoldings(admin, getRobinhoodPublicClient(), getDisplayPriceProvider(), auth.session.walletAddress);
    return NextResponse.json(holdings);
  } catch (err) {
    return NextResponse.json({ error: `Could not read your wallet: ${(err as Error).message}` }, { status: 502 });
  }
}
