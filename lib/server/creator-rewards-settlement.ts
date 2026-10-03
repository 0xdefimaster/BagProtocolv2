import { keccak256, stringToHex } from 'viem';
import { quoteDecimalToRewardTokenRaw, ROBINHOOD_REWARD_TOKEN, assertRobinhoodChainMainnetLike } from '@/lib/config/robinhood-chain';

// -----------------------------------------------------------------------------
// The "activities -> on-chain vault credit" bridge this codebase has never
// had. Only handles the FORK ROYALTY path — performance fees settle
// atomically via RedeemFeeRouter (contracts/RedeemFeeRouter.sol) at redeem
// time and never touch this worker; see 0014's migration doc block for why
// the two paths differ (fork royalty is resolved mid a cross-chain LI.FI
// purchase flow, which can't yet be made atomic with the vault call the way
// a same-chain redeem swap can).
//
// Dependency-injected on purpose (Repo + Chain interfaces below) so this
// file's actual settlement LOGIC — the part with real correctness
// requirements (idempotency, retry-safety, never-double-pay) — is testable
// without a live Supabase instance or live RPC access, neither of which
// this environment can reach. See __tests__/creator-rewards-settlement.test.ts.
// -----------------------------------------------------------------------------

export type SettlementStatus = 'EARNED' | 'PENDING_SETTLEMENT' | 'SUBMITTED' | 'CONFIRMED' | 'FAILED' | 'RETRYABLE' | 'CANCELLED';

export interface RewardSettlementRow {
  id: string;
  creatorId: string;
  creatorWallet: string;
  grossAmountQuote: string;
  status: SettlementStatus;
  attemptCount: number;
  settlementRefId: string | null;
  onchainTxHash: string | null;
  /** Milliseconds since epoch this row's status last changed — needed to tell "just submitted, still pending" apart from "stuck". */
  updatedAtMs: number;
}

/** The subset of Supabase access this worker needs — implemented for real against `supabase-js` in production, and by an in-memory fake in tests. */
export interface RewardSettlementRepo {
  /** Calls the `claim_reward_settlement_batch` RPC (0014) — row-locks and marks a batch PENDING_SETTLEMENT, `for update skip locked`, so concurrent worker instances never grab the same row. */
  claimBatch(workerId: string, limit: number): Promise<RewardSettlementRow[]>;
  markSubmitted(id: string, refId: string, txHash: string): Promise<void>;
  markConfirmed(id: string): Promise<void>;
  markFailed(id: string, reason: string, retryable: boolean): Promise<void>;
  /**
   * P0 crash-recovery fix: rows that reached SUBMITTED more than
   * `olderThanMs` ago and are STILL SUBMITTED. `claimBatch` only ever
   * selects EARNED/RETRYABLE (0014's RPC), so without this a row a worker
   * crashed on right after `markSubmitted` (before `markConfirmed`) would
   * stay SUBMITTED forever — no code path would ever look at it again,
   * even though the reward may have genuinely settled on-chain already.
   */
  getStuckSubmitted(olderThanMs: number): Promise<RewardSettlementRow[]>;
  /** SUBMITTED -> RETRYABLE only (status-guarded, same lost-update protection as markFailed) — used by reconcileStuckSubmissions when refUsed is false and the row has sat SUBMITTED past the staleness threshold. Safe: the deterministic refId never changes, so even a late-landing original tx is simply rejected by the vault's own refUsed guard rather than causing a double-pay. */
  markSubmittedRetryable(id: string, reason: string): Promise<void>;
}

/** The subset of on-chain access this worker needs — implemented for real with viem's public/wallet clients against Robinhood Chain, and by an in-memory fake in tests. */
export interface VaultChainClient {
  chainId: number;
  /** Calls `CreatorRewardsVault.settleReward(creator, amountRaw, refId)`. Must throw if the transaction reverts (including a `RefAlreadyUsed` revert — see below) — never resolve on a failed settlement. */
  settleReward(args: { creator: `0x${string}`; amountRaw: bigint; refId: `0x${string}` }): Promise<{ txHash: string }>;
  /** `CreatorRewardsVault.refUsed(refId)` — the single source of truth reconcileStuckSubmissions uses to tell a genuinely-confirmed SUBMITTED row apart from a dropped/reverted/never-landed one. */
  isRefUsed(refId: `0x${string}`): Promise<boolean>;
}

/**
 * Deterministic vault `refId` for a given settlement row. NEVER random —
 * a retried job (same row id) must recompute the exact same refId every
 * time, so `CreatorRewardsVault.refUsed` naturally rejects a genuine
 * duplicate submission on-chain even if this worker's own DB-level
 * status check somehow raced or was bypassed. This is the "same unique
 * reward event becomes bytes32 refId" requirement.
 */
export function deterministicRefId(settlementRowId: string): `0x${string}` {
  return keccak256(stringToHex(`creator_reward_settlements:${settlementRowId}`));
}

export interface StuckSubmissionReconciliationResult {
  checked: number;
  confirmed: number;
  markedRetryable: number;
}

/**
 * P0 crash-recovery fix. Handles exactly the case `runSettlementBatch`'s
 * own claim/submit/confirm loop cannot recover from by itself: a row that
 * reached SUBMITTED and then the worker process died (or threw) before
 * calling `markConfirmed` — nothing in `claimBatch` (EARNED/RETRYABLE only)
 * would ever look at that row again. Implements the exact A/B/C/D/E state
 * table from the hardening brief:
 *
 *   A) refUsed(refId) === true  -> the reward genuinely settled on-chain;
 *      SUBMITTED -> CONFIRMED. Never re-send a transaction for it.
 *   B) still within `olderThanMs` of being marked SUBMITTED -> left alone
 *      (not even fetched by `getStuckSubmitted` — may simply still be
 *      pending in the mempool).
 *   C) / D) refUsed(refId) === false past the staleness threshold -> safe
 *      to mark RETRYABLE. "Safe" specifically because the refId is
 *      deterministic (`deterministicRefId`) and unchanged by a retry: if
 *      the original transaction were to land late after this, the vault's
 *      own `RefAlreadyUsed` guard rejects the resubmission rather than
 *      double-paying — `runSettlementBatch`'s existing
 *      `isRefAlreadyUsedError` handling already treats that as a confirm,
 *      not an error. This is what makes D) ("refUsed == true: never
 *      resubmit") true even under a race between this reconciliation pass
 *      and a very-late original transaction.
 *   E) SUBMITTED with no `settlementRefId` recorded at all (should not
 *      happen given `markSubmitted` always sets refId+txHash together,
 *      but defensively handled rather than assumed impossible) -> treated
 *      the same as "unverifiable, safe to retry": no refId means no ref
 *      was ever consumed on-chain by this row, so nothing can be
 *      double-paid by retrying.
 *
 * Never calls `settleReward` itself — only ever reads chain state and
 * updates DB status. The actual resubmission happens naturally on the
 * NEXT `runSettlementBatch` call, since RETRYABLE rows are exactly what
 * `claimBatch` picks up.
 */
export async function reconcileStuckSubmissions(
  repo: RewardSettlementRepo,
  chain: VaultChainClient,
  olderThanMs = 15 * 60 * 1000 // 15 minutes — generous for an L2, short enough that a genuinely stuck row doesn't sit unresolved for hours
): Promise<StuckSubmissionReconciliationResult> {
  assertRobinhoodChainMainnetLike(chain.chainId);

  const stuck = await repo.getStuckSubmitted(olderThanMs);
  const result: StuckSubmissionReconciliationResult = { checked: stuck.length, confirmed: 0, markedRetryable: 0 };

  for (const row of stuck) {
    if (!row.settlementRefId) {
      await repo.markSubmittedRetryable(row.id, 'SUBMITTED with no settlement_ref_id recorded — cannot verify on-chain state, safe to retry since no ref was ever consumed.');
      result.markedRetryable += 1;
      continue;
    }
    const used = await chain.isRefUsed(row.settlementRefId as `0x${string}`);
    if (used) {
      await repo.markConfirmed(row.id);
      result.confirmed += 1;
    } else {
      await repo.markSubmittedRetryable(row.id, `Stuck SUBMITTED for over ${olderThanMs}ms with refUsed=false on-chain — marking retryable for resubmission.`);
      result.markedRetryable += 1;
    }
  }

  return result;
}

export interface SettlementRunResult {
  processed: number;
  confirmed: number;
  failed: number;
  errors: { rowId: string; error: string }[];
  /** Populated by the crash-recovery pass this function now runs FIRST, before claiming any new batch — see `reconcileStuckSubmissions`. */
  reconciliation: StuckSubmissionReconciliationResult;
}

/**
 * Processes one batch of pending fork-royalty settlements. Safe to call
 * concurrently from multiple worker instances/processes — see
 * `claimBatch`'s `skip locked` semantics — and safe to call again on a
 * row that already reached SUBMITTED (e.g. the worker crashed after
 * submitting but before marking CONFIRMED): `settleReward`'s on-chain
 * `refUsed` guard makes a resubmission of an ALREADY-CONFIRMED refId
 * revert rather than double-pay, and this function treats that specific
 * revert as "already settled, treat as confirmed" rather than a real
 * failure — see the `RefAlreadyUsed` handling below. This is what makes
 * "worker crashes after tx submission" (section 17's required test case)
 * safe to simply retry.
 *
 * Runs `reconcileStuckSubmissions` FIRST, every call — this is the actual
 * P0 crash-recovery fix: a row stuck SUBMITTED from a PAST crashed run
 * (not just this run) is swept for real on-chain state and moved to
 * CONFIRMED or RETRYABLE before any new EARNED/RETRYABLE row is claimed,
 * so a permanently-stuck SUBMITTED row is no longer possible as long as
 * this function keeps getting called on a schedule (see
 * app/api/cron/settle-creator-rewards).
 */
export async function runSettlementBatch(
  repo: RewardSettlementRepo,
  chain: VaultChainClient,
  workerId: string,
  limit = 20
): Promise<SettlementRunResult> {
  assertRobinhoodChainMainnetLike(chain.chainId);

  const reconciliation = await reconcileStuckSubmissions(repo, chain);

  const batch = await repo.claimBatch(workerId, limit);
  const result: SettlementRunResult = { processed: 0, confirmed: 0, failed: 0, errors: [], reconciliation };

  for (const row of batch) {
    result.processed += 1;
    const refId = deterministicRefId(row.id);
    let amountRaw: bigint;
    try {
      amountRaw = quoteDecimalToRewardTokenRaw(row.grossAmountQuote);
    } catch (err) {
      // Malformed money value is a data bug, not a transient failure —
      // never retryable, never guess a "close enough" amount.
      const wrappedMessage = `invalid grossAmountQuote: ${String(err)}`;
      await repo.markFailed(row.id, wrappedMessage, false);
      result.failed += 1;
      result.errors.push({ rowId: row.id, error: wrappedMessage });
      continue;
    }

    try {
      const { txHash } = await chain.settleReward({
        creator: row.creatorWallet as `0x${string}`,
        amountRaw,
        refId,
      });
      await repo.markSubmitted(row.id, refId, txHash);
      await repo.markConfirmed(row.id);
      result.confirmed += 1;
    } catch (err) {
      const message = String(err);
      if (isRefAlreadyUsedError(message)) {
        // The exact "worker crashed after a prior submission actually
        // landed on-chain, now retries" case: the vault already has this
        // refId marked used, so the reward WAS settled — this is success,
        // not a failure, and must not be retried again.
        await repo.markSubmitted(row.id, refId, 'unknown-prior-tx');
        await repo.markConfirmed(row.id);
        result.confirmed += 1;
        continue;
      }
      const retryable = isTransientError(message);
      await repo.markFailed(row.id, message, retryable);
      result.failed += 1;
      result.errors.push({ rowId: row.id, error: message });
    }
  }

  return result;
}

function isRefAlreadyUsedError(message: string): boolean {
  return message.includes('RefAlreadyUsed');
}

/** Network/RPC hiccups are retryable; everything else (insufficient funds, reverted for a real reason, bad input) is not — never blindly retry-forever on an error we don't recognize. */
function isTransientError(message: string): boolean {
  return /timeout|ECONNRESET|ETIMEDOUT|rate limit|429|nonce too low|replacement transaction underpriced/i.test(message);
}

export { ROBINHOOD_REWARD_TOKEN };
