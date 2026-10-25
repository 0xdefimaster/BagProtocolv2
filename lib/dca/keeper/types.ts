import type { Hex } from 'viem';
import type { RecurringAuthorization, RecurringDeployment } from '../../../packages/bag-sdk/src/recurring';

// -----------------------------------------------------------------------------
// lib/dca/keeper — persistent keeper for RecurringPurchaseExecutor
// (contracts/dca/). The CHAIN is the source of truth for every right the owner
// signed: runs used, budget used, last window and revocation come from
// `getState(owner, id)` on every step. The store only caches what was observed
// and holds the write-ahead record of a transaction in flight, so a restart, a
// second keeper or even a lost store cannot reset a budget or reopen a window.
// -----------------------------------------------------------------------------

/** What a job is waiting for. Derived from chain counters on every step, never trusted from the store. */
export type KeeperJobState =
  /** Before `startsAt`. */
  | 'SCHEDULED'
  /** The current window has no purchase yet; the next step tries. */
  | 'DUE'
  /** A transaction for the current window is in flight (write-ahead record present). */
  | 'PENDING_TX'
  /** Purchased in the current window; `nextDueAt` says when the next one opens. */
  | 'DONE_THIS_WINDOW'
  /** Every allowed tier quotes beyond the owner's limit; retried within the window, never consumed. */
  | 'WAITING_PRICE'
  | 'NO_ROUTE'
  /** Owner balance or allowance below one run. Nothing is consumed. */
  | 'FUNDING_SHORTAGE'
  /** The keeper account cannot pay for the transaction. Visible, nothing is sent. */
  | 'GAS_SHORTAGE'
  /** The pre-flight simulation reverted for another reason (recorded); nothing is sent. */
  | 'SIMULATION_REVERTED'
  | 'COMPLETED'
  | 'EXPIRED'
  | 'REVOKED'
  /** A read failed (RPC); the step is retried. */
  | 'RPC_ERROR';

export const TERMINAL_STATES: readonly KeeperJobState[] = ['COMPLETED', 'EXPIRED', 'REVOKED'];

/** `getState` of the executor. */
export interface ChainExecutionState {
  executions: number;
  grossUsed: bigint;
  lastWindow: bigint;
  lastExecutionAt: bigint;
  revoked: boolean;
}

/** Write-ahead record: stored BEFORE the transaction is sent, completed with the hash right after. */
export interface PendingTx {
  window: bigint;
  /** The keeper account and the nonce chosen for this transaction. */
  from: Hex;
  nonce: number;
  hash: Hex | null;
  preparedAt: number;
}

export interface ConfirmedRun {
  window: bigint;
  executionIndex: bigint | null;
  hash: Hex;
  blockNumber: bigint;
  /** SDK `verifyRecurringPurchaseReceipt` status for this receipt. */
  verification: 'VERIFIED' | 'FAILED';
  issues: string[];
}

export interface AttemptRecord {
  at: number;
  window: bigint | null;
  /** REVERTED: mined, reverted. NONCE_USED_ELSEWHERE: the nonce was mined without a purchase for this window (our tx reverted
   *  before its hash was stored, or it was replaced). DROPPED: never mined, gone from the mempool. UNSENT: crashed before sending. */
  outcome: 'REVERTED' | 'NONCE_USED_ELSEWHERE' | 'DROPPED' | 'UNSENT' | 'SIMULATION_REVERTED';
  detail: string;
  hash?: Hex | null;
}

export interface KeeperJob {
  /** The authorization id (EIP-712 digest); equal to the executor's `authorizationIdOf`. */
  id: Hex;
  deployment: RecurringDeployment & { router: Hex };
  authorization: RecurringAuthorization;
  ownerSignature: Hex;
  /** Optional EIP-2612 permit proof for the first run (ALLOWANCE). Dropped once a run is confirmed. */
  fundingProof: Hex | null;
  createdAt: number;
  /** Block when the job was added: `PurchaseExecuted` logs are searched from here. */
  fromBlock: bigint;
  state: KeeperJobState;
  stateDetail: string | null;
  /** Unix seconds when the next window opens (DONE_THIS_WINDOW / SCHEDULED). */
  nextDueAt: bigint | null;
  /** Last counters read from the chain (a cache for display; every step re-reads). */
  observed: (ChainExecutionState & { at: bigint }) | null;
  pending: PendingTx | null;
  confirmed: ConfirmedRun[];
  attempts: AttemptRecord[];
  lease: { holder: string; until: number } | null;
}
