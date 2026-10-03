import type { ChainId } from './basket-protocol';
import type { PurchaseIntentStatus, PurchaseIntentStepStatus } from './purchase-intent';
import type { ExecutionProviderKind } from './strategy-policy';

// -----------------------------------------------------------------------------
// Execution Receipt — "what actually happened" for one purchase or redeem,
// built from what BAG already records (purchase_intents / redeem_intents and
// their verified steps, intent_tx_claims, bag_versions). Served by
// GET /api/bags/:id/executions; meant for the future MCP
// get_execution_history() tool. Nothing here is fabricated: a value BAG did not
// record is null, and every value says where it came from.
// -----------------------------------------------------------------------------

export const EXECUTION_HISTORY_SCHEMA_VERSION = 1;

/**
 * - `ONCHAIN_DERIVED`: read by BAG from the confirmed transaction's receipt (ERC-20 Transfer logs to the
 *   wallet, restricted to the expected token) when the execution was verified. Checkable via the tx hash;
 *   not re-read for this response.
 * - `EXECUTION_PLAN`: fixed when the transaction was compiled/quoted, before signing (minimums, plan hash, provider).
 * - `PROVIDER_REPORTED`: reported by the routing provider (LI.FI status API), or read from the receipt as a
 *   fallback — which one was used is not recorded, so it is labelled with the weaker claim.
 * - `BAG_RECORDED`: BAG's own accounting/records (share amounts, KEEP allocations, timestamps).
 * - `BAG_ATTESTED`: a provider quote BAG stored; an estimate, never an outcome.
 */
export type ReceiptFieldSource = 'ONCHAIN_DERIVED' | 'EXECUTION_PLAN' | 'PROVIDER_REPORTED' | 'BAG_RECORDED' | 'BAG_ATTESTED';

export interface ReceiptAsset {
  chain: ChainId;
  address: string;
  symbol: string | null;
  decimals: number | null;
}

export interface ReceiptTransaction {
  txHash: string;
  chain: ChainId;
  role: 'APPROVAL' | 'EXECUTION';
  /**
   * - `VERIFIED`: BAG verified this transaction against the execution (wallet, tokens, amounts, minimums).
   * - `REPORTED_UNVERIFIED`: submitted by the client but never verified (e.g. approvals, or a step that failed).
   */
  verification: 'VERIFIED' | 'REPORTED_UNVERIFIED';
  /** The database guarantees a tx hash belongs to at most one execution (intent_tx_claims). */
  claim: 'THIS_EXECUTION' | 'OTHER_EXECUTION' | 'UNCLAIMED';
}

export interface ReceiptOutput {
  stepIndex: number;
  action: 'SWAP' | 'KEEP';
  stepStatus: PurchaseIntentStepStatus;
  asset: ReceiptAsset;
  /** The amount this step put in (EXECUTION_PLAN). */
  inputAmountRaw: string;
  /** BAG's own verification floor for this step: the execution was rejected below it (EXECUTION_PLAN, checked by BAG's server). */
  bagMinimumRaw: string | null;
  /** The minimum the provider enforces on-chain at its swap boundary (LI.FI Composer steps only; EXECUTION_PLAN). Not a guarantee of what reached the wallet. */
  providerEnforcedMinimumRaw: string | null;
  /** What was actually received. Null when BAG has no trustworthy record of it — never the quote. */
  actualRaw: string | null;
  actualSource: ReceiptFieldSource | null;
  /** The quote, only while the step never completed (a completed step's quote is replaced by the verified amount and not kept). */
  quotedRaw: string | null;
  /** actualRaw ≥ bagMinimumRaw, from recorded data; null when either is unknown. */
  minimumRespected: boolean | null;
}

export type ReceiptCheckResult = 'PASS' | 'FAIL' | 'UNKNOWN';

export interface ReceiptCheck {
  check: 'ACTUAL_AT_LEAST_MINIMUM' | 'TX_CLAIMED_BY_THIS_EXECUTION' | 'VERSION_BINDING';
  result: ReceiptCheckResult;
}

export interface ExecutionReceipt {
  /** Stable id of the execution (the purchase/redeem intent id the owner's client already uses). */
  executionId: string;
  kind: 'PURCHASE' | 'REDEEM';
  status: PurchaseIntentStatus;
  bagId: string;
  /** The Bag version the execution was compiled against; null when not recorded (redeem). */
  strategyVersion: number | null;
  /** Whether the composition hash recorded on the execution matches that version's record. */
  versionBinding: 'MATCHES_VERSION_RECORD' | 'MISMATCH' | 'VERSION_NOT_FOUND' | 'NOT_RECORDED';
  provider: ExecutionProviderKind;
  /** Plan hash the transaction was compiled for (EXECUTION_PLAN); null on paths that do not produce one. */
  executionPlanHash: string | null;
  /** True only for the BAG Router: its on-chain ExecutionCompleted event was checked against this plan hash during verification. */
  planHashCheckedOnchain: boolean;
  wallet: string;
  transactions: ReceiptTransaction[];
  /** Not recorded by BAG today. */
  blockNumber: null;
  blockTimestamp: null;
  createdAt: string;
  /** When BAG recorded the execution as done (server time, BAG_RECORDED) — not a block timestamp. */
  recordedExecutedAt: string | null;
  /** Purchase: the payment token paid in. Redeem: the Bag's own shares (no token address; `asset` is null). */
  input: { unit: 'TOKEN' | 'BAG_SHARES'; asset: ReceiptAsset | null; amountRaw: string; decimals: number | null; source: 'EXECUTION_PLAN' };
  /** Purchase: shares minted; redeem: shares burned (BAG_RECORDED). */
  shares: { amountRaw: string; decimals: number; source: 'BAG_RECORDED' };
  outputs: ReceiptOutput[];
  policyEvaluation: {
    /** False: BAG does not store the full policy as it was at execution time; do not read today's policy as then's. */
    policySnapshotAvailable: false;
    /** The version whose recipe the execution used (immutable record); null when not recorded. */
    evaluatedAgainstVersion: number | null;
    checks: ReceiptCheck[];
    /** Purchase only: the no-route fallback that was applied, as recorded. */
    noRouteFallback: { policy: 'HOLD_INPUT' | 'REFUND'; skippedAssets: string[]; unroutableWeightBps: number } | null;
  };
}

export interface ExecutionHistoryResponse {
  schemaVersion: typeof EXECUTION_HISTORY_SCHEMA_VERSION;
  bagId: string;
  /** Only the signed-in wallet's own executions are ever returned. */
  scope: 'VIEWER_OWN_EXECUTIONS';
  executions: ExecutionReceipt[];
}
