import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth/require-session';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase/server';
import { getRobinhoodPublicClient } from '@/lib/blockchain/robinhood-public-client';
import { reconcileWalletOnConnect } from '@/lib/server/wallet-reconciliation';

// -----------------------------------------------------------------------------
// POST /api/users/me/reconcile — checks the signed-in user's own wallet against
// what BAG tracks for it (Accounting V2 / A2), called once when the wallet
// connects. At most once every few minutes per user (an earlier check is
// reused). The hourly pass covers wallets that do not come back. Nothing in the
// request is trusted: the wallet is the session's, the balances come from the chain.
// -----------------------------------------------------------------------------

export async function POST() {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase is not configured on this deployment yet.' }, { status: 503 });
  }
  const auth = await requireSession();
  if (!auth.ok) return auth.response;
  try {
    const outcome = await reconcileWalletOnConnect(supabaseAdmin(), getRobinhoodPublicClient(), {
      userId: auth.session.userId,
      walletAddress: auth.session.walletAddress,
    });
    return NextResponse.json(outcome);
  } catch {
    return NextResponse.json({ error: 'Could not check the wallet right now.' }, { status: 503 });
  }
}
