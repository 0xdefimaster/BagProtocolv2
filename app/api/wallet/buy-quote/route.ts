import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth/require-session';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase/server';
import { getChainPublicClient } from '@/lib/blockchain/rpc/clients';
import { isBagChain } from '@/lib/config/chains';
import { checkRateLimit, rateLimitedResponseBody } from '@/lib/server/rate-limit';
import { quoteWalletBuy, BuyQuoteRequest } from '@/lib/server/wallet-holdings';

// POST /api/wallet/buy-quote — compiles ONE LI.FI Composer transaction that
// buys the chosen registry tokens on one chain for the signed-in wallet, paid
// with ETH (no approval) or the chain's stablecoin. Nothing is signed here:
// the wallet signs it in the browser. Body:
//   { chain?, pay?: 'NATIVE' | 'STABLE', amountRaw, buys: [{ address, weightBps }], acceptedPriceImpactBps? }

const RATE_LIMIT = { windowSeconds: 60, maxRequests: 10 };

export async function POST(req: Request) {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase is not configured on this deployment yet.' }, { status: 503 });
  }
  const auth = await requireSession();
  if (!auth.ok) return auth.response;

  let body: BuyQuoteRequest;
  try {
    body = (await req.json()) as BuyQuoteRequest;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }
  const chain = body?.chain ?? 'robinhood';
  if (typeof chain !== 'string' || !isBagChain(chain)) return NextResponse.json({ error: `Unknown chain ${String(chain)}.` }, { status: 400 });

  const admin = supabaseAdmin();
  const limit = await checkRateLimit(admin, `wallet-buy:${auth.session.userId}`, RATE_LIMIT);
  if (!limit.allowed) return NextResponse.json(rateLimitedResponseBody(limit.retryAfterSeconds), { status: 429 });

  try {
    const result = await quoteWalletBuy(admin, getChainPublicClient(chain), auth.session.walletAddress, body, { apiKey: process.env.LIFI_API_KEY }, chain);
    if (!result.ok) {
      return NextResponse.json({ error: result.error, ...(result.composerFallback ? { composerFallback: result.composerFallback } : {}) }, { status: result.status });
    }
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
