import type { PurchaseReceiptClient, PurchaseEvidenceContext, PurchaseBalanceEvidence } from '../receipt';
import type { Hex } from '../types';
import { BAG_V1_CHAINS } from '../chains';

export interface ReceiptEvidenceOptions {
  /** Indexed modes require a qualified reader with BEFORE-transaction txIndex semantics. No automatic detection/fallback. */
  balanceState?: 'SINGLE_TRANSACTION_BLOCK' | 'GETH_TRANSACTION_INDEX' | 'ROBINHOOD_NITRO_TRANSACTION_INDEX';
}

type Rpc = (args: { method: string; params: readonly unknown[] }) => Promise<unknown>;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const WORD = /^0x[0-9a-fA-F]{64}$/;
const same = (a: unknown, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Malformed receipt evidence RPC result.');
  return value as Record<string, unknown>;
};

/** Adds evidence reads to a viem-compatible public client. No endpoint, credential, signing or submission. */
export function withReceiptEvidence(client: PurchaseReceiptClient & { request: unknown }, options: ReceiptEvidenceOptions = {}): PurchaseReceiptClient {
  if (typeof client.request !== 'function') throw new Error('withReceiptEvidence requires a JSON-RPC request method.');
  const mode = options.balanceState ?? 'SINGLE_TRANSACTION_BLOCK';
  if (!['SINGLE_TRANSACTION_BLOCK', 'GETH_TRANSACTION_INDEX', 'ROBINHOOD_NITRO_TRANSACTION_INDEX'].includes(mode)) throw new Error('Unknown balance-state mode.');
  const indexed = mode !== 'SINGLE_TRANSACTION_BLOCK';
  const rpc: Rpc = args => (client.request as Rpc).call(client, args);
  const assertInclusion = async (context: PurchaseEvidenceContext, index?: number) => {
    const receipt = record(await rpc({ method: 'eth_getTransactionReceipt', params: [context.transactionHash] }));
    if (!same(receipt.transactionHash, context.transactionHash) || !same(receipt.blockHash, context.blockHash) ||
        typeof receipt.blockNumber !== 'string' || BigInt(receipt.blockNumber) !== context.blockNumber ||
        (index !== undefined && (typeof receipt.transactionIndex !== 'string' ||
          !/^0x[0-9a-fA-F]+$/.test(receipt.transactionIndex) || BigInt(receipt.transactionIndex) !== BigInt(index)))) {
      throw new Error('Receipt inclusion changed during evidence collection.');
    }
  };
  return {
    getChainId: () => client.getChainId(),
    getTransaction: args => client.getTransaction(args),
    getTransactionReceipt: args => client.getTransactionReceipt(args),
    getBlock: args => client.getBlock(args),
    getBlockNumber: args => client.getBlockNumber(args),
    async tracePurchaseCall(context) {
      const call = await rpc({ method: 'debug_traceTransaction', params: [context.transactionHash, { tracer: 'callTracer' }] });
      await assertInclusion(context);
      return { transactionHash: context.transactionHash, blockHash: context.blockHash, call };
    },
    async getPurchaseBalanceChanges(context): Promise<PurchaseBalanceEvidence> {
      if (mode === 'GETH_TRANSACTION_INDEX') {
        // Unknown clients can silently ignore txIndex, so an opt-in alone is insufficient.
        const version = await rpc({ method: 'web3_clientVersion', params: [] });
        if (typeof version !== 'string' || !/^Geth\/v1\.16\./.test(version)) {
          throw new Error('Transaction-indexed balance adapter requires confirmed Geth 1.16 semantics.');
        }
      }
      if (mode === 'ROBINHOOD_NITRO_TRANSACTION_INDEX') {
        if (await client.getChainId() !== BAG_V1_CHAINS.robinhood) {
          throw new Error('Robinhood Nitro balance adapter requires the Robinhood mainnet chain.');
        }
        const version = await rpc({ method: 'web3_clientVersion', params: [] });
        // Qualified with real historical state reads on this Nitro build. A newer
        // build requires qualification; sharing an RPC method name is insufficient.
        if (typeof version !== 'string' || !/^nitro\/v3\.12\.1\+70fa99a(?:-|\/)/.test(version)) {
          throw new Error('Robinhood transaction-indexed balance adapter requires the qualified Nitro build.');
        }
      }
      const block = record(await rpc({ method: 'eth_getBlockByHash', params: [context.blockHash, false] }));
      if (!same(block.hash, context.blockHash) || typeof block.number !== 'string' || BigInt(block.number) !== context.blockNumber ||
          !Array.isArray(block.transactions) || !block.transactions.every(hash => typeof hash === 'string' && HASH.test(hash)) ||
          typeof block.parentHash !== 'string' || !HASH.test(block.parentHash) ||
          block.transactions.filter(hash => same(hash, context.transactionHash)).length !== 1) throw new Error('Malformed balance-state block.');
      const transactions = block.transactions as string[];
      const index = transactions.findIndex(hash => same(hash, context.transactionHash));
      if (mode === 'SINGLE_TRANSACTION_BLOCK' && transactions.length !== 1) throw new Error('Busy block requires transaction-indexed state reads.');
      const balanceAt = async (token: string, after: boolean): Promise<bigint> => {
        const call = { from: context.owner, to: token, data: '0x70a08231' + context.owner.slice(2).padStart(64, '0'), gas: '0xf4240' };
        let output: unknown;
        if (indexed && (!after || index + 1 < transactions.length)) {
          // Qualified Geth/Nitro readers reconstruct state BEFORE the indexed transaction.
          // The following transaction's pre-state is the current one's post-state.
          const trace = record(await rpc({ method: 'debug_traceCall', params: [call, context.blockHash, {
            tracer: 'callTracer', txIndex: '0x' + (index + (after ? 1 : 0)).toString(16),
          }] }));
          if (trace.error || trace.type !== 'CALL' || !same(trace.from, context.owner) || !same(trace.to, token) || !same(trace.input, call.data)) throw new Error('Historical balance call failed.');
          output = trace.output;
        } else {
          output = await rpc({ method: 'eth_call', params: [call, {
            blockHash: after ? context.blockHash : block.parentHash, requireCanonical: true,
          }] });
        }
        if (typeof output !== 'string' || !WORD.test(output)) throw new Error('Historical balance is not a uint256.');
        return BigInt(output);
      };
      const balances = [];
      for (const token of context.tokens) {
        const [beforeRaw, afterRaw] = await Promise.all([balanceAt(token, false), balanceAt(token, true)]);
        balances.push({ token, beforeRaw, afterRaw });
      }
      await assertInclusion(context, index);
      return { ...context, scope: mode === 'SINGLE_TRANSACTION_BLOCK' ? 'SINGLE_TRANSACTION_BLOCK' : 'TRANSACTION', balances };
    },
  };
}
