import { beforeEach, describe, expect, it, vi } from 'vitest';

const settlePurchases = vi.fn();
const listRedeems = vi.fn();
const verifyRedeem = vi.fn();
vi.mock('@/lib/server/purchase-execution', () => ({ settleUnsettledPurchasesForUser: (...a: unknown[]) => settlePurchases(...a) }));
vi.mock('@/lib/server/redeem-intent-repo', () => ({ listUnsettledRedeemIntentsForUser: (...a: unknown[]) => listRedeems(...a) }));
vi.mock('@/lib/server/redeem-execution', () => ({ verifyRedeemExecution: (...a: unknown[]) => verifyRedeem(...a) }));
vi.mock('@/lib/server/wallet-holdings', () => ({ MULTICALL3_ADDRESS: '0xcA11bde05977b3631167028862bE2a173976CA11' }));
const recordSnapshot = vi.fn();
vi.mock('@/lib/server/bag-nav-snapshots', () => ({ recordNavSnapshot: (...a: unknown[]) => recordSnapshot(...a) }));

import { readBalancesAtBlock, reconcileWallet } from '../wallet-reconciliation';

const WALLET = '0x49da000000000000000000000000000000000001';
const T1 = { chain: 'robinhood', address: '0x00000000000000000000000000000000000000a1', decimals: 18 };
const T2 = { chain: 'robinhood', address: '0x00000000000000000000000000000000000000a2', decimals: 6 };

beforeEach(() => {
  vi.clearAllMocks();
  settlePurchases.mockResolvedValue({ checked: 0, settled: 0 });
  listRedeems.mockResolvedValue([]);
  recordSnapshot.mockResolvedValue({ status: 'recorded' });
});

describe('readBalancesAtBlock', () => {
  it('reads every asset at the given block; a failed read is null, never 0', async () => {
    const client = { multicall: vi.fn(async () => [{ status: 'success', result: BigInt(5) }, { status: 'failure', error: new Error('x') }]) };
    expect(await readBalancesAtBlock(client as never, WALLET, [T1, T2], BigInt(77))).toEqual([BigInt(5), null]);
    expect((client.multicall.mock.calls[0] as unknown as [{ blockNumber: bigint }])[0].blockNumber).toBe(BigInt(77));
  });
  it('without multicall it falls back to single reads, still null on failure', async () => {
    const client = {
      multicall: vi.fn(async () => {
        throw new Error('no multicall');
      }),
      readContract: vi.fn(async (c: { address: string }) => {
        if (c.address === T2.address) throw new Error('reverted');
        return BigInt(9);
      }),
    };
    expect(await readBalancesAtBlock(client as never, WALLET, [T1, T2], BigInt(1))).toEqual([BigInt(9), null]);
  });
});

describe('reconcileWallet', () => {
  it('reconciles all three networks with separate blocks and never puts a Base block in the Robinhood scan checkpoint', async () => {
    const ids = { robinhood: 4663, base: 8453, arbitrum: 42161 };
    const rpc = vi.fn(async () => ({ data: { status: 'OK' }, error: null }));
    const r = await reconcileWallet({ rpc } as never, chain => ({
      getChainId: async () => ids[chain as keyof typeof ids],
      getBlockNumber: async () => BigInt(ids[chain as keyof typeof ids]),
      multicall: async () => [{ status: 'success', result: BigInt(5) }],
    }) as never, { userId: 'u1', walletAddress: WALLET, assets: Object.keys(ids).map(chain => ({ ...T1, chain })) });
    expect(r.assets).toHaveLength(3);
    expect(r.blockNumber).toBeNull();
    for (const [chain, block] of Object.entries(ids)) {
      expect(rpc).toHaveBeenCalledWith('apply_wallet_observation', expect.objectContaining({ p_chain: chain, p_block_number: block, p_observed_raw: '5' }));
    }
    expect(rpc).toHaveBeenCalledWith('mark_wallet_reconciled', { p_user_id: 'u1', p_block_number: null });
  });

  it('does not mark a partial cross-chain check fresh or turn an RPC failure into an outflow', async () => {
    const rpc = vi.fn(async () => ({ data: { status: 'OK' }, error: null }));
    const r = await reconcileWallet({ rpc } as never, chain => {
      if (chain === 'robinhood') throw new Error('offline');
      return { getChainId: async () => 8453, getBlockNumber: async () => BigInt(88), multicall: async () => [{ status: 'success', result: BigInt(5) }] } as never;
    }, { userId: 'u1', walletAddress: WALLET, assets: [T1, { ...T1, chain: 'base' }] });
    expect(r.assets.map(a => a.status)).toEqual(['UNREADABLE', 'OK']);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('apply_wallet_observation', expect.objectContaining({ p_chain: 'base', p_block_number: 88 }));
  });

  it('settles pending executions first, then observes each readable asset at one block and marks the wallet', async () => {
    const order: string[] = [];
    settlePurchases.mockImplementation(async () => void order.push('settle-purchases'));
    listRedeems.mockResolvedValue([{ id: 'r1' }]);
    verifyRedeem.mockImplementation(async () => void order.push('verify-redeem'));
    const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
      order.push(name);
      if (name === 'apply_wallet_observation') return { data: { status: args.p_address === T1.address ? 'DRIFT' : 'OK', shortfallRaw: '3' }, error: null };
      return { data: null, error: null };
    });
    const client = { getChainId: async () => 4663, getBlockNumber: vi.fn(async () => BigInt(500)), multicall: vi.fn(async () => [{ status: 'success', result: BigInt(1) }, { status: 'failure' }]) };

    const r = await reconcileWallet({ rpc } as never, client as never, { userId: 'u1', walletAddress: WALLET, assets: [T1, T2] });

    expect(order).toEqual(['settle-purchases', 'verify-redeem', 'apply_wallet_observation']);
    expect(r.blockNumber).toBe('500');
    expect(r.assets).toEqual([
      { chain: 'robinhood', address: T1.address, status: 'DRIFT', observedRaw: '1', shortfallRaw: '3' },
      { chain: 'robinhood', address: T2.address, status: 'UNREADABLE', observedRaw: null },
    ]);
    expect(rpc).toHaveBeenCalledWith('apply_wallet_observation', { p_user_id: 'u1', p_chain: 'robinhood', p_address: T1.address, p_block_number: 500, p_observed_raw: '1' });
  });

  it('unsupported assets never trigger chain reads', async () => {
    const rpc = vi.fn();
    const client = { getChainId: async () => 4663, getBlockNumber: vi.fn() };
    const r = await reconcileWallet({ rpc } as never, client as never, { userId: 'u1', walletAddress: WALLET, assets: [{ chain: 'solana', address: T1.address, decimals: 18 }] });
    expect(r).toEqual({ userId: 'u1', blockNumber: null, assets: [] });
    expect(client.getBlockNumber).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('a database error is surfaced, not swallowed', async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { message: 'boom' } }));
    const client = { getChainId: async () => 4663, getBlockNumber: vi.fn(async () => BigInt(1)), multicall: vi.fn(async () => [{ status: 'success', result: BigInt(1) }]) };
    await expect(reconcileWallet({ rpc } as never, client as never, { userId: 'u1', walletAddress: WALLET, assets: [T1] })).rejects.toThrow(/boom/);
  });

  it('a confirmed outflow prices the Bags that held that asset again right away (listing TVL follows)', async () => {
    const rpc = vi.fn(async (name: string, args: Record<string, unknown>) =>
      name === 'apply_wallet_observation' ? { data: { status: args.p_address === T1.address ? 'CONFIRMED_OUTFLOW' : 'DRIFT' }, error: null } : { data: null, error: null }
    );
    const eq = vi.fn(async () => ({
      data: [
        { chain: 'robinhood', bag_id: 'bag-a', address: T1.address.toUpperCase().replace('0X', '0x') },
        { chain: 'robinhood', bag_id: 'bag-a', address: T2.address },
        { chain: 'robinhood', bag_id: 'bag-b', address: T1.address },
        { chain: 'robinhood', bag_id: 'bag-c', address: T2.address },
      ],
      error: null,
    }));
    const from = vi.fn(() => ({ select: () => ({ eq }) }));
    const client = { getChainId: async () => 4663, getBlockNumber: vi.fn(async () => BigInt(9)), multicall: vi.fn(async () => [{ status: 'success', result: BigInt(0) }, { status: 'success', result: BigInt(1) }]) };

    await reconcileWallet({ rpc, from } as never, client as never, { userId: 'u1', walletAddress: WALLET, assets: [T1, T2] });

    expect(from).toHaveBeenCalledWith('bag_investor_holdings');
    expect(eq).toHaveBeenCalledWith('user_id', 'u1');
    expect(recordSnapshot.mock.calls.map((c) => [c[1], c[2]])).toEqual([
      ['bag-a', { minIntervalMs: 0 }],
      ['bag-b', { minIntervalMs: 0 }],
    ]);
  });

  it('no confirmed outflow → no extra pricing; a failed snapshot never fails the reconciliation', async () => {
    const rpc = vi.fn(async (name: string) => (name === 'apply_wallet_observation' ? { data: { status: 'DRIFT' }, error: null } : { data: null, error: null }));
    const from = vi.fn();
    const client = { getChainId: async () => 4663, getBlockNumber: vi.fn(async () => BigInt(9)), multicall: vi.fn(async () => [{ status: 'success', result: BigInt(0) }]) };
    await reconcileWallet({ rpc, from } as never, client as never, { userId: 'u1', walletAddress: WALLET, assets: [T1] });
    expect(from).not.toHaveBeenCalledWith('bag_investor_holdings');
    expect(recordSnapshot).not.toHaveBeenCalled();

    const confirmed = vi.fn(async (name: string) => (name === 'apply_wallet_observation' ? { data: { status: 'CONFIRMED_OUTFLOW' }, error: null } : { data: null, error: null }));
    const from2 = vi.fn(() => ({ select: () => ({ eq: async () => ({ data: [{ chain: 'robinhood', bag_id: 'bag-a', address: T1.address }], error: null }) }) }));
    recordSnapshot.mockRejectedValue(new Error('pricing down'));
    const r = await reconcileWallet({ rpc: confirmed, from: from2 } as never, client as never, { userId: 'u1', walletAddress: WALLET, assets: [T1] });
    expect(r.assets[0].status).toBe('CONFIRMED_OUTFLOW');
  });
});
