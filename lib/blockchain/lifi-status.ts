import { getStatus } from '@lifi/sdk';
import { decodeEventLog, parseAbiItem } from 'viem';
import { AssetIdentity, ChainId } from '@/types/basket-protocol';
import { PurchaseIntentFailureCode } from '@/types/purchase-intent';
import { getLiFiClient, toLiFiChainId } from './lifi-config';
import { mapLiFiError } from './lifi-execution-adapter';
import { assetIdentitiesEqual, isNativeAssetIdentity } from '@/lib/domain/basket-protocol/asset-identity';
import { getChainPublicClient, hasRpcEndpoint } from '@/lib/blockchain/rpc/clients';
import { isBagChain } from '@/lib/config/chains';

// -----------------------------------------------------------------------------
// Server-side status tracking + verification for one LI.FI (sequential) step.
//
// "LI.FI says DONE and the right token arrived" is NOT proof that THIS
// intent was executed: any successful LI.FI transfer into the same token —
// someone else's, or the user's own tiny one — would pass that check, and
// the intent would then mint its full quoted shares. So a step only counts
// as verified when the reported transaction is bound to the intent:
//
//   - LI.FI's own record of it: same txHash, fromAddress == toAddress ==
//     the intent's wallet, source token == the step's input asset, source
//     amount >= the step's input amount, destination token == the expected
//     output asset, destination amount >= the step's minOutputRaw;
//   - and, when an RPC endpoint for the source chain is configured, the
//     chain itself: tx.from == the intent's wallet.
//
// Any mismatch is VERIFICATION_FAILED (fail closed). Uniqueness of the
// txHash across intents is enforced separately (claim_intent_tx_hash).
// -----------------------------------------------------------------------------

export type TrackedStepOutcome =
  | { kind: 'PENDING'; substatus: string | null }
  | {
      kind: 'DONE';
      receivedAsset: AssetIdentity;
      receivedAmountRaw: string | null;
      matchesExpectedAsset: boolean;
    }
  | { kind: 'FAILED'; failureCode: PurchaseIntentFailureCode; message: string };

/** Maps a LI.FI `SubstatusFailed` value (its own failure taxonomy) to this protocol's `PurchaseIntentFailureCode` list — spec Aşama 7's explicit table. */
function mapSubstatusFailed(substatus: string | undefined): PurchaseIntentFailureCode {
  switch (substatus) {
    case 'INSUFFICIENT_ALLOWANCE':
      return 'INSUFFICIENT_ALLOWANCE';
    case 'INSUFFICIENT_BALANCE':
      return 'INSUFFICIENT_BALANCE';
    case 'SLIPPAGE_EXCEEDED':
      return 'SLIPPAGE_EXCEEDED';
    case 'EXPIRED':
      return 'ROUTE_EXPIRED';
    case 'OUT_OF_GAS':
      return 'TRANSACTION_REVERTED';
    default:
      return 'UNKNOWN_ERROR';
  }
}

export interface TrackStepStatusInput {
  txHash: string;
  sourceChain: ChainId;
  destinationChain: ChainId;
  /** LI.FI's own bridge/tool identifier for this step (`LiFiStep.tool`) — required by `getStatus()` for cross-chain routes, harmless for same-chain swaps. */
  tool: string | null;
  /** The registry-verified asset this step expects to receive. */
  expectedOutputAsset: AssetIdentity;
  /** The intent's own wallet (`PurchaseIntent.walletAddress` / `RedeemIntent.walletAddress`) — never a client value. It must have sent the transaction and received its output. */
  expectedWallet: string;
  /** The asset this step spends and the exact amount it was quoted for. */
  expectedInputAsset: AssetIdentity;
  expectedInputAmountRaw: string;
  /** The step's quoted minimum output; null skips only this one check (a step whose quote carried no minimum). */
  minOutputRaw: string | null;
}

interface StatusView {
  status: string;
  substatus?: string;
  substatusMessage?: string;
  fromAddress?: string;
  toAddress?: string;
  sending?: { txHash?: string; amount?: string; token?: { address?: string } };
  receiving?: { amount?: string; token?: { address?: string } } | { chainId: number };
}

const same = (a: string | undefined, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();

/** LI.FI's other spelling of an EVM chain's native token (it also uses the zero address, BAG's own native sentinel). */
const LIFI_NATIVE_ALIAS = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

/** `reported` (a token address in LI.FI's status) is `expected`; for a native asset, either native spelling counts. */
function sameToken(reported: string | undefined, expected: AssetIdentity): boolean {
  if (same(reported, expected.address)) return true;
  return isNativeAssetIdentity(expected) && same(reported, LIFI_NATIVE_ALIAS);
}

function isUnsignedInteger(value: string | undefined): value is string {
  return typeof value === 'string' && /^\d+$/.test(value);
}

function verificationFailed(message: string): TrackedStepOutcome {
  return { kind: 'FAILED', failureCode: 'VERIFICATION_FAILED', message };
}

/** On-chain sender check. `null` = verified, a string = mismatch reason, `undefined` = no RPC configured (skipped). */
async function checkOnChainSender(chain: ChainId, txHash: string, wallet: string): Promise<string | null | undefined> {
  if (!isBagChain(chain) || !hasRpcEndpoint(chain)) return undefined;
  try {
    const tx = await getChainPublicClient(chain).getTransaction({ hash: txHash as `0x${string}` });
    return same(tx.from, wallet) ? null : `transaction was sent by ${tx.from}, not the intent's wallet ${wallet}`;
  } catch {
    return `transaction ${txHash} could not be read from ${chain}`;
  }
}

const TRANSFER_EVENT = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

/**
 * Same-chain fallback when LI.FI's status API has no answer (NOT_FOUND /
 * PENDING / an API error) — its indexer does not always pick up swaps on
 * newer chains such as Robinhood Chain, which left a mined, successful swap
 * "confirming" forever. Reads the receipt directly and applies the same
 * binding rules as the LI.FI path, fail closed:
 *   - the transaction succeeded and was sent by the intent's wallet;
 *   - the wallet spent at least the step's input amount of the step's input
 *     token (ERC-20 Transfer logs from the wallet, or tx.value for native);
 *   - the wallet received the expected output token (Transfer logs to the
 *     wallet), at least the step's minimum output when one is set.
 * Returns `null` when it can't decide (no RPC, not mined yet) so the caller
 * keeps the step pending. Uniqueness of the txHash across intents is still
 * enforced separately (claim_intent_tx_hash).
 */
async function verifySameChainStepOnChain(input: TrackStepStatusInput): Promise<TrackedStepOutcome | null> {
  if (input.sourceChain !== input.destinationChain) return null;
  if (!isBagChain(input.sourceChain) || !hasRpcEndpoint(input.sourceChain)) return null;
  const client = getChainPublicClient(input.sourceChain);

  let receipt;
  let tx;
  try {
    receipt = await client.getTransactionReceipt({ hash: input.txHash as `0x${string}` });
    tx = await client.getTransaction({ hash: input.txHash as `0x${string}` });
  } catch {
    return null; // not mined yet / RPC hiccup — stay pending
  }

  if (receipt.status !== 'success') {
    return { kind: 'FAILED', failureCode: 'TRANSACTION_REVERTED', message: 'The swap transaction reverted on-chain.' };
  }
  if (!same(tx.from, input.expectedWallet)) {
    return verificationFailed(`transaction was sent by ${tx.from}, not the intent's wallet ${input.expectedWallet}`);
  }

  const wallet = input.expectedWallet.toLowerCase();
  const inputToken = input.expectedInputAsset.address.toLowerCase();
  const outputToken = input.expectedOutputAsset.address.toLowerCase();
  let spent = BigInt(0);
  let received = BigInt(0);
  for (const log of receipt.logs) {
    let decoded;
    try {
      decoded = decodeEventLog({ abi: [TRANSFER_EVENT], data: log.data, topics: log.topics });
    } catch {
      continue;
    }
    const token = log.address.toLowerCase();
    if (token === inputToken && decoded.args.from.toLowerCase() === wallet) spent += decoded.args.value;
    if (token === outputToken && decoded.args.to.toLowerCase() === wallet) received += decoded.args.value;
  }
  if (isNativeAssetIdentity(input.expectedInputAsset)) spent = tx.value;

  if (spent < BigInt(input.expectedInputAmountRaw)) {
    return verificationFailed(`Transaction spent ${spent}, less than this step's ${input.expectedInputAmountRaw}.`);
  }
  if (received === BigInt(0)) {
    return verificationFailed('Transaction did not deliver the expected output token to the intent\'s wallet.');
  }
  if (input.minOutputRaw !== null && received < BigInt(input.minOutputRaw)) {
    return verificationFailed(`Received ${received}, below this step's minimum ${input.minOutputRaw}.`);
  }

  return {
    kind: 'DONE',
    receivedAsset: input.expectedOutputAsset,
    receivedAmountRaw: received.toString(),
    matchesExpectedAsset: true,
  };
}

/**
 * Polls LI.FI's status for one submitted step's transaction and verifies it
 * belongs to this intent (see module doc). Never throws for a "still
 * pending" result — only a genuinely unexpected provider error is mapped.
 */
export async function trackStepStatus(input: TrackStepStatusInput): Promise<TrackedStepOutcome> {
  const client = getLiFiClient();

  let response: StatusView;
  try {
    response = (await getStatus(client, {
      txHash: input.txHash,
      fromChain: toLiFiChainId(input.sourceChain),
      toChain: toLiFiChainId(input.destinationChain),
      bridge: input.tool ?? undefined,
    })) as unknown as StatusView;
  } catch (err) {
    const onChain = await verifySameChainStepOnChain(input);
    if (onChain) return onChain;
    const mapped = mapLiFiError(err);
    return { kind: 'FAILED', failureCode: 'PROVIDER_ERROR', message: mapped.message };
  }

  if (response.status === 'FAILED') {
    return {
      kind: 'FAILED',
      failureCode: mapSubstatusFailed(response.substatus),
      message: response.substatusMessage ?? 'The transaction failed on-chain.',
    };
  }

  if (response.status === 'NOT_FOUND' || response.status === 'INVALID' || response.status === 'PENDING') {
    const onChain = await verifySameChainStepOnChain(input);
    if (onChain) return onChain;
    return { kind: 'PENDING', substatus: response.substatus ?? null };
  }

  // status === 'DONE'
  const receiving = response.receiving && 'token' in response.receiving ? response.receiving : null;
  if (!receiving?.token?.address) {
    // DONE without receiving-token detail yet — still pending, never guessed.
    return { kind: 'PENDING', substatus: response.substatus ?? null };
  }

  // --- Bind the transaction to this intent (fail closed) -------------------
  if (!same(response.sending?.txHash, input.txHash)) {
    return verificationFailed('LI.FI status does not describe the reported transaction.');
  }
  if (!same(response.fromAddress, input.expectedWallet)) {
    return verificationFailed(`Transfer was sent by ${response.fromAddress ?? 'an unknown address'}, not the intent's wallet.`);
  }
  if (!same(response.toAddress, input.expectedWallet)) {
    return verificationFailed(`Transfer paid out to ${response.toAddress ?? 'an unknown address'}, not the intent's wallet.`);
  }
  if (!sameToken(response.sending?.token?.address, input.expectedInputAsset)) {
    return verificationFailed('Transfer spent a different token than this step.');
  }
  const sentAmount = response.sending?.amount;
  if (!isUnsignedInteger(sentAmount) || BigInt(sentAmount) < BigInt(input.expectedInputAmountRaw)) {
    return verificationFailed(`Transfer spent ${sentAmount ?? 'an unknown amount'}, less than this step's ${input.expectedInputAmountRaw}.`);
  }

  const receivedAsset: AssetIdentity = { chain: input.destinationChain, address: receiving.token.address };
  const receivedAmountRaw = isUnsignedInteger(receiving.amount) ? receiving.amount : null;
  if (input.minOutputRaw !== null) {
    if (receivedAmountRaw === null || BigInt(receivedAmountRaw) < BigInt(input.minOutputRaw)) {
      return verificationFailed(`Received ${receivedAmountRaw ?? 'an unknown amount'}, below this step's minimum ${input.minOutputRaw}.`);
    }
  }

  const senderMismatch = await checkOnChainSender(input.sourceChain, input.txHash, input.expectedWallet);
  if (typeof senderMismatch === 'string') return verificationFailed(senderMismatch);

  return {
    kind: 'DONE',
    receivedAsset,
    receivedAmountRaw,
    matchesExpectedAsset: assetIdentitiesEqual(receivedAsset, input.expectedOutputAsset),
  };
}
