import { beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, erc20Abi } from 'viem';
import type { Eip1193Provider } from '@/lib/wallet/eth-provider';

const mocks = vi.hoisted(() => ({
  provider: null as null | { request: ReturnType<typeof vi.fn> },
  ensureAllowance: vi.fn(),
  simulate: vi.fn(),
  send: vi.fn(),
  switchChain: vi.fn(),
}));

vi.mock('@/lib/wallet/eth-provider', () => ({ getEthereumProvider: () => mocks.provider }));
vi.mock('../lifi-wallet-client', () => ({
  ensureErc20AllowanceOnChain: mocks.ensureAllowance,
  simulateTransactionOnChain: mocks.simulate,
  sendComposerTransaction: mocks.send,
  getBrowserWalletClientForChain: mocks.switchChain,
}));

import { executeWalletSweep, sendSweepBatch, walletSupportsAtomicBatch, SweepTransactionPlan } from '../wallet-sweep-client';

const WALLET = '0x49da00000000000000000000000000000000fe46';
const SPENDER = '0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae';
const A = '0x00000000000000000000000000000000000000a1';
const B = '0x00000000000000000000000000000000000000b2';
const SALE_HASH = `0x${'5'.repeat(64)}`;
const plan: SweepTransactionPlan = {
  transaction: { to: SPENDER, data: '0xdeadbeef', value: '0', chainId: 4663 },
  approvals: [
    { token: A, spender: SPENDER, amountRaw: '1000' },
    { token: B, spender: SPENDER, amountRaw: '2000' },
  ],
};
const uint = (n: bigint) => `0x${n.toString(16).padStart(64, '0')}`;
const noSleep = async () => {};
const prov = () => mocks.provider as unknown as Eip1193Provider;

/** A fake EIP-1193 wallet: allowances per token, capability answer, sendCalls / getCallsStatus behaviour. */
function wallet(opts: {
  allowances?: Record<string, bigint>;
  caps?: unknown;
  capsThrows?: boolean;
  sendCalls?: (params: unknown) => unknown;
  statuses?: unknown[];
}) {
  const statuses = [...(opts.statuses ?? [{ status: 200, atomic: true, receipts: [{ transactionHash: SALE_HASH, status: '0x1' }] }])];
  const request = vi.fn(async ({ method, params }: { method: string; params?: unknown[] }) => {
    switch (method) {
      case 'eth_chainId':
        return '0x1237';
      case 'eth_call': {
        const { to } = (params as [{ to: string }])[0];
        return uint(opts.allowances?.[to.toLowerCase()] ?? BigInt(0));
      }
      case 'wallet_getCapabilities':
        if (opts.capsThrows) throw Object.assign(new Error('Method not found'), { code: -32601 });
        return opts.caps ?? {};
      case 'wallet_sendCalls':
        return opts.sendCalls ? opts.sendCalls(params) : { id: 'batch-1' };
      case 'eth_blockNumber':
        return '0x10';
      case 'eth_getTransactionReceipt':
        return { transactionHash: SALE_HASH, blockNumber: '0x10', blockHash: `0x${'b'.repeat(64)}`, status: '0x1', logs: [], gasUsed: '0x1', cumulativeGasUsed: '0x1', effectiveGasPrice: '0x1', transactionIndex: '0x0', type: '0x2', from: WALLET, to: SPENDER, contractAddress: null, logsBloom: `0x${'0'.repeat(512)}` };
      case 'wallet_getCallsStatus':
        return statuses.length > 1 ? statuses.shift() : statuses[0];
      default:
        throw new Error(`unexpected ${method}`);
    }
  });
  mocks.provider = { request };
  return request;
}

const sentCalls = (request: ReturnType<typeof vi.fn>) => {
  const call = request.mock.calls.find(([a]) => a.method === 'wallet_sendCalls');
  return call ? (call[0].params[0] as { atomicRequired: boolean; chainId: string; from: string; calls: { to: string; data: `0x${string}`; value: string }[] }) : null;
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.provider = null;
  mocks.send.mockResolvedValue(SALE_HASH);
});

describe('walletSupportsAtomicBatch', () => {
  it('true for EIP-5792 v2 atomic supported/ready, and the older atomicBatch flag', async () => {
    for (const caps of [{ '0x1237': { atomic: { status: 'supported' } } }, { '0x1237': { atomic: { status: 'ready' } } }, { '0x1237': { atomicBatch: { supported: true } } }, { '0x0': { atomic: { status: 'supported' } } }]) {
      wallet({ caps });
      expect(await walletSupportsAtomicBatch(prov(), WALLET, 4663)).toBe(true);
    }
  });
  it('false when unsupported, for another chain only, or the wallet has no EIP-5792', async () => {
    for (const caps of [{ '0x1237': { atomic: { status: 'unsupported' } } }, { '0x1': { atomic: { status: 'supported' } } }, {}, null]) {
      wallet({ caps });
      expect(await walletSupportsAtomicBatch(prov(), WALLET, 4663)).toBe(false);
    }
    wallet({ capsThrows: true });
    expect(await walletSupportsAtomicBatch(prov(), WALLET, 4663)).toBe(false);
  });
});

describe('sendSweepBatch', () => {
  it('sends the exact-amount approvals then the sale, atomic required, and returns the sale hash', async () => {
    const request = wallet({});
    const hash = await sendSweepBatch(prov(), WALLET, plan, plan.approvals, noSleep);
    expect(hash).toBe(SALE_HASH);
    const sent = sentCalls(request)!;
    expect(sent.atomicRequired).toBe(true);
    expect(sent.chainId).toBe('0x1237');
    expect(sent.from).toBe(WALLET);
    expect(sent.calls).toHaveLength(3);
    const approve = (i: number) => {
      const d = decodeFunctionData({ abi: erc20Abi, data: sent.calls[i].data });
      return { functionName: d.functionName, args: [String(d.args?.[0]).toLowerCase(), d.args?.[1]] };
    };
    expect(sent.calls[0].to).toBe(A);
    expect(approve(0)).toEqual({ functionName: 'approve', args: [SPENDER, BigInt(1000)] });
    expect(sent.calls[1].to).toBe(B);
    expect(approve(1)).toEqual({ functionName: 'approve', args: [SPENDER, BigInt(2000)] });
    expect(sent.calls[2]).toEqual({ to: SPENDER, data: '0xdeadbeef', value: '0x0' });
  });

  it('waits while pending (and through a not-yet-known id), accepts the older string id / CONFIRMED form', async () => {
    wallet({ sendCalls: () => 'legacy-id', statuses: [null, { status: 100 }, { status: 'CONFIRMED', receipts: [{ transactionHash: SALE_HASH, status: '0x1' }] }] });
    expect(await sendSweepBatch(prov(), WALLET, plan, plan.approvals, noSleep)).toBe(SALE_HASH);
  });

  it('a reverted batch is an error, never a success', async () => {
    wallet({ statuses: [{ status: 500, receipts: [] }] });
    await expect(sendSweepBatch(prov(), WALLET, plan, plan.approvals, noSleep)).rejects.toThrow(/reverted/);
    wallet({ statuses: [{ status: 200, receipts: [{ transactionHash: SALE_HASH, status: '0x0' }] }] });
    await expect(sendSweepBatch(prov(), WALLET, plan, plan.approvals, noSleep)).rejects.toThrow(/reverted/);
  });

  it('a user rejection is passed through as is', async () => {
    wallet({ sendCalls: () => { throw Object.assign(new Error('User rejected the request.'), { code: 4001 }); } });
    await expect(sendSweepBatch(prov(), WALLET, plan, plan.approvals, noSleep)).rejects.toMatchObject({ code: 4001 });
  });
});

describe('executeWalletSweep', () => {
  const atomic = { '0x1237': { atomic: { status: 'supported' } } };

  it('batching wallet: one wallet_sendCalls with only the approvals still short, no separate approvals or sale', async () => {
    const request = wallet({ caps: atomic, allowances: { [A]: BigInt(5000) } }); // A already approved enough
    const steps: string[] = [];
    expect(await executeWalletSweep(WALLET, plan, (s) => steps.push(s))).toBe(SALE_HASH);
    expect(steps).toEqual(['batching']);
    const sent = sentCalls(request)!;
    expect(sent.calls.map((c) => c.to)).toEqual([B, SPENDER]);
    expect(mocks.ensureAllowance).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('wallet without atomic batching: the sequential flow, unchanged', async () => {
    const request = wallet({ caps: { '0x1237': { atomic: { status: 'unsupported' } } } });
    const steps: string[] = [];
    expect(await executeWalletSweep(WALLET, plan, (s) => steps.push(s))).toBe(SALE_HASH);
    expect(sentCalls(request)).toBeNull();
    expect(mocks.ensureAllowance).toHaveBeenCalledTimes(2);
    expect(mocks.simulate).toHaveBeenCalled();
    expect(mocks.send).toHaveBeenCalled();
    expect(steps).toEqual(['approving', 'simulating', 'signing', 'confirming']);
  });

  it('wallet without batching (Rabby): reports approval i of n for the approvals still short only', async () => {
    wallet({ capsThrows: true, allowances: { [A]: BigInt(1000) } });
    const approvals: [number, number, string][] = [];
    expect(await executeWalletSweep(WALLET, plan, () => {}, { onApproval: (i, n, t) => void approvals.push([i, n, t]) })).toBe(SALE_HASH);
    expect(approvals).toEqual([[1, 1, B]]);
    expect(mocks.ensureAllowance).toHaveBeenCalledTimes(1);
    expect(mocks.ensureAllowance).toHaveBeenCalledWith(WALLET, 4663, B, SPENDER, '2000');
  });

  it('wallet advertises batching but refuses it as unsupported: falls back to the sequential flow', async () => {
    wallet({ caps: atomic, sendCalls: () => { throw Object.assign(new Error('Unsupported'), { code: 5700 }); } });
    expect(await executeWalletSweep(WALLET, plan)).toBe(SALE_HASH);
    expect(mocks.ensureAllowance).toHaveBeenCalledTimes(2);
    expect(mocks.send).toHaveBeenCalled();
  });

  it('user rejects the batch: no fallback, no second prompt', async () => {
    wallet({ caps: atomic, sendCalls: () => { throw Object.assign(new Error('User rejected the request.'), { code: 4001 }); } });
    await expect(executeWalletSweep(WALLET, plan)).rejects.toMatchObject({ code: 4001 });
    expect(mocks.ensureAllowance).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('nothing to approve: the single sale transaction, no batch', async () => {
    const request = wallet({ caps: atomic, allowances: { [A]: BigInt(1000), [B]: BigInt(2000) } });
    expect(await executeWalletSweep(WALLET, plan)).toBe(SALE_HASH);
    expect(sentCalls(request)).toBeNull();
    expect(mocks.simulate).toHaveBeenCalled();
    expect(mocks.send).toHaveBeenCalled();
  });

  it('onSubmitted gets the sale hash: before the receipt wait on the sequential path, and for a batch', async () => {
    wallet({ caps: { '0x1237': { atomic: { status: 'unsupported' } } } });
    const order: string[] = [];
    await executeWalletSweep(WALLET, plan, (s) => order.push(s), { onSubmitted: (h) => void order.push(`submitted:${h}`) });
    expect(order).toEqual(['approving', 'simulating', 'signing', `submitted:${SALE_HASH}`, 'confirming']);

    wallet({ caps: { '0x1237': { atomic: { status: 'supported' } } } });
    const seen: string[] = [];
    await executeWalletSweep(WALLET, plan, () => {}, { onSubmitted: (h) => void seen.push(h) });
    expect(seen).toEqual([SALE_HASH]);
  });

  it('a failing onSubmitted (bookkeeping) never fails the sale', async () => {
    wallet({ caps: { '0x1237': { atomic: { status: 'unsupported' } } } });
    expect(await executeWalletSweep(WALLET, plan, () => {}, { onSubmitted: async () => { throw new Error('offline'); } })).toBe(SALE_HASH);
  });
});
