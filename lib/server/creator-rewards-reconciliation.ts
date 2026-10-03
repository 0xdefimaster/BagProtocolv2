import { assertRobinhoodChainMainnetLike } from '@/lib/config/robinhood-chain';

// -----------------------------------------------------------------------------
// Section 34's "reconciliation job" — the independent check this codebase
// never had: does what Supabase's `creator_reward_settlements` table
// BELIEVES happened on-chain actually match what the vault's own state
// says happened? `runSettlementBatch` (creator-rewards-settlement.ts)
// already handles the retry cases it directly causes (e.g. "worker
// crashed after tx landed"); this module is a SEPARATE, read-only sweep
// that catches everything else — including bugs in that worker itself,
// manual DB edits, or a settlement performed by some path this worker
// doesn't know about (e.g. RedeemFeeRouter inserting an
// already-CONFIRMED row directly, per 0014's doc block).
//
// Deliberately produces a REPORT, never a fix. Per the production brief:
// "The reconciliation system should NEVER automatically reverse creator
// funds. It should produce a safe actionable state." Every issue below is
// something a human (or a separate, explicitly-reviewed follow-up action)
// resolves — this module never calls settleReward, never updates a row's
// status, never touches the vault.
//
// Same dependency-injection shape as creator-rewards-settlement.ts, for
// the same reason: the actual logic (which mismatches count as which
// case) is unit-testable without a live Supabase instance or live RPC
// access, neither of which this environment can reach. See
// __tests__/creator-rewards-reconciliation.test.ts.
// -----------------------------------------------------------------------------

export type ReconciliationIssueType =
  /** Case A (spec section 34): DB says CONFIRMED with a settlement_ref_id, but the vault's `refUsed(refId)` says false. Either the CONFIRMED status was recorded in error (e.g. a bug, or a manually-edited row), or — very unlikely, but not this module's job to assume — the vault was somehow redeployed/reset. Needs human investigation; never auto-corrected. */
  | 'CONFIRMED_BUT_NOT_ONCHAIN'
  /** Case B: the vault's `refUsed(refId)` says true (the reward WAS actually settled on-chain), but the DB row for that refId isn't CONFIRMED yet. Usually a worker that crashed between the on-chain tx landing and calling markConfirmed — recoverable by re-running the settlement batch (it treats a RefAlreadyUsed revert as confirmation), but flagged here for visibility even if that hasn't happened yet. */
  | 'ONCHAIN_BUT_NOT_CONFIRMED_IN_DB'
  /** Case C: a row has been stuck in SUBMITTED or PENDING_SETTLEMENT for longer than the staleness threshold, with no on-chain refUsed=true to explain it — looks abandoned (worker crashed and never retried, or the tx is stuck/dropped from the mempool). */
  | 'STALE_PENDING'
  /** Case D: the vault's total outstanding claimable balance exceeds its actual reward-token holdings. Should be IMPOSSIBLE given `settleReward`'s atomic pull-based design (see CreatorRewardsVault.sol's NatSpec) — a hit here means either a bug in the vault, a direct token transfer out that bypassed `withdraw`, or (extremely unlikely) a non-standard reward token behaving unexpectedly. Highest-severity case; surfaced first. */
  | 'VAULT_UNDERFUNDED';

export interface ReconciliationIssue {
  type: ReconciliationIssueType;
  settlementRowId?: string;
  refId?: string;
  detail: string;
}

export interface ReconciliationReport {
  checkedRows: number;
  issues: ReconciliationIssue[];
}

export interface ReconciliationRepoRow {
  id: string;
  status: 'EARNED' | 'PENDING_SETTLEMENT' | 'SUBMITTED' | 'CONFIRMED' | 'FAILED' | 'RETRYABLE' | 'CANCELLED';
  settlementRefId: string | null;
  /** Milliseconds since epoch this row last changed status — used for the Case C staleness check. */
  updatedAtMs: number;
}

/** The subset of Supabase access this job needs. */
export interface ReconciliationRepo {
  /** Every row that is either CONFIRMED (for Case A) or currently in-flight (SUBMITTED/PENDING_SETTLEMENT, for Cases B/C) — i.e. everything worth checking against the chain. Terminal FAILED/CANCELLED/EARNED (not yet attempted) rows are out of scope: nothing on-chain should exist for them yet. */
  getRowsToReconcile(): Promise<ReconciliationRepoRow[]>;
}

/** The subset of on-chain access this job needs — reads only, matching the "never touches funds" guarantee above. */
export interface VaultReadClient {
  chainId: number;
  /** `CreatorRewardsVault.refUsed(refId)` — true iff that exact reward event has actually been settled on-chain. O(1), no event-log scanning/block-range pagination needed. */
  isRefUsed(refId: `0x${string}`): Promise<boolean>;
  /** `CreatorRewardsVault.totalOutstanding()` and the vault's own `rewardToken.balanceOf(vaultAddress)` — Case D's solvency check. */
  getSolvency(): Promise<{ totalOutstanding: bigint; vaultTokenBalance: bigint }>;
}

const DEFAULT_STALE_THRESHOLD_MS = 1000 * 60 * 60; // 1 hour — a settlement tx should confirm on an L2 well within this; longer strongly suggests something is stuck, not just slow.

export async function runReconciliation(
  repo: ReconciliationRepo,
  chain: VaultReadClient,
  now: () => number = Date.now,
  staleThresholdMs: number = DEFAULT_STALE_THRESHOLD_MS
): Promise<ReconciliationReport> {
  assertRobinhoodChainMainnetLike(chain.chainId);

  const issues: ReconciliationIssue[] = [];

  // Case D first — a vault-wide solvency problem is higher severity than
  // any single row's status mismatch, and independent of which rows we
  // even have in the DB.
  const { totalOutstanding, vaultTokenBalance } = await chain.getSolvency();
  if (vaultTokenBalance < totalOutstanding) {
    issues.push({
      type: 'VAULT_UNDERFUNDED',
      detail: `Vault holds ${vaultTokenBalance.toString()} raw reward-token units but totalOutstanding is ${totalOutstanding.toString()} — the vault cannot cover every creator's claimable balance. This should be impossible given settleReward's atomic design; treat as urgent.`,
    });
  }

  const rows = await repo.getRowsToReconcile();
  const nowMs = now();

  for (const row of rows) {
    if (row.status === 'CONFIRMED') {
      if (!row.settlementRefId) {
        // A CONFIRMED row with no refId recorded is itself a data-integrity
        // bug (every real settlement path sets this before marking
        // CONFIRMED) — can't check the chain without one, but it's exactly
        // the kind of "DB row pretending to be verified" this job exists
        // to catch, so it's still reported, not silently skipped.
        issues.push({
          type: 'CONFIRMED_BUT_NOT_ONCHAIN',
          settlementRowId: row.id,
          detail: 'Row is CONFIRMED but has no settlement_ref_id recorded — cannot verify against the chain at all.',
        });
        continue;
      }
      const onChain = await chain.isRefUsed(row.settlementRefId as `0x${string}`);
      if (!onChain) {
        issues.push({
          type: 'CONFIRMED_BUT_NOT_ONCHAIN',
          settlementRowId: row.id,
          refId: row.settlementRefId,
          detail: `Row ${row.id} is CONFIRMED with refId ${row.settlementRefId}, but CreatorRewardsVault.refUsed(refId) is false.`,
        });
      }
      continue;
    }

    // SUBMITTED / PENDING_SETTLEMENT — in-flight rows.
    if (row.settlementRefId) {
      const onChain = await chain.isRefUsed(row.settlementRefId as `0x${string}`);
      if (onChain) {
        issues.push({
          type: 'ONCHAIN_BUT_NOT_CONFIRMED_IN_DB',
          settlementRowId: row.id,
          refId: row.settlementRefId,
          detail: `refId ${row.settlementRefId} is already settled on-chain, but row ${row.id} is still ${row.status} in the DB. Re-running the settlement worker should self-heal this (RefAlreadyUsed is treated as confirmation).`,
        });
        continue; // not also stale — it's actually done, just not marked yet.
      }
    }

    const ageMs = nowMs - row.updatedAtMs;
    if (ageMs > staleThresholdMs) {
      issues.push({
        type: 'STALE_PENDING',
        settlementRowId: row.id,
        refId: row.settlementRefId ?? undefined,
        detail: `Row ${row.id} has been ${row.status} for ${Math.round(ageMs / 60000)} minutes with no matching on-chain settlement — looks stuck.`,
      });
    }
  }

  return { checkedRows: rows.length, issues };
}
