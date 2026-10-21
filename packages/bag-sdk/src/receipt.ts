import { keccak256 } from 'viem';
import type { CompiledPurchase } from './execution';
import type { Hex } from './types';

/** Mined transaction fields used to bind a receipt to the compiled direct call. */
export interface PurchaseReceiptTransaction {
  hash: Hex;
  from: Hex;
  to: Hex | null;
  input: Hex;
  value: bigint;
  chainId?: number;
  blockHash: Hex | null;
  blockNumber: bigint | null;
}

export interface PurchaseReceiptLog {
  address: Hex;
  data: Hex;
  topics: readonly Hex[];
  logIndex: number | null;
  transactionHash: Hex | null;
  blockHash: Hex | null;
  blockNumber: bigint | null;
  removed?: boolean;
}

export interface PurchaseTransactionReceipt {
  transactionHash: Hex;
  blockHash: Hex;
  blockNumber: bigint;
  from: Hex;
  to: Hex | null;
  status: 'success' | 'reverted';
  logs: readonly PurchaseReceiptLog[];
}

/** Caller-owned read-only client; a viem public client satisfies this interface. */
export interface PurchaseReceiptClient {
  getChainId(): Promise<number>;
  getTransaction(args: { hash: Hex }): Promise<PurchaseReceiptTransaction>;
  getTransactionReceipt(args: { hash: Hex }): Promise<PurchaseTransactionReceipt>;
  getBlock(args: { blockNumber: bigint }): Promise<{ hash: Hex | null }>;
  getBlockNumber(args: { cacheTime: number }): Promise<bigint>;
}

export type PurchaseReceiptIssueCode =
  | 'RPC_CHAIN_MISMATCH' | 'NOT_MINED' | 'RPC_ERROR' | 'MALFORMED_RPC_RESPONSE'
  | 'TRANSACTION_HASH_MISMATCH' | 'TRANSACTION_MISMATCH' | 'UNSUPPORTED_TRANSACTION_ENVELOPE'
  | 'NON_CANONICAL_RECEIPT' | 'INSUFFICIENT_CONFIRMATIONS' | 'TRANSACTION_REVERTED'
  | 'INVALID_RECEIPT_LOGS' | 'OUTPUT_BELOW_MINIMUM';

export interface PurchaseReceiptVerification {
  status: 'VERIFIED' | 'FAILED' | 'INDETERMINATE';
  /** VERIFIED is scoped to exact transaction binding and conventional ERC-20 event evidence. */
  evidence: 'TRANSACTION_AND_TRANSFER_LOGS';
  transactionHash: Hex;
  chainId: number;
  blockNumber: bigint | null;
  confirmations: bigint;
  outputs: {
    token: string;
    receivedRaw: bigint;
    sentRaw: bigint;
    netReceivedRaw: bigint;
    minimumRaw: bigint;
    satisfied: boolean;
  }[];
  /** Planned retained input, not a measured wallet balance. */
  kept: CompiledPurchase['quote']['plan']['kept'];
  keptBalanceVerified: false;
  accounting: 'NOT_BAG_ACCOUNTED';
  issues: { code: PurchaseReceiptIssueCode; detail: string }[];
}

export interface VerifyPurchaseReceiptOptions {
  client: PurchaseReceiptClient;
  transactionHash: Hex;
  /**
   * Caller-chosen minimum NET delivery to the signer, one positive amount for every swap output.
   * Never inferred from the provider's swap-boundary minOutRaw or its output estimate.
   */
  minimumReceived: readonly { token: string; amountRaw: bigint }[];
  /** Positive safe integer; 1 means mined, not economic finality. No polling or waiting. */
  confirmations?: number;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const WORD = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS_WORD = /^0x0{24}[0-9a-fA-F]{40}$/;
const CALLDATA = /^0x(?:[0-9a-fA-F]{2}){4,}$/;
const TRANSFER = keccak256(new TextEncoder().encode('Transfer(address,address,uint256)'));
const same = (a: unknown, b: string): boolean => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();

function minimumsFor(compiled: CompiledPurchase, options: VerifyPurchaseReceiptOptions): Map<string, bigint> {
  const plan = compiled.quote.plan;
  if (!HASH.test(options.transactionHash)) throw new Error('verifyPurchaseReceipt: invalid transaction hash.');
  if (!Number.isSafeInteger(options.confirmations ?? 1) || (options.confirmations ?? 1) < 1) {
    throw new Error('verifyPurchaseReceipt: confirmations must be a positive safe integer.');
  }
  if (!Number.isSafeInteger(plan.chainId) || plan.chainId < 1 || compiled.transaction.chainId !== plan.chainId ||
      !ADDRESS.test(plan.signer) || !ADDRESS.test(compiled.transaction.to) || !CALLDATA.test(compiled.transaction.data) ||
      typeof compiled.transaction.value !== 'bigint' || compiled.transaction.value < BigInt(0)) {
    throw new Error('verifyPurchaseReceipt: malformed compiled transaction.');
  }
  const expected = new Set(plan.legs.map((leg) => leg.token.toLowerCase()));
  if (expected.size === 0 || expected.size !== plan.legs.length ||
      [...expected].some((token) => !ADDRESS.test(token) || /^0x0{40}$/.test(token))) {
    throw new Error('verifyPurchaseReceipt: expected outputs must be distinct ERC-20 addresses.');
  }
  const minimums = new Map<string, bigint>();
  if (!Array.isArray(options.minimumReceived)) throw new Error('verifyPurchaseReceipt: wallet output minimums are required.');
  for (const item of options.minimumReceived) {
    if (!item || typeof item.token !== 'string' || !ADDRESS.test(item.token) ||
        typeof item.amountRaw !== 'bigint' || item.amountRaw <= BigInt(0) || item.amountRaw >= BigInt(2) ** BigInt(256)) {
      throw new Error('verifyPurchaseReceipt: each wallet output minimum must be a positive uint256.');
    }
    const token = item.token.toLowerCase();
    if (!expected.has(token) || minimums.has(token)) throw new Error('verifyPurchaseReceipt: unexpected or duplicate output minimum.');
    minimums.set(token, item.amountRaw);
  }
  if (minimums.size !== expected.size) throw new Error('verifyPurchaseReceipt: provide a wallet minimum for every planned swap output.');
  return minimums;
}

/**
 * One read-only observation of a direct purchase. Re-run after insufficient depth or an unavailable receipt.
 * Does not infer smart-account/batch execution from embedded calldata. Such envelopes are INDETERMINATE.
 * Transfer events are token-contract assertions, not independently proven balance deltas. Nonstandard/rebasing
 * tokens, retained input balances, native outputs and BAG position accounting are outside this evidence scope.
 */
export async function verifyPurchaseReceipt(
  compiled: CompiledPurchase,
  options: VerifyPurchaseReceiptOptions
): Promise<PurchaseReceiptVerification> {
  const minimums = minimumsFor(compiled, options);
  const plan = compiled.quote.plan;
  const { client, transactionHash } = options;
  const result: PurchaseReceiptVerification = {
    status: 'INDETERMINATE', evidence: 'TRANSACTION_AND_TRANSFER_LOGS', transactionHash,
    chainId: plan.chainId, blockNumber: null, confirmations: BigInt(0), outputs: [],
    kept: plan.kept ? { ...plan.kept } : null, keptBalanceVerified: false,
    accounting: 'NOT_BAG_ACCOUNTED', issues: [],
  };
  const stop = (status: PurchaseReceiptVerification['status'], code: PurchaseReceiptIssueCode, detail: string) => {
    result.status = status;
    result.issues.push({ code, detail });
    return result;
  };

  try {
    if (await client.getChainId() !== plan.chainId) {
      return stop('FAILED', 'RPC_CHAIN_MISMATCH', 'RPC chain does not match the compiled purchase.');
    }
    const [tx, receipt] = await Promise.all([
      client.getTransaction({ hash: transactionHash }),
      client.getTransactionReceipt({ hash: transactionHash }),
    ]);
    if (!tx || !receipt) return stop('INDETERMINATE', 'NOT_MINED', 'Transaction or receipt is not available.');
    if (!same(tx.hash, transactionHash) || !same(receipt.transactionHash, transactionHash)) {
      return stop('FAILED', 'TRANSACTION_HASH_MISMATCH', 'RPC returned a different transaction or receipt.');
    }
    if (typeof receipt.blockNumber !== 'bigint' || receipt.blockNumber < BigInt(0) || !HASH.test(receipt.blockHash) ||
        !Array.isArray(receipt.logs) || !ADDRESS.test(tx.from) || typeof tx.value !== 'bigint' ||
        !CALLDATA.test(tx.input)) {
      return stop('INDETERMINATE', 'MALFORMED_RPC_RESPONSE', 'RPC returned invalid mined transaction fields.');
    }
    result.blockNumber = receipt.blockNumber;
    if (tx.chainId !== plan.chainId || !same(tx.from, plan.signer) || !same(receipt.from, tx.from) ||
        !same(receipt.to, tx.to ?? '')) {
      return stop('FAILED', 'TRANSACTION_MISMATCH', 'Transaction identity, sender or chain differs from the purchase.');
    }
    if (!same(tx.blockHash, receipt.blockHash) || tx.blockNumber !== receipt.blockNumber) {
      return stop('INDETERMINATE', 'NON_CANONICAL_RECEIPT', 'Transaction and receipt inclusion differ; read again for possible chain changes.');
    }
    if (!same(tx.to, compiled.transaction.to)) {
      return stop('INDETERMINATE', 'UNSUPPORTED_TRANSACTION_ENVELOPE', 'Transaction target differs from the direct compiled call; wallet batches and delegated envelopes need separate verification.');
    }
    if (!same(tx.input, compiled.transaction.data) || tx.value !== compiled.transaction.value) {
      return stop('FAILED', 'TRANSACTION_MISMATCH', 'Mined calldata or native value differs from the compiled call.');
    }
    const [block, head] = await Promise.all([
      client.getBlock({ blockNumber: receipt.blockNumber }),
      client.getBlockNumber({ cacheTime: 0 }),
    ]);
    if (!same(block?.hash, receipt.blockHash) || typeof head !== 'bigint' || head < receipt.blockNumber) {
      return stop('INDETERMINATE', 'NON_CANONICAL_RECEIPT', 'Receipt is not anchored to the observed canonical chain.');
    }
    result.confirmations = head - receipt.blockNumber + BigInt(1);
    if (result.confirmations < BigInt(options.confirmations ?? 1)) {
      return stop('INDETERMINATE', 'INSUFFICIENT_CONFIRMATIONS', 'Required confirmation depth has not been reached.');
    }
    if (receipt.status === 'reverted') return stop('FAILED', 'TRANSACTION_REVERTED', 'Purchase reverted on-chain.');
    if (receipt.status !== 'success') return stop('INDETERMINATE', 'MALFORMED_RPC_RESPONSE', 'Unknown receipt status.');

    const counts = new Map([...minimums].map(([token]) => [token, { received: BigInt(0), sent: BigInt(0) }]));
    const indices = new Set<number>();
    for (const log of receipt.logs) {
      if (!log || !Number.isSafeInteger(log.logIndex) || log.logIndex === null || log.logIndex < 0 ||
          indices.has(log.logIndex) || log.removed || !same(log.transactionHash, transactionHash) ||
          !same(log.blockHash, receipt.blockHash) || log.blockNumber !== receipt.blockNumber ||
          !ADDRESS.test(log.address) || !Array.isArray(log.topics)) {
        return stop('INDETERMINATE', 'INVALID_RECEIPT_LOGS', 'Receipt contains duplicate, removed, malformed or differently bound logs.');
      }
      indices.add(log.logIndex);
      const count = counts.get(log.address.toLowerCase());
      if (!count || !same(log.topics[0], TRANSFER)) continue;
      if (log.topics.length !== 3 || !ADDRESS_WORD.test(log.topics[1]) || !ADDRESS_WORD.test(log.topics[2]) || !WORD.test(log.data)) {
        return stop('INDETERMINATE', 'INVALID_RECEIPT_LOGS', 'A planned token emitted a malformed ERC-20 Transfer event.');
      }
      const from = '0x' + log.topics[1].slice(-40);
      const to = '0x' + log.topics[2].slice(-40);
      const amount = BigInt(log.data);
      if (same(to, plan.signer)) count.received += amount;
      if (same(from, plan.signer)) count.sent += amount;
    }
    result.outputs = [...minimums].map(([token, minimumRaw]) => {
      const count = counts.get(token)!;
      const netReceivedRaw = count.received - count.sent;
      return { token, receivedRaw: count.received, sentRaw: count.sent, netReceivedRaw, minimumRaw, satisfied: netReceivedRaw >= minimumRaw };
    });
    if (result.outputs.some((output) => !output.satisfied)) {
      return stop('FAILED', 'OUTPUT_BELOW_MINIMUM', 'Observed net Transfer delivery is below a caller-required wallet minimum.');
    }
    result.status = 'VERIFIED';
    return result;
  } catch (error) {
    const name = error && typeof error === 'object' && 'name' in error ? String(error.name) : '';
    if (name === 'TransactionReceiptNotFoundError' || name === 'TransactionNotFoundError') {
      return stop('INDETERMINATE', 'NOT_MINED', 'Transaction or receipt is not available.');
    }
    return stop('INDETERMINATE', 'RPC_ERROR', 'A read failed; verification is incomplete.');
  }
}
