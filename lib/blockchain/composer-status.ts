import { decodeEventLog, parseAbiItem } from 'viem';
import { getChainPublicClient, hasRpcEndpoint } from '@/lib/blockchain/rpc/clients';
import { isBagChain } from '@/lib/config/chains';
import { walletBatchBindingMode } from '@/lib/config/execution';
import { ChainId } from '@/types/basket-protocol';
import { PurchaseIntentFailureCode } from '@/types/purchase-intent';
import {
  chainIdOf,
  verifyWalletExecution,
  WALLET_ENVELOPE_POLICY,
  type WalletCallExpectation,
  type WalletExecutionVerification,
  type WalletStateReader,
} from '@/packages/bag-sdk/src';

// -----------------------------------------------------------------------------
// composer-status.ts — the Composer counterpart to lifi-status.ts.
//
// WHY THIS IS A SEPARATE FILE, NOT A BRANCH INSIDE lifi-status.ts:
// lifi-status.ts's `trackStepStatus()` is built entirely around `@lifi/sdk`'s
// `getStatus()` — LI.FI's OWN cross-chain bridge/swap status tracker, keyed
// by a `tool`/route LI.FI itself quoted. A Composer transaction is not a
// LI.FI-quoted route at all — it's a direct on-chain call to Composer's own
// execution VM (see lifi-composer-adapter.ts) — so `getStatus()` has no way
// to know about it and was never going to be the right tool for this,
// regardless of how this module is organized. This checks the transaction
// receipt directly instead, same-chain and atomic, so there is no
// cross-chain bridge-completion polling to do in the first place — a
// receipt is the final answer the moment it exists.
//
// WHAT "DONE" MEANS HERE: same principle as lifi-status.ts's own doc
// comment — credit what was ACTUALLY received on-chain, never the
// pre-execution simulated estimate. This decodes every ERC-20 `Transfer`
// log in the receipt and sums the amounts sent TO the purchasing wallet,
// per token address — the caller (purchase-execution.ts) matches those
// against each step's expected `outputAsset` itself, the same
// "asset actually received must match what the registry-verified step
// expected, or it's VERIFICATION_FAILED, never silently accepted" rule
// lifi-status.ts already enforces for the sequential path.
// -----------------------------------------------------------------------------

const TRANSFER_EVENT = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

export type ComposerTxOutcome =
  | { kind: 'PENDING' }
  | {
      kind: 'DONE';
      /** Lowercased ERC-20 token address -> raw amount received by `recipient` in this transaction, summed across every matching Transfer log (a token that pays out via more than one transfer to the recipient — unusual, but not disallowed — is still counted correctly). */
      receivedAmountsByAddress: Record<string, string>;
      /** Same, for amounts the recipient SENT in this transaction (what a sale took from the wallet). */
      sentAmountsByAddress: Record<string, string>;
    }
  | { kind: 'FAILED'; failureCode: PurchaseIntentFailureCode; message: string };

/** Server-side chain access goes through the resilient RPC layer (lib/blockchain/rpc). */
function chainClient(chain: ChainId) {
  return isBagChain(chain) && hasRpcEndpoint(chain) ? getChainPublicClient(chain) : null;
}

export interface TrackComposerTransactionInput {
  txHash: string;
  chain: ChainId;
  /** The wallet that signed and should have received every leg's output — `PurchaseIntent.walletAddress`, never a client-supplied value. */
  recipient: string;
  /**
   * The exact transaction the server built for this intent
   * (`PurchaseIntent.composerTransaction`). The reported txHash must BE that
   * transaction — same sender, target, calldata and value — otherwise any
   * successful tx that happened to move the right tokens into the wallet
   * would "complete" the intent. A wallet batch from the same wallet that
   * carries this exact call is the same transaction (`batchContainsCall`).
   */
  expectedTransaction: { to: string; data: string; value: string };
  /**
   * The ERC-20 approvals BAG built with the transaction (the intent's stored list; empty when none). Used only by
   * the exact binding (BAG_WALLET_BATCH_BINDING shadow/enforce): a wallet batch may carry these approve calls next
   * to the built call, and nothing else.
   */
  expectedApprovals?: readonly { token: string; spender: string; amountRaw: string }[];
  /** Which flow is verifying, for the shadow log only. */
  flow?: 'purchase' | 'redeem' | 'rebalance';
}

/** The exact binding's verdict, or ERROR when the stored expectation cannot even be evaluated. */
type ExactBinding = WalletExecutionVerification | { status: 'ERROR'; code: string; detail: string };

async function exactWalletBinding(
  client: NonNullable<ReturnType<typeof chainClient>>,
  tx: { from: string; to?: string | null; input: string; value: bigint; nonce?: number; type?: string; authorizationList?: readonly unknown[] | null },
  blockNumber: bigint,
  input: TrackComposerTransactionInput
): Promise<ExactBinding> {
  try {
    if (!isBagChain(input.chain)) return { status: 'ERROR', code: 'UNKNOWN_CHAIN', detail: `Not a BAG chain: ${input.chain}.` };
    const expectation: WalletCallExpectation = {
      chainId: chainIdOf(input.chain),
      wallet: input.recipient,
      call: { to: input.expectedTransaction.to, data: input.expectedTransaction.data, value: BigInt(input.expectedTransaction.value || '0') },
      approvals: (input.expectedApprovals ?? []).map((a) => ({ token: a.token, spender: a.spender, maxAmountRaw: BigInt(a.amountRaw) })),
    };
    return await verifyWalletExecution(
      client as unknown as WalletStateReader,
      { from: tx.from, to: tx.to ?? null, input: tx.input, value: tx.value, nonce: tx.nonce, type: tx.type, authorizationList: tx.authorizationList ?? null, blockNumber },
      expectation
    );
  } catch (err) {
    // A stored expectation the binder refuses to evaluate (malformed address or amount): never a pass.
    return { status: 'ERROR', code: 'EXPECTATION_INVALID', detail: err instanceof Error ? err.name : 'Error' };
  }
}

/**
 * Shadow mode: records whether the exact binding agrees with the legacy verdict that still decides. One line per
 * disagreement or smart-account envelope (agreeing direct calls are not logged). No wallet address, no RPC URL.
 */
function logShadow(input: TrackComposerTransactionInput, receiptStatus: string, legacyBound: boolean, exact: ExactBinding): void {
  const exactBound = exact.status === 'BOUND';
  const agree = (exact.status === 'BOUND' || exact.status === 'REFUSED') && exactBound === legacyBound;
  const envelope = exact.status === 'BOUND' ? exact.envelope : undefined;
  if (agree && envelope === 'DIRECT') return;
  console.info(
    `[wallet-binding-shadow] ${JSON.stringify({
      policy: WALLET_ENVELOPE_POLICY,
      flow: input.flow ?? 'unknown',
      chain: input.chain,
      txHash: input.txHash,
      receiptStatus,
      legacy: legacyBound ? 'ACCEPT' : 'REFUSE',
      exact: exact.status,
      ...(exact.status === 'BOUND' ? { envelope } : { code: exact.code }),
      agree,
    })}`
  );
}

const word = (hex: string) => hex.padStart(64, '0');

/** True when `needle` occurs in `hay` at an index that satisfies `aligned`. */
function alignedIndexOf(hay: string, needle: string, aligned: (i: number) => boolean): boolean {
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) if (aligned(i)) return true;
  return false;
}

/**
 * True when a batch call's input carries exactly this call, in either encoding wallets use for a batched
 * call: the ABI struct `(address target, uint256 value, bytes data)` (ERC-7579 batch, `executeBatch(Call[])`),
 * where target and value are adjacent words and `data` is its length word followed by the bytes; or the packed
 * `target ‖ value ‖ data` of an ERC-7579 single execution. Matches are byte- and word-aligned, the calldata
 * must be non-empty, and the whole calldata must appear, so no other call can satisfy it by accident.
 */
export function batchContainsCall(batchInput: string, call: { to: string; data: string; value: string }): boolean {
  const hay = batchInput.replace(/^0x/i, '').toLowerCase();
  const to = call.to.replace(/^0x/i, '').toLowerCase();
  const data = call.data.replace(/^0x/i, '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(to) || data.length < 8 || data.length % 2 !== 0 || hay.length < 8) return false;
  const value = word(BigInt(call.value || '0').toString(16));
  // ABI words start right after the 4-byte selector, on 32-byte boundaries.
  const onWord = (i: number) => i >= 8 && (i - 8) % 64 === 0;
  const abi =
    alignedIndexOf(hay, word(to) + value, onWord) && alignedIndexOf(hay, word((data.length / 2).toString(16)) + data, onWord);
  const packed = alignedIndexOf(hay, to + value + data, (i) => i % 2 === 0);
  return abi || packed;
}

/** `DelegationManager.redeemDelegations(bytes[],bytes32[],bytes[])` — how a MetaMask smart account (EIP-7702) sends its calls. */
export const REDEEM_DELEGATIONS_SELECTOR = '0xcef6d209';

/**
 * A wallet-routed batch that carries the exact Composer call: either the wallet calling itself (EIP-5792 over
 * an EIP-7702 account) or the wallet calling a DelegationManager's `redeemDelegations` (MetaMask smart account),
 * whose execution calldata embeds the same ERC-7579 encodings `batchContainsCall` already reads. The caller
 * still requires `tx.from` to be the wallet, so only the wallet's own transaction can match.
 */
export function isWalletRoutedBatch(tx: { to?: string | null; input?: unknown }, wallet: string, call: { to: string; data: string; value: string }): boolean {
  if (typeof tx.input !== 'string') return false;
  const selfCall = typeof tx.to === 'string' && tx.to.toLowerCase() === wallet.toLowerCase();
  const delegationRedeem = tx.input.toLowerCase().startsWith(REDEEM_DELEGATIONS_SELECTOR);
  return (selfCall || delegationRedeem) && batchContainsCall(tx.input, call);
}

/**
 * Reads a Composer transaction's receipt directly (no LI.FI status API
 * involved) and reports what the recipient actually received, per token.
 * `PENDING` covers both "not yet mined" and "RPC couldn't find it yet" —
 * this module doesn't try to distinguish those the way a bridge's
 * multi-chain status can meaningfully differ between them; a same-chain
 * receipt lookup either has an answer or doesn't yet.
 */
export async function trackComposerTransaction(input: TrackComposerTransactionInput): Promise<ComposerTxOutcome> {
  const client = chainClient(input.chain);
  if (!client) {
    return {
      kind: 'FAILED',
      failureCode: 'PROVIDER_ERROR',
      message: `No RPC endpoint configured for ${input.chain} (${input.chain.toUpperCase()}_RPC_URL or ALCHEMY_API_KEY) — cannot verify this transaction.`,
    };
  }

  let receipt;
  let tx;
  try {
    receipt = await client.getTransactionReceipt({ hash: input.txHash as `0x${string}` });
    tx = await client.getTransaction({ hash: input.txHash as `0x${string}` });
  } catch {
    // Not found (yet) — could be still propagating, or not yet mined.
    // Same treatment either way: the caller polls again later.
    return { kind: 'PENDING' };
  }

  const same = (a: string | null | undefined, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
  const mismatches: string[] = [];
  if (!same(tx.from, input.recipient)) mismatches.push('from');
  // A wallet batch (EIP-5792 over an EIP-7702 account, e.g. MetaMask) sends ONE transaction from the wallet, either
  // to itself or through a DelegationManager; the account's code then runs the approvals and the Composer call.
  // Accepted only when the wallet is the sender and the exact Composer call (target, value, calldata) is one of
  // the batched calls.
  const walletBatch = isWalletRoutedBatch(tx, input.recipient, input.expectedTransaction);
  if (!walletBatch) {
    if (!same(tx.to, input.expectedTransaction.to)) mismatches.push('to');
    if (!same(tx.input, input.expectedTransaction.data)) mismatches.push('calldata');
    if (tx.value !== BigInt(input.expectedTransaction.value || '0')) mismatches.push('value');
  }
  const mode = walletBatchBindingMode();
  if (mode === 'enforce') {
    // The exact binding decides (BAG_WALLET_BATCH_BINDING=enforce): the transaction is the built call, or a pinned
    // smart-account envelope whose executions are exactly that call plus the built approvals, run by pinned code.
    const exact = await exactWalletBinding(client, tx, receipt.blockNumber, input);
    if (exact.status === 'INDETERMINATE') return { kind: 'PENDING' };
    if (exact.status !== 'BOUND') {
      return {
        kind: 'FAILED',
        failureCode: 'VERIFICATION_FAILED',
        message: `Reported transaction is not exactly the transaction built for this intent (${exact.code}): ${exact.detail}`,
      };
    }
  } else {
    if (mode === 'shadow') logShadow(input, String(receipt.status), mismatches.length === 0, await exactWalletBinding(client, tx, receipt.blockNumber, input));
    if (mismatches.length > 0) {
      return {
        kind: 'FAILED',
        failureCode: 'VERIFICATION_FAILED',
        message: `Reported transaction is not the Composer transaction built for this intent (mismatched: ${mismatches.join(', ')}).`,
      };
    }
  }

  if (receipt.status !== 'success') {
    return {
      kind: 'FAILED',
      failureCode: 'TRANSACTION_REVERTED',
      message: 'The Composer transaction reverted on-chain.',
    };
  }

  const receivedAmountsByAddress: Record<string, string> = {};
  const sentAmountsByAddress: Record<string, string> = {};
  for (const log of receipt.logs) {
    let decoded;
    try {
      decoded = decodeEventLog({ abi: [TRANSFER_EVENT], data: log.data, topics: log.topics });
    } catch {
      // Not a Transfer-shaped log (Composer's own internal events, other
      // contracts' logs in the same tx, etc.) — not an error, just not
      // something this function reads.
      continue;
    }
    if (decoded.eventName !== 'Transfer') continue;
    const token = log.address.toLowerCase();
    const add = (into: Record<string, string>) => {
      into[token] = (BigInt(into[token] ?? '0') + decoded.args.value).toString();
    };
    if (decoded.args.to.toLowerCase() === input.recipient.toLowerCase()) add(receivedAmountsByAddress);
    if (decoded.args.from.toLowerCase() === input.recipient.toLowerCase()) add(sentAmountsByAddress);
  }

  return { kind: 'DONE', receivedAmountsByAddress, sentAmountsByAddress };
}
