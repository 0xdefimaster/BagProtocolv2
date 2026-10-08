import { SupabaseClient } from '@supabase/supabase-js';
import { decodeEventLog, type Hex } from 'viem';
import { getChainPublicClient } from '@/lib/blockchain/rpc/clients';
import { DEPLOYED_CONTRACTS, rewardTokenRawToQuoteDecimal } from '@/lib/config/robinhood-chain';
import { getRedeemIntentForUser, updateRedeemIntentStatus } from '@/lib/server/redeem-intent-repo';
import { rawToDecimalString, splitRaw } from '@/lib/domain/basket-protocol/accounting/decimal';

// -----------------------------------------------------------------------------
// V11 — server-side verification for the RedeemFeeRouter execution path.
// The browser submits a txHash it got back from the user's own wallet
// after calling `RedeemFeeRouter.redeem()` (lib/blockchain/redeem-fee-router-client.ts).
// This module NEVER trusts that claim at face value — it independently
// re-reads the transaction receipt from Robinhood Chain's own RPC, decodes
// the contract's own `Redeemed` event, and only then indexes the result.
// This is the same "chain is the source of truth, never a client claim"
// rule every other part of this settlement system already follows (see
// lib/server/creator-rewards-reconciliation.ts's own module doc).
//
// A malicious/buggy client submitting a txHash for someone else's
// transaction, a reverted transaction, or a transaction without the
// expected router event and wallet/intent binding is rejected before DB
// writes. For EIP-5792 smart-account batches the outer transaction may be
// sent to the wallet or its account-abstraction entry point, while the
// Router still emits the authoritative event from inside that batch.
// -----------------------------------------------------------------------------

const REDEEMED_EVENT_ABI = [
  {
    type: 'event',
    name: 'Redeemed',
    inputs: [
      { name: 'redemptionId', type: 'bytes32', indexed: true },
      { name: 'user', type: 'address', indexed: true },
      { name: 'creator', type: 'address', indexed: true },
      { name: 'legCount', type: 'uint256', indexed: false },
      { name: 'swapOutput', type: 'uint256', indexed: false },
      { name: 'feeAmount', type: 'uint256', indexed: false },
      { name: 'userProceeds', type: 'uint256', indexed: false },
    ],
  },
] as const;

export class RouterTxVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RouterTxVerificationError';
  }
}

/**
 * Independently verifies that `txHash` contains a confirmed, successful
 * `RedeemFeeRouter.redeem()` call for `redeemIntentId`, then indexes the
 * result via `apply_redeem_execution_router_settled()` (never re-derives
 * or re-pays the fee — see that migration's own doc) and marks the intent
 * COMPLETED.
 *
 * Verification steps, each of which throws `RouterTxVerificationError` on
 * failure rather than silently proceeding:
 *   1. The tx receipt status is 'success' (a reverted tx is never indexed).
 *   2. The receipt contains a `Redeemed` event emitted by the configured router.
 *   3. That event's wallet and `redemptionId` match this intent's own
 *      wallet and deterministic
 *      id (the same value the attestation was signed over) — so a txHash
 *      for some OTHER user's redemption can never be submitted here to
 *      forge a completion for this intent. This also supports atomic smart-
 *      account batches whose outer transaction target is not the Router.
 */
export async function verifyAndIndexRouterRedemption(
  admin: SupabaseClient,
  userId: string,
  redeemIntentId: string,
  txHash: Hex
): Promise<void> {
  const routerAddress = DEPLOYED_CONTRACTS.redeemFeeRouter;
  if (!routerAddress) {
    throw new RouterTxVerificationError('REDEEM_FEE_ROUTER_ADDRESS is not configured — cannot verify a router redemption.');
  }

  const intentResult = await getRedeemIntentForUser(admin, redeemIntentId, userId);
  if (!intentResult.ok) {
    throw new RouterTxVerificationError(`Redeem intent not accessible: ${intentResult.error}`);
  }
  const intent = intentResult.intent;

  const publicClient = getChainPublicClient('robinhood');

  const tx = await publicClient.getTransaction({ hash: txHash }).catch(() => null);
  if (!tx) throw new RouterTxVerificationError(`Transaction ${txHash} not found on Robinhood Chain.`);

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
  if (receipt.status !== 'success') {
    throw new RouterTxVerificationError(`Transaction ${txHash} reverted on-chain — not indexing a failed redemption.`);
  }

  interface DecodedRedeemed {
    redemptionId: Hex;
    user: `0x${string}`;
    creator: `0x${string}`;
    feeAmount: bigint;
    swapOutput: bigint;
  }
  let decoded: DecodedRedeemed | null = null;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== routerAddress.toLowerCase()) continue;
    try {
      const event = decodeEventLog({ abi: REDEEMED_EVENT_ABI, data: log.data, topics: log.topics });
      if (event.eventName === 'Redeemed') {
        decoded = event.args as unknown as DecodedRedeemed;
        break;
      }
    } catch {
      continue; // not a Redeemed log (could be an ERC-20 Transfer/Approval from the same tx) — skip, keep scanning.
    }
  }
  if (!decoded) {
    throw new RouterTxVerificationError(`Transaction ${txHash} has no Redeemed event from the RedeemFeeRouter — not a valid redemption.`);
  }

  // computeOnChainBagId(intent.id) is exactly what signFeeAttestation() used
  // as redemptionId — re-derive and compare rather than trusting anything
  // client-supplied about which redemption this event corresponds to.
  const { computeOnChainBagId } = await import('@/lib/domain/basket-protocol/onchain');
  const expectedRedemptionId = computeOnChainBagId(intent.id);
  if (decoded.redemptionId.toLowerCase() !== expectedRedemptionId.toLowerCase()) {
    throw new RouterTxVerificationError(
      `Transaction ${txHash}'s Redeemed event is for a different redemption (${decoded.redemptionId}), not this intent (${expectedRedemptionId}).`
    );
  }
  if (decoded.user.toLowerCase() !== intent.walletAddress.toLowerCase()) {
    throw new RouterTxVerificationError(
      `Transaction ${txHash}'s Redeemed event belongs to ${decoded.user}, not this intent's wallet (${intent.walletAddress}).`
    );
  }

  const { getBagById } = await import('@/lib/server/bag-repo');
  const bag = await getBagById(admin, intent.bagId);
  if (!bag) throw new RouterTxVerificationError(`Bag ${intent.bagId} not found.`);

  const feeAmountQuote = rewardTokenRawToQuoteDecimal(decoded.feeAmount);

  // A3: proceeds per leg, before the fee. The router reports one swapOutput for all swapped legs; it is split
  // across them in proportion to each leg's quoted output. A KEEP leg returns itself.
  const soldSteps = intent.steps.filter((s) => (s.action === 'SWAP' || s.action === 'KEEP') && BigInt(s.inputAmountRaw) > BigInt(0));
  const swapSteps = soldSteps.filter((s) => s.action === 'SWAP');
  const swapShares = splitRaw(
    BigInt(decoded.swapOutput),
    swapSteps.map((s) => BigInt(/^\d+$/.test(s.outputAmountRaw ?? '') ? (s.outputAmountRaw as string) : /^\d+$/.test(s.minOutputRaw ?? '') ? (s.minOutputRaw as string) : '0'))
  );
  const holdingsSold = soldSteps.map((s) => ({
    chain: s.inputAsset.chain,
    address: s.inputAsset.address,
    quantity_raw: s.inputAmountRaw,
    proceeds_quote: rawToDecimalString(s.action === 'KEEP' ? BigInt(s.inputAmountRaw) : swapShares[swapSteps.indexOf(s)], intent.outputDecimals),
  }));

  const { error: rpcError } = await admin.rpc('apply_redeem_execution_router_settled', {
    p_intent_id: intent.id,
    p_bag_id: intent.bagId,
    p_holdings_sold: holdingsSold,
    p_shares_burn_raw: intent.sharesRaw,
    p_share_decimals: intent.shareDecimals,
    p_user_id: userId,
    p_redeem_value_quote: intent.redeemValueQuote,
    p_creator_id: bag.creatorId,
    p_creator_wallet: decoded.creator,
    p_fee_amount_quote: feeAmountQuote,
    p_fee_amount_token_raw: decoded.feeAmount.toString(),
    p_onchain_tx_hash: txHash,
    p_redemption_id_hex: decoded.redemptionId,
  });
  if (rpcError) throw new RouterTxVerificationError(`apply_redeem_execution_router_settled failed: ${rpcError.message}`);

  await updateRedeemIntentStatus(admin, { id: redeemIntentId, from: intent.status, to: 'COMPLETED' });
}
