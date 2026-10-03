import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase/server';
import { runReconciliation } from '@/lib/server/creator-rewards-reconciliation';
import { createSupabaseReconciliationRepo } from '@/lib/server/creator-rewards-reconciliation-repo';
import { createVaultReadClient } from '@/lib/blockchain/creator-rewards-vault-chain-client';
import { requireCronSecret } from '@/lib/server/require-cron-secret';

// -----------------------------------------------------------------------------
// POST /api/cron/reconcile-creator-rewards — the trigger runReconciliation()
// never had. Read-only end to end (see that module's own doc: it never
// calls settleReward, never updates a row, never touches the vault) — this
// route's only job is running the check and returning the report. Acting
// on any reported issue is a deliberate, separate, human-reviewed step,
// never automated by this route.
//
// IMPORTANT: Vercel Cron triggers registered `vercel.json` paths with an
// HTTP GET request, not POST (verified against Vercel's own cron-jobs
// docs) — GET is exported below as the real entrypoint a Vercel Cron
// schedule actually hits. POST is kept for any other scheduler/manual use.
// -----------------------------------------------------------------------------

async function handle(req: NextRequest) {
  const authError = requireCronSecret(req);
  if (authError) return authError;

  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase is not configured on this deployment yet.' }, { status: 503 });
  }

  let chain;
  try {
    chain = createVaultReadClient();
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 503 });
  }

  const repo = createSupabaseReconciliationRepo(supabaseAdmin());

  try {
    const report = await runReconciliation(repo, chain);
    return NextResponse.json(report);
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
