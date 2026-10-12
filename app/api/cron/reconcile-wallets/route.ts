import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase/server';
import { requireCronSecret } from '@/lib/server/require-cron-secret';
import { getRobinhoodPublicClient } from '@/lib/blockchain/robinhood-public-client';
import { reconcileDueWallets } from '@/lib/server/wallet-reconciliation';
import { scanTrackedWalletTransfers } from '@/lib/server/wallet-transfer-scan';

// -----------------------------------------------------------------------------
// GET|POST /api/cron/reconcile-wallets — the hourly wallet reconciliation
// pass (Accounting V2 / A2): every holder through Transfer logs
// (lib/server/wallet-transfer-scan.ts), wallets that moved re-read in full,
// drift confirmed; then a few least recently checked wallets in full. Scheduled by
// netlify/functions/reconcile-wallets.mts; CRON_SECRET auth (fails closed).
// -----------------------------------------------------------------------------

const ROUND_ROBIN_BATCH = 5;

async function handle(req: NextRequest) {
  const authError = requireCronSecret(req);
  if (authError) return authError;
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase is not configured on this deployment yet.' }, { status: 503 });
  }
  try {
    const admin = supabaseAdmin();
    const client = getRobinhoodPublicClient();
    // Every holder through Transfer logs first; then a few wallets in full, least recently checked first
    // (wallets the scan does not cover, and a safety net for anything a log scan cannot see).
    const scan = await scanTrackedWalletTransfers(admin, client);
    const roundRobin = await reconcileDueWallets(admin, client, ROUND_ROBIN_BATCH);
    return NextResponse.json({ scan, roundRobin });
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
