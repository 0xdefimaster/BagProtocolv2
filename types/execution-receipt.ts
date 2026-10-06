import type { ChainId } from './basket-protocol';
import type { ExecutionProviderKind } from './strategy-policy';

// -----------------------------------------------------------------------------
// Execution Receipt — the public contract for "what actually happened" in one
// purchase or redeem. Built from what BAG records (lib/server/execution-receipts.ts)
// and served by GET /api/bags/:id/executions; the basis of the future MCP
// get_execution_history() tool. JSON Schema: docs/schemas/execution-history.v2.schema.json.
//
// This contract is independent of BAG's internal state machines: internal
// intent/step statuses are mapped to the public enums below and never exposed.
// Nothing is fabricated: a value BAG did not record is null, and every value
// says where it came from. Additive changes keep `schemaVersion`; breaking ones
// bump it.
// -----------------------------------------------------------------------------

// 2: public `outcome` enums replace internal statuses; future-open nullable
// fields; pagination (hasMore/nextCursor); evidence summary; EIP-155 chainId;
// skipped assets identified by chain + address.
export const EXECUTION_HISTORY_SCHEMA_VERSION = 2;

/**
 * Overall result of an execution:
 * - `SUCCEEDED`: every swap verified and the execution was settled.
 * - `PARTIAL`: some swaps verified, others failed (only possible when swaps run as separate transactions).
 * - `FAILED`: the execution failed after a transaction was submitted.
 * - `PENDING`: a transaction was submitted and is not verified yet.
 * - `UNKNOWN`: BAG recorded a state this contract does not know; never guessed.
 */
export const EXECUTION_OUTCOMES = ['SUCCEEDED', 'PARTIAL', 'FAILED', 'PENDING', 'UNKNOWN'] as const;
export type ExecutionOutcome = (typeof EXECUTION_OUTCOMES)[number];

/**
 * Result of one step:
 * - `FILLED`: the swap was verified.
 * - `HELD`: no swap was needed; that share stayed in the input token (a "keep" step).
 * - `FAILED`: the swap failed or did not verify.
 * - `PENDING`: the swap's transaction was submitted and is not verified yet.
 * - `NOT_SUBMITTED`: no transaction was ever submitted for this swap.
 * - `UNKNOWN`: a state this contract does not know.
 */
export const STEP_OUTCOMES = ['FILLED', 'HELD', 'FAILED', 'PENDING', 'NOT_SUBMITTED', 'UNKNOWN'] as const;
export type StepOutcome = (typeof STEP_OUTCOMES)[number];

/**
 * Where a value came from:
 * - `ONCHAIN_DERIVED`: read by BAG from the confirmed transaction's receipt (ERC-20 Transfer logs to the
 *   wallet, restricted to the expected token) when the execution was verified. Checkable via the tx hash;
 *   not re-read for this response. (Different from the Passport's `ONCHAIN`, which is a recorded
 *   on-chain fact such as a deployment, not an amount derived from logs.)
 * - `EXECUTION_PLAN`: fixed when the transaction was compiled/quoted, before signing.
 * - `PROVIDER_REPORTED`: reported by the routing provider (LI.FI status API), or read from the receipt as a
 *   fallback — which one is not recorded, so the weaker claim is used.
 * - `BAG_RECORDED`: BAG's own accounting/records.
 * - `BAG_ATTESTED`: a provider quote BAG stored; an estimate, never an outcome.
 */
export const RECEIPT_FIELD_SOURCES = ['ONCHAIN_DERIVED', 'EXECUTION_PLAN', 'PROVIDER_REPORTED', 'BAG_RECORDED', 'BAG_ATTESTED'] as const;
export type ReceiptFieldSource = (typeof RECEIPT_FIELD_SOURCES)[number];

/**
 * Receipt-level summary of how the actual outputs of the FILLED swaps are evidenced (keep steps and quotes
 * never count). A shortcut only; each output's `actualSource` stays authoritative.
 * - `ONCHAIN`: every filled swap's actual output is ONCHAIN_DERIVED.
 * - `PROVIDER`: every filled swap has an actual output, at least one only PROVIDER_REPORTED.
 * - `PARTIAL`: at least one filled swap has no recorded actual output.
 * - `NONE`: no swap was filled.
 */
export const EVIDENCE_LEVELS = ['ONCHAIN', 'PROVIDER', 'PARTIAL', 'NONE'] as const;
export type EvidenceLevel = (typeof EVIDENCE_LEVELS)[number];

export interface ReceiptAsset {
  chain: ChainId;
  /** EIP-155 chain id from BAG's chain config; null for non-EVM chains. */
  chainId: number | null;
  address: string;
  /** Display only; identity is chain + address. */
  symbol: string | null;
  decimals: number | null;
}

export interface ReceiptTransaction {
  txHash: string;
  chain: ChainId;
  chainId: number | null;
  role: 'APPROVAL' | 'EXECUTION';
  /** `VERIFIED`: checked by BAG against this execution and bound to it. `REPORTED_UNVERIFIED`: submitted by the client, never verified. */
  verification: 'VERIFIED' | 'REPORTED_UNVERIFIED';
  /** The database guarantees a tx hash belongs to at most one execution. */
  claim: 'THIS_EXECUTION' | 'OTHER_EXECUTION' | 'UNCLAIMED';
}

export interface ReceiptOutput {
  stepIndex: number;
  action: 'SWAP' | 'KEEP';
  outcome: StepOutcome;
  /** The asset this step produced. */
  asset: ReceiptAsset;
  /** Redeem: the holding this step sold (`inputAmountRaw` of it). Purchase: null — the input is the receipt's `input.asset`. */
  soldAsset: ReceiptAsset | null;
  inputAmountRaw: string;
  /** BAG's verification floor: the execution was rejected below it (EXECUTION_PLAN; checked by BAG's server). */
  bagMinimumRaw: string | null;
  /** Enforced on-chain at the provider's swap boundary (LI.FI Composer only; EXECUTION_PLAN). Not a guarantee of what reached the wallet. */
  providerEnforcedMinimumRaw: string | null;
  /** What was actually received; null when BAG has no trustworthy record — never the quote. */
  actualRaw: string | null;
  actualSource: ReceiptFieldSource | null;
  /** The quote (BAG_ATTESTED), only for a swap that never filled. */
  quotedRaw: string | null;
  /** actualRaw ≥ bagMinimumRaw from recorded data; null when either is unknown. */
  minimumRespected: boolean | null;
}

export type ReceiptCheckResult = 'PASS' | 'FAIL' | 'UNKNOWN';

export interface ReceiptCheck {
  check: 'ACTUAL_AT_LEAST_MINIMUM' | 'TX_CLAIMED_BY_THIS_EXECUTION' | 'VERSION_BINDING';
  result: ReceiptCheckResult;
}

export interface ReceiptEvidence {
  level: EvidenceLevel;
  swapSteps: number;
  filledSwaps: number;
  onchainDerived: number;
  providerReported: number;
  /** Filled swaps with no per-step actual whose output is evidenced on-chain as part of `totalReceived` (one-transaction redeem). */
  coveredByTotal: number;
  /** Filled swaps without a recorded actual output, individually or as part of an on-chain total. */
  unrecorded: number;
}

/**
 * Redeem only: what reached the wallet in the output asset, over every swap step. Null unless every swap
 * filled and its output is recorded.
 * - LI.FI Composer (one transaction): every leg pays the same token in the same transaction, so only the
 *   total is observable — read from the receipt's Transfer logs to the wallet (`ONCHAIN_DERIVED`). The legs'
 *   own `actualRaw` stay null rather than show an apportionment as an outcome.
 * - One transaction per asset: the sum of the legs' actuals, with the weakest of their sources.
 */
export interface ReceiptTotalReceived {
  asset: ReceiptAsset;
  actualRaw: string;
  actualSource: ReceiptFieldSource;
  /** Sum of the legs' on-chain swap minimums; null unless every leg has one. Not a guarantee of what reached the wallet. */
  providerEnforcedMinimumRaw: string | null;
}

/**
 * A fee-paying sale settled through RedeemSettlement: the contract's own `Settled` event, as verification recorded it
 * (redeem_intents.settlement_plan.result). Every amount is what happened on-chain, never a quote or an estimate.
 */
export interface ReceiptSettlement {
  source: 'ONCHAIN_SETTLED_EVENT';
  settlementContract: string;
  txHash: string;
  asset: ReceiptAsset;
  /** What reached the settlement contract (the event's `received`). */
  grossProceedsRaw: string;
  /** received − basis − earlier losses still to recover, floored at 0 (the event's `feeBase`). */
  feeBaseRaw: string;
  performanceFeeRaw: string;
  /** What reached the wallet (the event's `userProceeds`) = gross − fee. */
  netProceedsRaw: string;
  feeRateBps: number;
  /** The cost basis of what was sold, as signed into the settlement (raw, rounded up). */
  consumedBasisRaw: string;
  /** gross − basis (before the fee); may be negative. Signed decimal string in raw units. */
  realizedPnlRaw: string;
  /** realizedPnl − fee. Signed decimal string in raw units. */
  netRealizedPnlRaw: string;
  /** Why the fee is what it is. */
  feeReason: 'CHARGED' | 'NO_GAIN' | 'GAIN_TOO_SMALL' | 'NO_FEE_RATE';
  creator: string;
}

export interface ExecutionReceipt {
  /** Stable id of the execution. Personal: only ever returned to its owner. */
  executionId: string;
  kind: 'PURCHASE' | 'REDEEM';
  outcome: ExecutionOutcome;
  /** True once the outcome can no longer change. */
  isFinal: boolean;
  bagId: string;
  /** The Bag version the execution was compiled against; null when not recorded (redeem). */
  strategyVersion: number | null;
  versionBinding: 'MATCHES_VERSION_RECORD' | 'MISMATCH' | 'VERSION_NOT_FOUND' | 'NOT_RECORDED';
  provider: ExecutionProviderKind;
  executionPlanHash: string | null;
  /** True only for the BAG Router: its on-chain ExecutionCompleted event was checked against this plan hash. */
  planHashCheckedOnchain: boolean;
  /** The owner's wallet. Personal. */
  wallet: string;
  transactions: ReceiptTransaction[];
  /** Not recorded today (always null); typed for when it is. */
  blockNumber: number | null;
  blockTimestamp: string | null;
  createdAt: string;
  /** When BAG recorded the execution as done (server time) — not a block timestamp. */
  recordedExecutedAt: string | null;
  /**
   * Purchase: the payment token paid in. Redeem: the Bag's own shares (no token; `asset` is null) — a legacy,
   * non-authoritative unit since A4 (a sale is a fraction of the holdings); what was sold is each output's
   * `soldAsset` + `inputAmountRaw`.
   */
  input: { unit: 'TOKEN' | 'BAG_SHARES'; asset: ReceiptAsset | null; amountRaw: string; decimals: number | null; source: 'EXECUTION_PLAN' };
  /** Purchase: shares minted; redeem: shares burned. */
  shares: { amountRaw: string; decimals: number; source: 'BAG_RECORDED' };
  outputs: ReceiptOutput[];
  /** Redeem only (see `ReceiptTotalReceived`); always null for a purchase. */
  totalReceived: ReceiptTotalReceived | null;
  /** Present only for a sale settled through RedeemSettlement (see `ReceiptSettlement`). */
  settlement?: ReceiptSettlement;
  evidence: ReceiptEvidence;
  policyEvaluation: {
    /** False today: the policy as it was at execution time is not stored. */
    policySnapshotAvailable: boolean;
    evaluatedAgainstVersion: number | null;
    checks: ReceiptCheck[];
    /** Purchase only: the no-route fallback that was applied, as recorded. */
    noRouteFallback: { policy: 'HOLD_INPUT' | 'REFUND'; skippedAssets: ReceiptAsset[]; unroutableWeightBps: number } | null;
  };
}

export interface ExecutionHistoryResponse {
  schemaVersion: typeof EXECUTION_HISTORY_SCHEMA_VERSION;
  bagId: string;
  /** Only the signed-in wallet's own executions are ever returned. */
  scope: 'VIEWER_OWN_EXECUTIONS';
  /** Newest first (createdAt desc, then executionId asc). */
  executions: ExecutionReceipt[];
  /** True when more executions exist after this page. */
  hasMore: boolean;
  /** Opaque; pass back as `?cursor=` to get the next page. Null when `hasMore` is false. */
  nextCursor: string | null;
}
