import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase/server';
import { requireCronSecret } from '@/lib/server/require-cron-secret';
import { getRobinhoodPublicClient } from '@/lib/blockchain/robinhood-public-client';
import { reconcileDueWallets } from '@/lib/server/wallet-reconciliation';

// -----------------------------------------------------------------------------
// GET|POST /api/cron/reconcile-wallets — the 5-minute safety pass of wallet
// reconciliation (Accounting V2 / A2, lib/server/wallet-reconciliation.ts):
// re-reads balances for the least recently checked users so a missed webhook
// is corrected, and confirms drift that has persisted. Scheduled by
// netlify/functions/reconcile-wallets.mts; CRON_SECRET auth (fails closed).
// -----------------------------------------------------------------------------

async function handle(req: NextRequest) {
  const authError = requireCronSecret(req);
  if (authError) return authError;
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase is not configured on this deployment yet.' }, { status: 503 });
  }
  try {
    return NextResponse.json(await reconcileDueWallets(supabaseAdmin(), getRobinhoodPublicClient()));
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
