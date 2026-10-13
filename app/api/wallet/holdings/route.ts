import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth/require-session';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase/server';
import { getChainPublicClient } from '@/lib/blockchain/rpc/clients';
import { BAG_CHAINS_LIST, isBagChain } from '@/lib/config/chains';
import { getDisplayPriceProvider } from '@/lib/server/price-provider';
import { checkRateLimit, rateLimitedResponseBody } from '@/lib/server/rate-limit';
import { getWalletHoldings, getWalletHoldingsAllChains } from '@/lib/server/wallet-holdings';

// GET /api/wallet/holdings — the signed-in wallet's tokens, read from the chain
// (lib/server/wallet-holdings.ts). Only ever the session's own wallet, so this
// is not a lookup service for arbitrary addresses.
//   ?chain=<robinhood|ethereum|arbitrum|base>  one chain (Robinhood Chain when absent)
//   ?chain=all                                 every chain: { chains: [...] }, a chain that
//                                              cannot be read carries `error` instead

const RATE_LIMIT = { windowSeconds: 60, maxRequests: 20 };

export async function GET(req: Request) {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase is not configured on this deployment yet.' }, { status: 503 });
  }
  const auth = await requireSession();
  if (!auth.ok) return auth.response;

  const admin = supabaseAdmin();
  const limit = await checkRateLimit(admin, `wallet-holdings:${auth.session.userId}`, RATE_LIMIT);
  if (!limit.allowed) return NextResponse.json(rateLimitedResponseBody(limit.retryAfterSeconds), { status: 429 });

  const chain = new URL(req.url).searchParams.get('chain') ?? 'robinhood';
  if (chain !== 'all' && !isBagChain(chain)) return NextResponse.json({ error: `Unknown chain ${chain}.` }, { status: 400 });
  try {
    if (chain === 'all') {
      const chains = await getWalletHoldingsAllChains(admin, getChainPublicClient, getDisplayPriceProvider(), auth.session.walletAddress, BAG_CHAINS_LIST);
      return NextResponse.json({ chains });
    }
    const holdings = await getWalletHoldings(admin, getChainPublicClient(chain), getDisplayPriceProvider(), auth.session.walletAddress, chain);
    return NextResponse.json(holdings);
  } catch (err) {
    return NextResponse.json({ error: `Could not read your wallet: ${(err as Error).message}` }, { status: 502 });
  }
}
