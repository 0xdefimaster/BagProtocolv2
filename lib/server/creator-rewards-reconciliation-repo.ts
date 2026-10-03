import { SupabaseClient } from '@supabase/supabase-js';
import { ReconciliationRepo, ReconciliationRepoRow } from './creator-rewards-reconciliation';

// -----------------------------------------------------------------------------
// Real Supabase-backed ReconciliationRepo — the implementation
// runReconciliation() has needed since it was written, but never had (see
// docs/CREATOR_REWARDS_SETTLEMENT.md's "not yet done" list). Read-only, by
// design (the reconciliation job itself never writes — see that file's
// module doc).
// -----------------------------------------------------------------------------

interface Row {
  id: string;
  status: ReconciliationRepoRow['status'];
  settlement_ref_id: string | null;
  updated_at: string;
}

export function createSupabaseReconciliationRepo(admin: SupabaseClient): ReconciliationRepo {
  return {
    async getRowsToReconcile() {
      // CONFIRMED (Case A) or currently in-flight (Cases B/C) — see
      // runReconciliation()'s own doc for why terminal FAILED/CANCELLED
      // and not-yet-attempted EARNED rows are out of scope.
      const { data, error } = await admin
        .from('creator_reward_settlements')
        .select('id, status, settlement_ref_id, updated_at')
        .in('status', ['CONFIRMED', 'SUBMITTED', 'PENDING_SETTLEMENT'])
        .returns<Row[]>();
      if (error) throw new Error(`getRowsToReconcile failed: ${error.message}`);
      return (data ?? []).map((row) => ({
        id: row.id,
        status: row.status,
        settlementRefId: row.settlement_ref_id,
        updatedAtMs: new Date(row.updated_at).getTime(),
      }));
    },
  };
}
