import { decodeEventLog, parseAbiItem } from 'viem';
import { getChainPublicClient, hasRpcEndpoint } from '@/lib/blockchain/rpc/clients';
import { isBagChain } from '@/lib/config/chains';
import { ChainId } from '@/types/basket-protocol';
import { PurchaseIntentFailureCode } from '@/types/purchase-intent';

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
  // A wallet batch (EIP-5792 over an EIP-7702 account, e.g. MetaMask) sends ONE transaction from the wallet to
  // itself; its delegated code then runs the approvals and the Composer call. Accepted only when the wallet is
  // both sender and target and the exact Composer call (target, value, calldata) is one of the batched calls.
  const walletBatch = same(tx.to, input.recipient) && typeof tx.input === 'string' && batchContainsCall(tx.input, input.expectedTransaction);
  if (!walletBatch) {
    if (!same(tx.to, input.expectedTransaction.to)) mismatches.push('to');
    if (!same(tx.input, input.expectedTransaction.data)) mismatches.push('calldata');
    if (tx.value !== BigInt(input.expectedTransaction.value || '0')) mismatches.push('value');
  }
  if (mismatches.length > 0) {
    return {
      kind: 'FAILED',
      failureCode: 'VERIFICATION_FAILED',
      message: `Reported transaction is not the Composer transaction built for this intent (mismatched: ${mismatches.join(', ')}).`,
    };
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
