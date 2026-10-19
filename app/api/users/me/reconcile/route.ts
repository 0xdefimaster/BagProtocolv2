import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth/require-session';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase/server';
import { getRobinhoodPublicClient } from '@/lib/blockchain/robinhood-public-client';
import {
  RECONCILE_AFTER_TRADE_MIN_INTERVAL_MS,
  RECONCILE_ON_CONNECT_MIN_INTERVAL_MS,
  reconcileWalletOnConnect,
} from '@/lib/server/wallet-reconciliation';

// -----------------------------------------------------------------------------
// POST /api/users/me/reconcile — checks the signed-in user's own wallet against
// what BAG tracks for it (Accounting V2 / A2), called once when the wallet
// connects. At most once every few minutes per user (an earlier check is
// reused). The hourly pass covers wallets that do not come back. `{ "reason": "trade" }`
// (sent after a Swap or sweep from this app) allows a check every 30 seconds instead.
// Nothing in the request is trusted: the wallet is the session's, the balances come from the chain.
// -----------------------------------------------------------------------------

export async function POST(req?: Request) {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase is not configured on this deployment yet.' }, { status: 503 });
  }
  const auth = await requireSession();
  if (!auth.ok) return auth.response;
  const body = req ? ((await req.json().catch(() => null)) as { reason?: unknown } | null) : null;
  const minIntervalMs = body?.reason === 'trade' ? RECONCILE_AFTER_TRADE_MIN_INTERVAL_MS : RECONCILE_ON_CONNECT_MIN_INTERVAL_MS;
  try {
    const outcome = await reconcileWalletOnConnect(
      supabaseAdmin(),
      getRobinhoodPublicClient(),
      { userId: auth.session.userId, walletAddress: auth.session.walletAddress },
      Date.now(),
      minIntervalMs
    );
    return NextResponse.json(outcome);
  } catch {
    return NextResponse.json({ error: 'Could not check the wallet right now.' }, { status: 503 });
  }
}
