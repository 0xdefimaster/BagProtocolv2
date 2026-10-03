import { SupabaseClient } from '@supabase/supabase-js';
import { RewardSettlementRepo, RewardSettlementRow, SettlementStatus } from './creator-rewards-settlement';

// -----------------------------------------------------------------------------
// Real Supabase-backed RewardSettlementRepo — the implementation
// creator-rewards-settlement.ts's runSettlementBatch() has needed since
// 0014 shipped, but never had (see docs/CREATOR_REWARDS_SETTLEMENT.md's
// "not yet done" list). Every write goes through the SAME concurrency-safe
// `claim_reward_settlement_batch` RPC (0014) the rest of this codebase's
// row-locking convention uses — this file adds no new locking logic of its
// own, it only maps that RPC's rows to/from the worker's own types.
// -----------------------------------------------------------------------------

interface SettlementRow {
  id: string;
  creator_id: string;
  creator_wallet: string;
  gross_amount_quote: string;
  status: SettlementStatus;
  attempt_count: number;
  settlement_ref_id: string | null;
  onchain_tx_hash: string | null;
  updated_at: string;
}

function fromRow(row: SettlementRow): RewardSettlementRow {
  return {
    id: row.id,
    creatorId: row.creator_id,
    creatorWallet: row.creator_wallet,
    grossAmountQuote: row.gross_amount_quote,
    status: row.status,
    attemptCount: row.attempt_count,
    settlementRefId: row.settlement_ref_id,
    onchainTxHash: row.onchain_tx_hash,
    updatedAtMs: new Date(row.updated_at).getTime(),
  };
}

export function createSupabaseRewardSettlementRepo(admin: SupabaseClient): RewardSettlementRepo {
  return {
    async claimBatch(workerId, limit) {
      const { data, error } = await admin.rpc('claim_reward_settlement_batch', { p_worker_id: workerId, p_limit: limit });
      if (error) throw new Error(`claim_reward_settlement_batch failed: ${error.message}`);
      return ((data ?? []) as SettlementRow[]).map(fromRow);
    },

    async markSubmitted(id, refId, txHash) {
      // Status-guarded update (`.eq('status', 'PENDING_SETTLEMENT')`) —
      // same lost-update race guard every other *-repo.ts status
      // transition in this codebase uses. A row that somehow isn't
      // PENDING_SETTLEMENT anymore (e.g. a concurrent worker already
      // moved it) is left untouched rather than overwritten.
      const { error } = await admin
        .from('creator_reward_settlements')
        .update({ status: 'SUBMITTED', settlement_ref_id: refId, onchain_tx_hash: txHash, updated_at: new Date().toISOString() })
        .eq('id', id)
        .eq('status', 'PENDING_SETTLEMENT');
      if (error) throw new Error(`markSubmitted failed: ${error.message}`);
    },

    async markConfirmed(id) {
      const { error } = await admin
        .from('creator_reward_settlements')
        .update({ status: 'CONFIRMED', settled_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('id', id)
        .in('status', ['SUBMITTED', 'PENDING_SETTLEMENT']);
      if (error) throw new Error(`markConfirmed failed: ${error.message}`);
    },

    async markFailed(id, reason, retryable) {
      const { error } = await admin
        .from('creator_reward_settlements')
        .update({
          status: retryable ? 'RETRYABLE' : 'FAILED',
          failure_reason: reason,
          updated_at: new Date().toISOString(),
        })
        .eq('id', id)
        .eq('status', 'PENDING_SETTLEMENT');
      if (error) throw new Error(`markFailed failed: ${error.message}`);
    },

    // P0 crash-recovery fix — see creator-rewards-settlement.ts's
    // reconcileStuckSubmissions() for why this exists: `claimBatch` above
    // only ever selects EARNED/RETRYABLE, so a row stuck SUBMITTED from a
    // crashed prior run would otherwise never be looked at again by
    // anything.
    async getStuckSubmitted(olderThanMs) {
      const cutoff = new Date(Date.now() - olderThanMs).toISOString();
      const { data, error } = await admin
        .from('creator_reward_settlements')
        .select('id, creator_id, creator_wallet, gross_amount_quote, status, attempt_count, settlement_ref_id, onchain_tx_hash, updated_at')
        .eq('status', 'SUBMITTED')
        .lt('updated_at', cutoff);
      if (error) throw new Error(`getStuckSubmitted failed: ${error.message}`);
      return ((data ?? []) as SettlementRow[]).map(fromRow);
    },

    async markSubmittedRetryable(id, reason) {
      // Status-guarded on SUBMITTED specifically (not PENDING_SETTLEMENT,
      // unlike markFailed) — this transition only ever applies to rows
      // reconcileStuckSubmissions found already at SUBMITTED.
      const { error } = await admin
        .from('creator_reward_settlements')
        .update({ status: 'RETRYABLE', failure_reason: reason, updated_at: new Date().toISOString() })
        .eq('id', id)
        .eq('status', 'SUBMITTED');
      if (error) throw new Error(`markSubmittedRetryable failed: ${error.message}`);
    },
  };
}
