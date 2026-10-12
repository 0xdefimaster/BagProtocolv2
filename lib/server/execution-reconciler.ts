import { SupabaseClient } from '@supabase/supabase-js';
import { TERMINAL_PURCHASE_INTENT_STATUSES } from '@/types/purchase-intent';
import { listUnsettledPurchaseIntents, touchUnsettledPurchaseIntent } from '@/lib/server/purchase-intent-repo';
import { listUnsettledRedeemIntents, touchUnsettledRedeemIntent } from '@/lib/server/redeem-intent-repo';
import { verifyExecution } from '@/lib/server/purchase-execution';
import { settleOpenRebalances } from '@/lib/server/rebalance-execution';
import { verifyRedeemExecution } from '@/lib/server/redeem-execution';

// -----------------------------------------------------------------------------
// Scheduled reconciler (netlify/functions/settle-pending-executions.mts →
// /api/cron/settle-pending-executions). Purchases and redemptions are settled
// when the user's browser calls verify; if the user leaves first, the intent
// stays SUBMITTED/CONFIRMING and its shares, holdings and fees are never
// recorded. This settles them without the user, through the SAME
// verifyExecution / verifyRedeemExecution (on-chain checked, idempotent,
// row-locked accounting), acting as the intent's own owner: the "session" is
// built from the intent's stored user and wallet, never from a request.
//
// Bounded per run, least recently checked first, skipping anything touched
// in the last minute (the buyer's own window may still be verifying it). An
// intent still pending after its check is touched, so never-mined
// transactions cannot starve newer ones. A failure on one intent never stops
// the others; it is retried on a later run.
// -----------------------------------------------------------------------------

export const RECONCILE_BATCH = 25;
export const RECONCILE_GRACE_MS = 60_000;

export interface ReconcileSummary {
  purchases: { checked: number; settled: number; failed: number };
  redeems: { checked: number; settled: number; failed: number };
  rebalances: { checked: number; settled: number; expired: number; failed: number };
}

async function settleEach<T extends { id: string; userId: string; walletAddress: string }>(
  intents: T[],
  verify: (intent: T) => Promise<{ ok: boolean; status?: string }>,
  touch: (id: string) => Promise<void>
): Promise<{ checked: number; settled: number; failed: number }> {
  let settled = 0;
  let failed = 0;
  for (const intent of intents) {
    let final = false;
    try {
      const r = await verify(intent);
      final = r.ok && !!r.status && TERMINAL_PURCHASE_INTENT_STATUSES.has(r.status as never);
      if (final) settled++;
    } catch {
      failed++;
    }
    // Still pending (or the check failed): move it to the back of the queue for the next run.
    if (!final) await touch(intent.id).catch(() => undefined);
  }
  return { checked: intents.length, settled, failed };
}

export async function reconcilePendingExecutions(admin: SupabaseClient, now = new Date()): Promise<ReconcileSummary> {
  const olderThan = new Date(now.getTime() - RECONCILE_GRACE_MS).toISOString();
  const [purchases, redeems] = await Promise.all([
    listUnsettledPurchaseIntents(admin, olderThan, RECONCILE_BATCH),
    listUnsettledRedeemIntents(admin, olderThan, RECONCILE_BATCH),
  ]);
  return {
    purchases: await settleEach(purchases, async (i) => {
      const r = await verifyExecution(admin, { userId: i.userId, walletAddress: i.walletAddress }, i.id);
      return { ok: r.ok, status: r.ok ? r.value.status : undefined };
    }, (id) => touchUnsettledPurchaseIntent(admin, id)),
    redeems: await settleEach(redeems, async (i) => {
      const r = await verifyRedeemExecution(admin, { userId: i.userId, walletAddress: i.walletAddress }, i.id);
      return { ok: r.ok, status: r.ok ? r.value.status : undefined };
    }, (id) => touchUnsettledRedeemIntent(admin, id)),
    rebalances: await settleOpenRebalances(admin, { now, limit: RECONCILE_BATCH }),
  };
}
