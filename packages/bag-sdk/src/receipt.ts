import { BagSdkError } from './errors';
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

/** Evidence comes from the caller's trusted chain reader, never a wallet-provided snapshot. */
export interface PurchaseEvidenceContext {
  transactionHash: Hex;
  blockHash: Hex;
  blockNumber: bigint;
  owner: Hex;
}

export interface PurchaseBalanceEvidence extends PurchaseEvidenceContext {
  scope: 'TRANSACTION' | 'SINGLE_TRANSACTION_BLOCK';
  balances: { token: string; beforeRaw: bigint; afterRaw: bigint }[];
}

export interface PurchaseCallEvidence {
  transactionHash: Hex;
  blockHash: Hex;
  /** Full Geth-compatible callTracer result, including unsuccessful child calls. */
  call: unknown;
}

/** Caller-owned read-only client; a viem public client satisfies this interface. */
export interface PurchaseReceiptClient {
  getChainId(): Promise<number>;
  getTransaction(args: { hash: Hex }): Promise<PurchaseReceiptTransaction>;
  getTransactionReceipt(args: { hash: Hex }): Promise<PurchaseTransactionReceipt>;
  getBlock(args: { blockNumber: bigint }): Promise<{ hash: Hex | null; parentHash?: Hex; transactions?: readonly (Hex | { hash: Hex })[] }>;
  getBlockNumber(args: { cacheTime: number }): Promise<bigint>;
  tracePurchaseCall?(context: PurchaseEvidenceContext): Promise<PurchaseCallEvidence>;
  getPurchaseBalanceChanges?(context: PurchaseEvidenceContext & { tokens: readonly string[] }): Promise<PurchaseBalanceEvidence>;
}

export type PurchaseReceiptIssueCode =
  | 'RPC_CHAIN_MISMATCH' | 'NOT_MINED' | 'RPC_ERROR' | 'MALFORMED_RPC_RESPONSE'
  | 'TRANSACTION_HASH_MISMATCH' | 'TRANSACTION_MISMATCH' | 'UNSUPPORTED_TRANSACTION_ENVELOPE'
  | 'NON_CANONICAL_RECEIPT' | 'INSUFFICIENT_CONFIRMATIONS' | 'TRANSACTION_REVERTED'
  | 'INVALID_RECEIPT_LOGS' | 'OUTPUT_BELOW_MINIMUM'
  | 'INVALID_CALL_TRACE' | 'COMPILED_CALL_NOT_EXECUTED' | 'AMBIGUOUS_CALL_TRACE'
  | 'BALANCE_EVIDENCE_UNAVAILABLE' | 'INVALID_BALANCE_EVIDENCE' | 'INPUT_SPEND_EXCEEDS_PLAN'
  | 'INPUT_BALANCE_BELOW_PLAN' | 'KEPT_INPUT_MISSING';

export interface PurchaseReceiptVerification {
  status: 'VERIFIED' | 'FAILED' | 'INDETERMINATE';
  /** The caller explicitly chooses the weaker event-only mode if desired; balance evidence is the default. */
  evidence: 'TRANSACTION_AND_TRANSFER_LOGS' | 'TRANSACTION_AND_BALANCE_DELTAS';
  balanceScope: PurchaseBalanceEvidence['scope'] | null;
  spentInputRaw: bigint | null;
  transactionBinding: 'DIRECT' | 'CALL_TRACE' | null;
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
    balanceBeforeRaw: bigint | null;
    balanceAfterRaw: bigint | null;
    balanceDeltaRaw: bigint | null;
  }[];
  /** Planned retained input; keptBalanceVerified says whether post-state and input debit were checked. */
  kept: CompiledPurchase['quote']['plan']['kept'];
  keptBalanceVerified: boolean;
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
  /** Default BALANCE_DELTA: no automatic fallback to event-only evidence. */
  verification?: 'BALANCE_DELTA' | 'TRANSFER_LOGS';
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const WORD = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS_WORD = /^0x0{24}[0-9a-fA-F]{40}$/;
const CALLDATA = /^0x(?:[0-9a-fA-F]{2}){4,}$/;
const TRANSFER = keccak256(new TextEncoder().encode('Transfer(address,address,uint256)'));
const same = (a: unknown, b: string): boolean => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();

function callValue(value: unknown): bigint | null {
  if (typeof value !== 'string' || !/^(?:0x[0-9a-fA-F]+|0|[1-9]\d*)$/.test(value)) return null;
  return BigInt(value);
}

/** A trace must prove a successful CALL from the wallet, not merely contain matching bytes. */
function checkCallTrace(tx: PurchaseReceiptTransaction, compiled: CompiledPurchase, call: unknown): PurchaseReceiptIssueCode | null {
  if (!call || typeof call !== 'object' || Array.isArray(call)) return 'INVALID_CALL_TRACE';
  const root = call as Record<string, unknown>;
  if (root.type !== 'CALL' || !same(root.from, tx.from) || !same(root.to, tx.to ?? '') ||
      !same(root.input, tx.input) || callValue(root.value) !== tx.value) return 'INVALID_CALL_TRACE';
  const stack = [{ callFrame: root, failed: false, depth: 0 }];
  let visited = 0;
  let matches = 0;
  while (stack.length) {
    const frame = stack.pop()!;
    const node = frame.callFrame;
    if (++visited > 10_000 || frame.depth > 128 ||
        !['CALL', 'STATICCALL', 'DELEGATECALL', 'CALLCODE', 'CREATE', 'CREATE2', 'SELFDESTRUCT'].includes(String(node.type)) ||
        typeof node.from !== 'string' || !ADDRESS.test(node.from) || typeof node.to !== 'string' || !ADDRESS.test(node.to) ||
        (node.input !== undefined && (typeof node.input !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(node.input))) ||
        (node.error !== undefined && typeof node.error !== 'string') ||
        (node.calls !== undefined && !Array.isArray(node.calls))) return 'INVALID_CALL_TRACE';
    const failed = frame.failed || (typeof node.error === 'string' && node.error.length > 0);
    if (frame.depth === 0 && failed) return 'INVALID_CALL_TRACE';
    if (node.type === 'CALL') {
      const value = callValue(node.value);
      if (value === null) return 'INVALID_CALL_TRACE';
      if (!failed && same(node.from, compiled.quote.plan.signer) && same(node.to, compiled.transaction.to) &&
          same(node.input, compiled.transaction.data) && value === compiled.transaction.value) matches++;
    }
    const children = (node.calls ?? []) as unknown[];
    if (visited + stack.length + children.length > 10_000) return 'INVALID_CALL_TRACE';
    for (const child of children) {
      if (!child || typeof child !== 'object' || Array.isArray(child)) return 'INVALID_CALL_TRACE';
      stack.push({ callFrame: child as Record<string, unknown>, failed, depth: frame.depth + 1 });
    }
  }
  return matches === 1 ? null : matches === 0 ? 'COMPILED_CALL_NOT_EXECUTED' : 'AMBIGUOUS_CALL_TRACE';
}

function minimumsFor(compiled: CompiledPurchase, options: VerifyPurchaseReceiptOptions): Map<string, bigint> {
  const plan = compiled.quote.plan;
  if (options.verification !== undefined && options.verification !== 'BALANCE_DELTA' && options.verification !== 'TRANSFER_LOGS') {
    throw new BagSdkError('INVALID_ARGUMENT', 'verifyPurchaseReceipt: unknown verification mode.');
  }
  if (!HASH.test(options.transactionHash)) throw new BagSdkError('INVALID_ARGUMENT', 'verifyPurchaseReceipt: invalid transaction hash.');
  if (!Number.isSafeInteger(options.confirmations ?? 1) || (options.confirmations ?? 1) < 1) {
    throw new BagSdkError('INVALID_ARGUMENT', 'verifyPurchaseReceipt: confirmations must be a positive safe integer.');
  }
  if (!Number.isSafeInteger(plan.chainId) || plan.chainId < 1 || compiled.transaction.chainId !== plan.chainId ||
      !ADDRESS.test(plan.signer) || !ADDRESS.test(compiled.transaction.to) || !CALLDATA.test(compiled.transaction.data) ||
      typeof compiled.transaction.value !== 'bigint' || compiled.transaction.value < BigInt(0)) {
    throw new BagSdkError('INVALID_ARGUMENT', 'verifyPurchaseReceipt: malformed compiled transaction.');
  }
  const expected = new Set(plan.legs.map((leg) => leg.token.toLowerCase()));
  if (expected.size === 0 || expected.size !== plan.legs.length ||
      [...expected].some((token) => !ADDRESS.test(token) || /^0x0{40}$/.test(token))) {
    throw new BagSdkError('INVALID_ARGUMENT', 'verifyPurchaseReceipt: expected outputs must be distinct ERC-20 addresses.');
  }
  const minimums = new Map<string, bigint>();
  if (!Array.isArray(options.minimumReceived)) throw new BagSdkError('INVALID_ARGUMENT', 'verifyPurchaseReceipt: wallet output minimums are required.');
  for (const item of options.minimumReceived) {
    if (!item || typeof item.token !== 'string' || !ADDRESS.test(item.token) ||
        typeof item.amountRaw !== 'bigint' || item.amountRaw <= BigInt(0) || item.amountRaw >= BigInt(2) ** BigInt(256)) {
      throw new BagSdkError('INVALID_ARGUMENT', 'verifyPurchaseReceipt: each wallet output minimum must be a positive uint256.');
    }
    const token = item.token.toLowerCase();
    if (!expected.has(token) || minimums.has(token)) throw new BagSdkError('INVALID_ARGUMENT', 'verifyPurchaseReceipt: unexpected or duplicate output minimum.');
    minimums.set(token, item.amountRaw);
  }
  if (minimums.size !== expected.size) throw new BagSdkError('INVALID_ARGUMENT', 'verifyPurchaseReceipt: provide a wallet minimum for every planned swap output.');
  return minimums;
}

/**
 * One read-only observation. Batch/delegated calls require a full execution trace from the trusted chain reader.
 * Default verification uses transaction-scoped balance evidence; event-only evidence must be requested explicitly.
 * No polling, signing or submission. Re-run after insufficient depth or incomplete RPC evidence.
 */
export async function verifyPurchaseReceipt(
  compiled: CompiledPurchase,
  options: VerifyPurchaseReceiptOptions
): Promise<PurchaseReceiptVerification> {
  const minimums = minimumsFor(compiled, options);
  const plan = compiled.quote.plan;
  const { client, transactionHash } = options;
  const balanceMode = options.verification !== 'TRANSFER_LOGS';
  const result: PurchaseReceiptVerification = {
    status: 'INDETERMINATE', evidence: balanceMode ? 'TRANSACTION_AND_BALANCE_DELTAS' : 'TRANSACTION_AND_TRANSFER_LOGS', transactionHash,
    balanceScope: null, spentInputRaw: null, transactionBinding: null,
    chainId: plan.chainId, blockNumber: null, confirmations: BigInt(0), outputs: [],
    kept: plan.kept ? { ...plan.kept } : null, keptBalanceVerified: false,
    accounting: 'NOT_BAG_ACCOUNTED', issues: [],
  };
  const stop = (status: PurchaseReceiptVerification['status'], code: PurchaseReceiptIssueCode, detail: string) => {
    result.status = status;
    result.keptBalanceVerified = false;
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
    if (tx.chainId !== plan.chainId || !same(receipt.from, tx.from) ||
        !same(receipt.to, tx.to ?? '')) {
      return stop('FAILED', 'TRANSACTION_MISMATCH', 'Transaction identity, sender or chain differs from the purchase.');
    }
    if (!same(tx.blockHash, receipt.blockHash) || tx.blockNumber !== receipt.blockNumber) {
      return stop('INDETERMINATE', 'NON_CANONICAL_RECEIPT', 'Transaction and receipt inclusion differ; read again for possible chain changes.');
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

    const context: PurchaseEvidenceContext = {
      transactionHash, blockHash: receipt.blockHash, blockNumber: receipt.blockNumber, owner: plan.signer as Hex,
    };
    if (same(tx.to, compiled.transaction.to)) {
      if (!same(tx.from, plan.signer) || !same(tx.input, compiled.transaction.data) || tx.value !== compiled.transaction.value) {
        return stop('FAILED', 'TRANSACTION_MISMATCH', 'Mined sender, calldata or native value differs from the compiled direct call.');
      }
      result.transactionBinding = 'DIRECT';
    } else {
      if (!client.tracePurchaseCall) return stop('INDETERMINATE', 'UNSUPPORTED_TRANSACTION_ENVELOPE', 'A batch or delegated transaction requires execution-trace evidence.');
      let proof: PurchaseCallEvidence;
      try { proof = await client.tracePurchaseCall(context); }
      catch { return stop('INDETERMINATE', 'UNSUPPORTED_TRANSACTION_ENVELOPE', 'Execution tracing is unavailable on this chain reader.'); }
      if (!proof || !same(proof.transactionHash, transactionHash) || !same(proof.blockHash, receipt.blockHash)) {
        return stop('INDETERMINATE', 'INVALID_CALL_TRACE', 'Call-trace identity differs from the observed receipt.');
      }
      const issue = checkCallTrace(tx, compiled, proof.call);
      if (issue) return stop(issue === 'COMPILED_CALL_NOT_EXECUTED' ? 'FAILED' : 'INDETERMINATE', issue, 'Trace does not prove exactly one successful compiled call from the wallet.');
      result.transactionBinding = 'CALL_TRACE';
    }

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
      return { token, receivedRaw: count.received, sentRaw: count.sent, netReceivedRaw, minimumRaw,
        satisfied: !balanceMode && netReceivedRaw >= minimumRaw,
        balanceBeforeRaw: null, balanceAfterRaw: null, balanceDeltaRaw: null };
    });
    if (balanceMode) {
      if (!client.getPurchaseBalanceChanges) return stop('INDETERMINATE', 'BALANCE_EVIDENCE_UNAVAILABLE', 'Transaction-scoped balance reads are required; event-only fallback is not automatic.');
      const tokens = [...minimums.keys()];
      if (plan.inputKind === 'erc20' && !tokens.includes(plan.inputToken)) tokens.push(plan.inputToken);
      let proof: PurchaseBalanceEvidence;
      try { proof = await client.getPurchaseBalanceChanges({ ...context, tokens }); }
      catch { return stop('INDETERMINATE', 'BALANCE_EVIDENCE_UNAVAILABLE', 'Historical transaction-scoped balances are unavailable.'); }
      if (!proof || !same(proof.transactionHash, transactionHash) || !same(proof.blockHash, receipt.blockHash) ||
          proof.blockNumber !== receipt.blockNumber || !same(proof.owner, plan.signer) ||
          !['TRANSACTION', 'SINGLE_TRANSACTION_BLOCK'].includes(proof.scope) || !Array.isArray(proof.balances) || proof.balances.length !== tokens.length) {
        return stop('INDETERMINATE', 'INVALID_BALANCE_EVIDENCE', 'Balance evidence has an incorrect transaction, block, owner or token set.');
      }
      const balances = new Map<string, { beforeRaw: bigint; afterRaw: bigint }>();
      for (const entry of proof.balances) {
        if (!entry || typeof entry.token !== 'string' || !tokens.includes(entry.token.toLowerCase()) || balances.has(entry.token.toLowerCase()) ||
            typeof entry.beforeRaw !== 'bigint' || typeof entry.afterRaw !== 'bigint' ||
            entry.beforeRaw < BigInt(0) || entry.afterRaw < BigInt(0) || entry.beforeRaw >= BigInt(2) ** BigInt(256) || entry.afterRaw >= BigInt(2) ** BigInt(256)) {
          return stop('INDETERMINATE', 'INVALID_BALANCE_EVIDENCE', 'Balance evidence contains a duplicate, missing, unexpected or invalid token balance.');
        }
        balances.set(entry.token.toLowerCase(), entry);
      }
      result.balanceScope = proof.scope;
      if (proof.scope === 'SINGLE_TRANSACTION_BLOCK' &&
          (!block.transactions || block.transactions.length !== 1 || !same(typeof block.transactions[0] === 'string' ? block.transactions[0] : block.transactions[0].hash, transactionHash))) {
        return stop('INDETERMINATE', 'INVALID_BALANCE_EVIDENCE', 'Block-boundary balances are not isolated to this transaction.');
      }
      result.outputs = result.outputs.map(output => {
        const balance = balances.get(output.token)!;
        const delta = balance.afterRaw - balance.beforeRaw;
        return { ...output, balanceBeforeRaw: balance.beforeRaw, balanceAfterRaw: balance.afterRaw, balanceDeltaRaw: delta, satisfied: delta >= output.minimumRaw };
      });
      if (plan.inputKind === 'erc20') {
        const input = balances.get(plan.inputToken)!;
        result.spentInputRaw = input.beforeRaw - input.afterRaw;
        if (input.beforeRaw < plan.amountRaw) return stop('FAILED', 'INPUT_BALANCE_BELOW_PLAN', 'Pre-transaction input balance was below the planned deposit.');
        if (result.spentInputRaw > plan.swapAmountRaw) return stop('FAILED', 'INPUT_SPEND_EXCEEDS_PLAN', 'Wallet input-token debit exceeds the planned swap amount.');
        if (plan.kept) {
          if (input.afterRaw < plan.kept.amountRaw) return stop('FAILED', 'KEPT_INPUT_MISSING', 'The retained input share is not present after execution.');
          result.keptBalanceVerified = true;
        }
      }
    }
    if (result.outputs.some((output) => !output.satisfied)) {
      return stop('FAILED', 'OUTPUT_BELOW_MINIMUM', 'Observed wallet delivery is below a caller-required minimum.');
    }
    const [finalBlock, finalReceipt] = await Promise.all([
      client.getBlock({ blockNumber: receipt.blockNumber }), client.getTransactionReceipt({ hash: transactionHash }),
    ]);
    if (!same(finalBlock?.hash, receipt.blockHash) || !finalReceipt || !same(finalReceipt.blockHash, receipt.blockHash) ||
        !same(finalReceipt.transactionHash, transactionHash) || finalReceipt.blockNumber !== receipt.blockNumber || finalReceipt.status !== 'success') {
      return stop('INDETERMINATE', 'NON_CANONICAL_RECEIPT', 'Canonical inclusion changed while evidence was being collected.');
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
