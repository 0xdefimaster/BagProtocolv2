import { describe, expect, it, vi } from 'vitest';
import { withReceiptEvidence } from '../src/adapters/evm';
import type { Hex, PurchaseEvidenceContext } from '../src';

const hex = (value: string, size: number) => ('0x' + value.repeat(size)) as Hex;
const HASH = hex('1', 64), BLOCK = hex('2', 64), PARENT = hex('3', 64), OTHER_TX = hex('4', 64);
const OWNER = hex('5', 40), TOKEN = hex('6', 40);
const context: PurchaseEvidenceContext & { tokens: string[] } = {
  transactionHash: HASH, blockHash: BLOCK, blockNumber: BigInt(10), owner: OWNER, tokens: [TOKEN],
};
const word = (value: number) => '0x' + value.toString(16).padStart(64, '0');

function setup(transactions: string[] = [HASH]) {
  let changedReceipt = false;
  let badBalance = false;
  const request = vi.fn(async ({ method, params }: { method: string; params: readonly unknown[] }): Promise<unknown> => {
    if (method === 'web3_clientVersion') return 'Geth/v1.16.5/linux-amd64/go1.24';
    if (method === 'eth_getBlockByHash') return { hash: BLOCK, number: '0xa', parentHash: PARENT, transactions };
    if (method === 'eth_getTransactionReceipt') return { transactionHash: HASH, blockHash: changedReceipt ? PARENT : BLOCK, blockNumber: '0xa' };
    if (method === 'eth_call') return badBalance ? '0x01' : word((params[1] as { blockHash: string }).blockHash === PARENT ? 10 : 100);
    if (method === 'debug_traceCall') {
      const call = params[0] as Record<string, unknown>;
      const index = Number(BigInt((params[2] as { txIndex: string }).txIndex));
      return { type: 'CALL', from: OWNER, to: call.to, input: call.data, output: word(index === transactions.indexOf(HASH) ? 10 : 100) };
    }
    if (method === 'debug_traceTransaction') return { type: 'CALL', from: OWNER, to: TOKEN, input: '0x12345678', value: '0x0' };
    throw new Error('Unexpected RPC method');
  });
  const client = {
    request,
    getChainId: async () => 1,
    getTransaction: async () => { throw new Error('unused'); },
    getTransactionReceipt: async () => { throw new Error('unused'); },
    getBlock: async () => ({ hash: BLOCK }),
    getBlockNumber: async () => BigInt(10),
  };
  return { client, request, changeReceipt: () => { changedReceipt = true; }, badBalance: () => { badBalance = true; } };
}

describe('receipt evidence RPC adapter', () => {
  it('refuses unknown clients that might silently ignore transaction indices', async () => {
    const f = setup();
    f.request.mockResolvedValue('HardhatNetwork/3');
    await expect(withReceiptEvidence(f.client, { balanceState: 'GETH_TRANSACTION_INDEX' }).getPurchaseBalanceChanges!(context)).rejects.toThrow('Geth 1.16');
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it('uses canonical block-hash eth_call reads only for an isolated transaction block', async () => {
    const f = setup();
    const result = await withReceiptEvidence(f.client).getPurchaseBalanceChanges!(context);
    expect(result.scope).toBe('SINGLE_TRANSACTION_BLOCK');
    expect(result.balances).toEqual([{ token: TOKEN, beforeRaw: BigInt(10), afterRaw: BigInt(100) }]);
    const calls = f.request.mock.calls.map(([call]) => call).filter(call => call.method === 'eth_call');
    expect(calls.map(call => call.params[1])).toEqual([
      { blockHash: PARENT, requireCanonical: true }, { blockHash: BLOCK, requireCanonical: true },
    ]);
  });

  it('refuses busy block deltas rather than attributing another transaction’s funds to this purchase', async () => {
    const f = setup([OTHER_TX, HASH]);
    await expect(withReceiptEvidence(f.client).getPurchaseBalanceChanges!(context)).rejects.toThrow('Busy block');
    expect(f.request.mock.calls.some(([call]) => call.method === 'eth_call')).toBe(false);
  });

  it('uses current and next BEFORE-transaction indices in explicitly enabled Geth mode', async () => {
    const f = setup([OTHER_TX, HASH, hex('8', 64)]);
    const result = await withReceiptEvidence(f.client, { balanceState: 'GETH_TRANSACTION_INDEX' }).getPurchaseBalanceChanges!(context);
    expect(result.scope).toBe('TRANSACTION');
    expect(result.balances[0].afterRaw - result.balances[0].beforeRaw).toBe(BigInt(90));
    const calls = f.request.mock.calls.map(([call]) => call).filter(call => call.method === 'debug_traceCall');
    expect(calls.map(call => call.params[2])).toEqual([
      { tracer: 'callTracer', txIndex: '0x1' }, { tracer: 'callTracer', txIndex: '0x2' },
    ]);
  });

  it('reads the final block state after the final transaction, without an out-of-range trace index', async () => {
    const f = setup([OTHER_TX, HASH]);
    const result = await withReceiptEvidence(f.client, { balanceState: 'GETH_TRANSACTION_INDEX' }).getPurchaseBalanceChanges!(context);
    expect(result.balances[0].afterRaw).toBe(BigInt(100));
    expect(f.request.mock.calls.filter(([call]) => call.method === 'debug_traceCall')).toHaveLength(1);
    expect(f.request.mock.calls.filter(([call]) => call.method === 'eth_call')).toHaveLength(1);
  });

  it('rechecks receipt inclusion after obtaining a call trace', async () => {
    const f = setup(); f.changeReceipt();
    await expect(withReceiptEvidence(f.client).tracePurchaseCall!(context)).rejects.toThrow('inclusion changed');
  });

  it('refuses missing/duplicate transaction membership and malformed balance outputs', async () => {
    for (const transactions of [[OTHER_TX], [HASH, HASH]]) {
      await expect(withReceiptEvidence(setup(transactions).client).getPurchaseBalanceChanges!(context)).rejects.toThrow();
    }
    const f = setup(); f.badBalance();
    await expect(withReceiptEvidence(f.client).getPurchaseBalanceChanges!(context)).rejects.toThrow('uint256');
  });

  it('preserves missing-trace capability errors so the verifier can return indeterminate', async () => {
    const f = setup(); f.request.mockRejectedValue(new Error('method not supported'));
    await expect(withReceiptEvidence(f.client).tracePurchaseCall!(context)).rejects.toThrow('not supported');
  });
});
