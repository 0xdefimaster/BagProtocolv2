import { decodeEventLog, parseAbiItem } from 'viem';
import { getChainPublicClient, hasRpcEndpoint } from '@/lib/blockchain/rpc/clients';
import { isBagChain } from '@/lib/config/chains';
import { ChainId } from '@/types/basket-protocol';
import { PurchaseIntentFailureCode } from '@/types/purchase-intent';

// -----------------------------------------------------------------------------
// bag-router-status.ts — the BAG Router counterpart to composer-status.ts.
//
// WHY THIS IS A SEPARATE FILE, NOT A BRANCH INSIDE composer-status.ts OR
// lifi-status.ts: a BAG Router transaction is neither a LI.FI-quoted route
// (lifi-status.ts's `getStatus()` has no idea it exists) nor a Composer
// transaction (composer-status.ts's generic "sum every Transfer log to the
// recipient" check has no notion of `bagId`/`executionPlanHash`/plan
// identity, and this router — unlike Composer — emits its own attestation
// event worth checking). Reusing either would either silently accept a
// transaction that never touched `BagExecutionRouter` at all, or throw away
// the plan-identity check this router's `ExecutionCompleted` event makes
// possible. Item 4 of the hardening spec is explicit: "prefer contract
// events when the contract exposes enough information" — this module is
// that preference.
//
// WHAT THIS CHECKS (item 4's checklist, in order):
//   1. Transaction receipt succeeded (a revert is never treated as success).
//   2. `ExecutionCompleted` was emitted BY the expected router address —
//      never inferred from an event on some other contract in the same
//      receipt (item 4: "correct BagRouter contract").
//   3. That event's `bagId`/`executionPlanHash`/`wallet`/`inputToken`/
//      `inputAmount`/`legCount` all match what THIS intent was compiled and
//      persisted for — never merely "some plan executed", but "the plan we
//      think happened, happened" (item 4: "correct wallet", "correct
//      bagId/plan identity", "correct input token", "correct input
//      amount").
//   4. Actual received amounts, decoded from ERC-20 `Transfer` logs
//      RESTRICTED to (a) one of this plan's own declared output token
//      addresses and (b) `to === recipient` — never any Transfer log in the
//      receipt regardless of token, which is exactly the "arbitrary
//      Transfer log" over-crediting risk item 4 warns against. The
//      router's own on-chain accounting (delta-based, already enforced
//      against `minOutputs` — see contracts/BagExecutionRouter.sol) is what
//      guarantees these specific transfers are the genuine payout; this
//      only RE-READS them, it does not extend trust beyond what the
//      contract itself already enforced on-chain.
//
// `minOutputRaw`/output-decimals enforcement and idempotency (item 4's
// remaining checklist items) are NOT this module's job — they live in
// purchase-execution.ts's `verifyExecution()` (the same place the sequential
// and Composer paths are already checked against `step.minOutputRaw` /
// gated by `step.status`), so there is exactly one place per-step
// acceptance is decided, regardless of which provider produced the step.
// -----------------------------------------------------------------------------

const EXECUTION_COMPLETED_EVENT = parseAbiItem(
  'event ExecutionCompleted(bytes32 indexed bagId, bytes32 indexed executionPlanHash, address indexed wallet, address inputToken, uint256 inputAmount, uint256 legCount)'
);
const TRANSFER_EVENT = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

/** Server-side chain access goes through the resilient RPC layer (lib/blockchain/rpc). */
function chainClient(chain: ChainId) {
  return isBagChain(chain) && hasRpcEndpoint(chain) ? getChainPublicClient(chain) : null;
}

/** `0x`-prefix-insensitive, case-insensitive hex comparison — `PurchaseIntent.executionPlanHash` is persisted WITHOUT a `0x` prefix (`computeBagExecutionGraphHash()`'s own return convention) while everything read off-chain (decoded event args, `providerMetadata.signedPlan`) IS `0x`-prefixed; comparing either representation naively would produce a false mismatch. */
function normalizeHex(value: string): string {
  return value.toLowerCase().startsWith('0x') ? value.toLowerCase().slice(2) : value.toLowerCase();
}

export interface TrackBagRouterTransactionInput {
  txHash: string;
  chain: ChainId;
  /** The exact deployed `BagExecutionRouter` address this intent was compiled against — `ExecutionCompleted` is only trusted when it was emitted BY this address (see module doc). */
  routerAddress: string;
  /** The wallet that signed and should have received every leg's output — `PurchaseIntent.walletAddress`, never a client-supplied value. */
  recipient: string;
  /** On-chain bytes32 `bagId` (`computeOnChainBagId()`) the signed plan was compiled for. */
  expectedBagId: string;
  /** `PurchaseIntent.executionPlanHash` — compared prefix-insensitively (see `normalizeHex`). */
  expectedExecutionPlanHash: string;
  expectedInputToken: string;
  expectedInputAmountRaw: string;
  expectedLegCount: number;
  /** Every SWAP step's `outputAsset.address` for this intent — the ONLY token addresses a Transfer log is allowed to be attributed against (see module doc). */
  expectedOutputTokens: string[];
}

export type BagRouterTxOutcome =
  | { kind: 'PENDING' }
  | {
      kind: 'DONE';
      /** Lowercased ERC-20 token address -> raw amount received by `recipient` in this transaction, summed across every matching Transfer log. */
      receivedAmountsByAddress: Record<string, string>;
    }
  | { kind: 'FAILED'; failureCode: PurchaseIntentFailureCode; message: string };

/**
 * Reads a BAG Router transaction's receipt directly (same-chain, atomic —
 * no cross-chain bridge-completion polling, same reasoning as
 * `trackComposerTransaction`) and reports what the recipient actually
 * received, per token, ONLY after confirming the receipt's own
 * `ExecutionCompleted` event attests to exactly this plan. `PENDING` covers
 * both "not yet mined" and "RPC couldn't find it yet", same convention as
 * `composer-status.ts`.
 */
export async function trackBagRouterTransaction(input: TrackBagRouterTransactionInput): Promise<BagRouterTxOutcome> {
  const client = chainClient(input.chain);
  if (!client) {
    return {
      kind: 'FAILED',
      failureCode: 'PROVIDER_ERROR',
      message: `No RPC endpoint configured for ${input.chain} (${input.chain.toUpperCase()}_RPC_URL or ALCHEMY_API_KEY) — cannot verify this transaction.`,
    };
  }

  let receipt;
  try {
    receipt = await client.getTransactionReceipt({ hash: input.txHash as `0x${string}` });
  } catch {
    // Not found (yet) — could be still propagating, or not yet mined. Same
    // treatment either way: the caller polls again later.
    return { kind: 'PENDING' };
  }

  if (receipt.status !== 'success') {
    return {
      kind: 'FAILED',
      failureCode: 'TRANSACTION_REVERTED',
      message: 'The BAG Router transaction reverted on-chain.',
    };
  }

  // --- Correct contract + correct plan identity -----------------------
  const routerAddressLower = input.routerAddress.toLowerCase();
  let matchedEvent:
    | { bagId: string; executionPlanHash: string; wallet: string; inputToken: string; inputAmount: bigint; legCount: bigint }
    | null = null;

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== routerAddressLower) continue; // never trust an event from any other contract
    let decoded;
    try {
      decoded = decodeEventLog({ abi: [EXECUTION_COMPLETED_EVENT], data: log.data, topics: log.topics });
    } catch {
      continue; // not this event's shape — some other log this router (or another contract) happened to emit
    }
    if (decoded.eventName !== 'ExecutionCompleted') continue;
    matchedEvent = {
      bagId: decoded.args.bagId,
      executionPlanHash: decoded.args.executionPlanHash,
      wallet: decoded.args.wallet,
      inputToken: decoded.args.inputToken,
      inputAmount: decoded.args.inputAmount,
      legCount: decoded.args.legCount,
    };
    break;
  }

  if (!matchedEvent) {
    return {
      kind: 'FAILED',
      failureCode: 'VERIFICATION_FAILED',
      message: 'Transaction succeeded but no ExecutionCompleted event was found from the expected BAG Router contract.',
    };
  }

  const mismatches: string[] = [];
  if (normalizeHex(matchedEvent.bagId) !== normalizeHex(input.expectedBagId)) mismatches.push('bagId');
  if (normalizeHex(matchedEvent.executionPlanHash) !== normalizeHex(input.expectedExecutionPlanHash)) mismatches.push('executionPlanHash');
  if (matchedEvent.wallet.toLowerCase() !== input.recipient.toLowerCase()) mismatches.push('wallet');
  if (matchedEvent.inputToken.toLowerCase() !== input.expectedInputToken.toLowerCase()) mismatches.push('inputToken');
  if (matchedEvent.inputAmount.toString() !== input.expectedInputAmountRaw) mismatches.push('inputAmount');
  if (matchedEvent.legCount !== BigInt(input.expectedLegCount)) mismatches.push('legCount');

  if (mismatches.length > 0) {
    return {
      kind: 'FAILED',
      failureCode: 'VERIFICATION_FAILED',
      message: `BAG Router execution event did not match the expected plan (mismatched: ${mismatches.join(', ')}).`,
    };
  }

  // --- Actual received amounts, restricted (never "arbitrary") --------
  const expectedOutputTokensLower = new Set(input.expectedOutputTokens.map((t) => t.toLowerCase()));
  const receivedAmountsByAddress: Record<string, string> = {};
  for (const log of receipt.logs) {
    const tokenAddress = log.address.toLowerCase();
    if (!expectedOutputTokensLower.has(tokenAddress)) continue; // only this plan's own declared output tokens
    let decoded;
    try {
      decoded = decodeEventLog({ abi: [TRANSFER_EVENT], data: log.data, topics: log.topics });
    } catch {
      continue;
    }
    if (decoded.eventName !== 'Transfer') continue;
    if (decoded.args.to.toLowerCase() !== input.recipient.toLowerCase()) continue;

    const previous = BigInt(receivedAmountsByAddress[tokenAddress] ?? '0');
    receivedAmountsByAddress[tokenAddress] = (previous + decoded.args.value).toString();
  }

  return { kind: 'DONE', receivedAmountsByAddress };
}
