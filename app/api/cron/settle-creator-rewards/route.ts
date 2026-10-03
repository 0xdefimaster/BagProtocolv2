import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase/server';
import { runSettlementBatch } from '@/lib/server/creator-rewards-settlement';
import { createSupabaseRewardSettlementRepo } from '@/lib/server/creator-rewards-settlement-repo';
import { createVaultChainClient } from '@/lib/blockchain/creator-rewards-vault-chain-client';
import { requireCronSecret } from '@/lib/server/require-cron-secret';

// -----------------------------------------------------------------------------
// POST /api/cron/settle-creator-rewards — the trigger runSettlementBatch()
// never had (see docs/CREATOR_REWARDS_SETTLEMENT.md's "not yet done" list).
// Intended to be called on a schedule (e.g. Vercel Cron, a k8s CronJob, or
// any external scheduler) with a shared secret — see requireCronSecret()'s
// own doc for the auth model. Idempotent and safe to invoke concurrently
// or on overlapping schedules: `claim_reward_settlement_batch`'s
// `for update skip locked` (0014) means two overlapping invocations simply
// split the pending batch rather than double-processing any row.
//
// Fails closed if CREATOR_REWARDS_VAULT_ADDRESS or
// CREATOR_REWARDS_SETTLEMENT_PRIVATE_KEY aren't configured yet — returns
// 503, never silently no-ops as if there were nothing to settle.
//
// IMPORTANT: Vercel Cron triggers registered `vercel.json` paths with an
// HTTP GET request, not POST (verified against Vercel's own cron-jobs
// docs) — GET is exported below as the real entrypoint a Vercel Cron
// schedule actually hits. POST is kept too so any other scheduler (a k8s
// CronJob, a manual curl for testing, etc.) that prefers POST still works
// identically; both run the exact same handler.
// -----------------------------------------------------------------------------

async function handle(req: NextRequest) {
  const authError = requireCronSecret(req);
  if (authError) return authError;

  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase is not configured on this deployment yet.' }, { status: 503 });
  }

  let chain;
  try {
    chain = createVaultChainClient();
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 503 });
  }

  const repo = createSupabaseRewardSettlementRepo(supabaseAdmin());
  const workerId = `cron-${process.env.VERCEL_REGION ?? 'local'}-${Date.now()}`;

  try {
    const result = await runSettlementBatch(repo, chain, workerId);
    return NextResponse.json(result);
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
