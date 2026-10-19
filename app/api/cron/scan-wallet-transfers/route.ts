import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase/server';
import { requireCronSecret } from '@/lib/server/require-cron-secret';
import { getRobinhoodPublicClient } from '@/lib/blockchain/robinhood-public-client';
import { scanTrackedWalletTransfers } from '@/lib/server/wallet-transfer-scan';

// -----------------------------------------------------------------------------
// GET|POST /api/cron/scan-wallet-transfers — every minute: only the Transfer-log
// scan (lib/server/wallet-transfer-scan.ts). A wallet that sent a tracked token
// is re-read in full, so positions and Bag TVL follow within a minute or two
// instead of the hour. Cheap when nothing moved: a block-number read, one log
// read per 100 wallets, no database writes. The hourly
// /api/cron/reconcile-wallets pass keeps the full round-robin checks.
// Scheduled by netlify/functions/scan-wallet-transfers.mts; CRON_SECRET auth (fails closed).
// -----------------------------------------------------------------------------

async function handle(req: NextRequest) {
  const authError = requireCronSecret(req);
  if (authError) return authError;
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase is not configured on this deployment yet.' }, { status: 503 });
  }
  try {
    const scan = await scanTrackedWalletTransfers(supabaseAdmin(), getRobinhoodPublicClient());
    return NextResponse.json({ scan });
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
