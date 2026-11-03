import type { Hex } from 'viem';
import type { DcaAuthorization, DcaDeployment, DcaRunState } from '../../../packages/bag-sdk/src/dca';

// -----------------------------------------------------------------------------
// lib/dca/keeper — the automated-DCA keeper for contracts/dca/BagDcaExecutor.
//
// The CHAIN is the source of truth. Runs used, budget used, last window and
// revocation are read from `getState(owner, id)` on every step; the executor
// itself refuses a second run in a window, so no keeper bug, restart, second
// keeper or lost database can double-spend a window. The store holds what the
// keeper observed, the write-ahead record of a transaction in flight, the
// log of attempts and of windows that closed without a run.
// -----------------------------------------------------------------------------

/** What a job is waiting for. Derived from chain counters on every step, never trusted from the store. */
export type KeeperJobState =
  | 'SCHEDULED'
  | 'DUE'
  | 'PENDING_TX'
  | 'DONE_THIS_WINDOW'
  /** An asset quotes above its signed ceiling at every allowed fee tier. Retried within the window, never consumed. */
  | 'WAITING_PRICE'
  | 'NO_ROUTE'
  | 'FUNDING_SHORTAGE'
  | 'GAS_SHORTAGE'
  | 'SIMULATION_REVERTED'
  | 'RPC_ERROR'
  | 'COMPLETED'
  | 'EXPIRED'
  | 'REVOKED';

export const TERMINAL_STATES: readonly KeeperJobState[] = ['COMPLETED', 'EXPIRED', 'REVOKED'];

/** Why a window closed without a run. NOT_OBSERVED: no keeper step ran in it. */
export type MissedReason =
  | 'WAITING_PRICE'
  | 'NO_ROUTE'
  | 'FUNDING_SHORTAGE'
  | 'GAS_SHORTAGE'
  | 'SIMULATION_REVERTED'
  | 'TX_NOT_INCLUDED'
  | 'RPC_ERROR'
  | 'NOT_OBSERVED';

/** Write-ahead record: stored BEFORE the transaction is sent and completed with the hash right after. */
export interface PendingTx {
  window: bigint;
  from: Hex;
  nonce: number;
  /** The latest broadcast hash (a replacement or cancel supersedes the previous one). */
  hash: Hex | null;
  /** Every hash broadcast with this nonce: the original, replacements and a cancel. Any one of them may be mined. */
  hashes?: Hex[];
  /** Legacy gas price (wei) of the latest broadcast; replacements bump it. */
  gasPrice?: bigint;
  lastSentAt?: number;
  replacements?: number;
  /** A cancel (0-value self-transfer with this nonce) was sent because the run's deadline passed. */
  cancelling?: boolean;
  preparedAt: number;
  /** The exact RunParams prepared (fees, floors, deadline): what the mined call is compared with. */
  run: { window: bigint; deadline: bigint; fees: number[]; minOutFloors: bigint[] };
}

export interface ConfirmedRun {
  window: bigint;
  executionIndex: bigint;
  hash: Hex;
  blockNumber: bigint;
  blockHash: Hex;
  /** SDK verifyDcaReceipt. INDETERMINATE is never counted as VERIFIED. */
  verification: 'VERIFIED' | 'FAILED' | 'INDETERMINATE';
  issues: string[];
  /** Set when a later check found the block was reorganised away. */
  reorged: boolean;
  /** The block is at or below the chain's finalized block (or `reorgDepth` deep when the RPC has no finalized tag). */
  finalized?: boolean;
  /** The executor's runtime code hash was checked against the reviewed build when this run was verified. */
  codeChecked?: boolean;
}

export interface MissedWindow {
  window: bigint;
  reason: MissedReason;
  detail: string | null;
}

export interface AttemptRecord {
  at: number;
  window: bigint | null;
  outcome: 'REVERTED' | 'NONCE_USED_ELSEWHERE' | 'DROPPED' | 'UNSENT' | 'SIMULATION_REVERTED' | 'REORGED' | 'REPLACED' | 'CANCEL_SENT' | 'CANCELLED';
  detail: string;
  hash?: Hex | null;
}

export interface KeeperJob {
  /** The authorization id (EIP-712 digest), lowercase. */
  id: Hex;
  deployment: DcaDeployment;
  authorization: DcaAuthorization;
  ownerSignature: Hex;
  createdAt: number;
  /** Block when the job was added: executor logs are searched from here. */
  fromBlock: bigint;
  state: KeeperJobState;
  stateDetail: string | null;
  /** Unix seconds when the next check is useful (next window, start, retry). */
  nextDueAt: bigint | null;
  observed: (DcaRunState & { at: bigint }) | null;
  pending: PendingTx | null;
  confirmed: ConfirmedRun[];
  /** Last blocker of the current window; becomes a MissedWindow when the window closes without a run. */
  blocker: { window: bigint; reason: MissedReason; detail: string | null } | null;
  /** Windows below this index are accounted for (bought or in `missed`). */
  accountedThrough: bigint;
  missed: MissedWindow[];
  attempts: AttemptRecord[];
  lease: { holder: string; until: number } | null;
}
