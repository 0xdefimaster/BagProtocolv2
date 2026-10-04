import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase/server';
import { getRobinhoodPublicClient } from '@/lib/blockchain/robinhood-public-client';
import { addressesInActivity, verifyAlchemySignature } from '@/lib/server/alchemy-webhook';
import { reconcileWallet, trackedAssetsForUser } from '@/lib/server/wallet-reconciliation';

// -----------------------------------------------------------------------------
// POST /api/webhooks/alchemy/address-activity — real-time trigger for wallet
// reconciliation (Accounting V2 / A2). An Alchemy ADDRESS_ACTIVITY webhook on
// Robinhood Chain calls this when a watched wallet moves tokens.
//
// The payload is only a hint about WHICH wallets to re-check: no amount,
// token or hash from it is trusted. Balances are re-read from the chain by
// reconcileWallet. Signed with the webhook's signing key
// (ALCHEMY_WEBHOOK_SIGNING_KEY); fails closed when the key is not set.
// -----------------------------------------------------------------------------

const MAX_WALLETS_PER_CALL = 10;

export async function POST(req: NextRequest) {
  const signingKey = process.env.ALCHEMY_WEBHOOK_SIGNING_KEY;
  if (!signingKey) return NextResponse.json({ error: 'Webhook is not configured.' }, { status: 503 });
  if (!isSupabaseConfigured()) return NextResponse.json({ error: 'Supabase is not configured on this deployment yet.' }, { status: 503 });

  const raw = await req.text();
  if (!verifyAlchemySignature(raw, req.headers.get('x-alchemy-signature'), signingKey)) {
    return NextResponse.json({ error: 'Invalid signature.' }, { status: 401 });
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON.' }, { status: 400 });
  }

  const addresses = addressesInActivity(payload).slice(0, 50);
  if (addresses.length === 0) return NextResponse.json({ reconciled: 0 });

  const admin = supabaseAdmin();
  const { data, error } = await admin.from('users').select('id, wallet_address').in('wallet_address', addresses);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const client = getRobinhoodPublicClient();
  let reconciled = 0;
  for (const u of ((data ?? []) as { id: string; wallet_address: string }[]).slice(0, MAX_WALLETS_PER_CALL)) {
    try {
      const assets = await trackedAssetsForUser(admin, u.id);
      if (assets.length === 0) continue;
      await reconcileWallet(admin, client, { userId: u.id, walletAddress: u.wallet_address, assets });
      reconciled++;
    } catch {
      // The 5-minute pass will retry this wallet.
    }
  }
  return NextResponse.json({ reconciled });
}
