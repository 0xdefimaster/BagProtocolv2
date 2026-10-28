import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth/require-session';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase/server';
import { getChainPublicClient } from '@/lib/blockchain/rpc/clients';
import { isBagChain } from '@/lib/config/chains';
import { checkRateLimit, rateLimitedResponseBody } from '@/lib/server/rate-limit';
import { quoteWalletSweep, SweepQuoteRequest } from '@/lib/server/wallet-holdings';

// POST /api/wallet/sweep-quote — compiles ONE LI.FI Composer transaction that
// sells the chosen tokens of the signed-in wallet, on one chain, for that
// chain's stablecoin (USDG on Robinhood Chain, USDC on Ethereum/Arbitrum/Base).
// Nothing is signed here: the wallet signs it in the browser. Body:
//   { chain?, tokens: [{ address, amountRaw }], acceptedPriceImpactBps? }   (chain defaults to robinhood)

const RATE_LIMIT = { windowSeconds: 60, maxRequests: 10 };

export async function POST(req: Request) {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase is not configured on this deployment yet.' }, { status: 503 });
  }
  const auth = await requireSession();
  if (!auth.ok) return auth.response;

  let body: SweepQuoteRequest;
  try {
    body = (await req.json()) as SweepQuoteRequest;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const chain = body?.chain ?? 'robinhood';
  if (typeof chain !== 'string' || !isBagChain(chain)) return NextResponse.json({ error: `Unknown chain ${String(chain)}.` }, { status: 400 });

  const admin = supabaseAdmin();
  const limit = await checkRateLimit(admin, `wallet-sweep:${auth.session.userId}`, RATE_LIMIT);
  if (!limit.allowed) return NextResponse.json(rateLimitedResponseBody(limit.retryAfterSeconds), { status: 429 });

  try {
    const result = await quoteWalletSweep(admin, getChainPublicClient(chain), auth.session.walletAddress, body, { apiKey: process.env.LIFI_API_KEY }, chain);
    if (!result.ok) {
      return NextResponse.json({ error: result.error, ...(result.composerFallback ? { composerFallback: result.composerFallback } : {}) }, { status: result.status });
    }
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
