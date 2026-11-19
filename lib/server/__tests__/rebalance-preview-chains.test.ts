import { beforeEach, describe, expect, it, vi } from 'vitest';

// Keep the real observation and allocation path; only its I/O is replaced.
const A = '0x00000000000000000000000000000000000000a1';
const B = '0x00000000000000000000000000000000000000b2';
const E18 = BigInt(10) ** BigInt(18);
const m = vi.hoisted(() => ({ chain: 'base', rpc: vi.fn() }));
vi.mock('@/lib/auth/require-session', () => ({
  requireSession: async () => ({ ok: true, session: { userId: 'u1', walletAddress: '0x1111111111111111111111111111111111111111' } }),
}));
vi.mock('@/lib/server/rate-limit', () => ({ checkRateLimit: async () => ({ allowed: true }), rateLimitedResponseBody: () => ({}) }));
vi.mock('@/lib/supabase/server', () => ({
  isSupabaseConfigured: () => true,
  supabaseAdmin: () => ({ from: () => ({ select: () => ({ eq: async () => ({
    error: null,
    data: [
      { bag_id: 'target', chain: m.chain, address: A, decimals: 18, quantity_raw: (BigInt(60) * E18).toString() },
      { bag_id: 'target', chain: m.chain, address: B, decimals: 18, quantity_raw: (BigInt(40) * E18).toString() },
      { bag_id: 'other', chain: 'robinhood', address: A, decimals: 18, quantity_raw: (BigInt(90) * E18).toString() },
    ],
  }) }) }) }),
}));
vi.mock('@/lib/server/bag-repo', () => ({
  getBagById: async () => ({ id: 'target', chain: m.chain, status: 'ACTIVE', name: 'test' }),
  getCurrentBagVersion: async () => ({
    version: 1,
    recipe: {
      chain: m.chain,
      assets: [A, B].map(address => ({ chain: m.chain, address, decimals: 18, weightBps: 5000 })),
      rebalanceRule: { frequency: 'MANUAL', driftThresholdBps: 500, maxSlippageBps: 100 },
    },
  }),
}));
vi.mock('@/lib/server/asset-repo', () => ({ listAssets: async () => [A, B].map((address, i) => ({ chain: m.chain, address, symbol: i ? 'BBB' : 'AAA' })) }));
vi.mock('@/lib/server/price-provider', () => ({ getDisplayPriceProvider: () => ({ getPrice: async () => ({ price: '1' }) }) }));
vi.mock('@/lib/blockchain/rpc/clients', () => ({ getChainPublicClient: m.rpc }));
vi.mock('@/lib/server/wallet-holdings', () => ({ MULTICALL3_ADDRESS: '0xcA11bde05977b3631167028862bE2a173976CA11' }));

import { GET } from '@/app/api/bags/[id]/rebalance-preview/route';
const call = async () => (await GET({} as never, { params: Promise.resolve({ id: 'target' }) })).json();
const client = (chainId: number, block: number, amounts = [60, 40]) => ({
  getChainId: async () => chainId,
  getBlockNumber: async () => BigInt(block),
  multicall: async ({ contracts }: { contracts: { address: string }[] }) => contracts.map(({ address }) => ({
    status: 'success', result: BigInt(amounts[address === A ? 0 : 1]) * E18,
  })),
});

beforeEach(() => {
  m.chain = 'base';
  m.rpc.mockReset().mockImplementation((chain: string) => chain === 'base' ? client(8453, 88) : client(4663, 77, [90, 10]));
});

describe('allocation preview across chains', () => {
  it.each([['base', 8453, true], ['arbitrum', 42161, false]] as const)('reads %s balances and its block, without mixing a same-address Robinhood holding', async (chain, chainId, executionSupported) => {
    m.chain = chain;
    m.rpc.mockImplementation((requested: string) => requested === chain ? client(chainId, 88) : client(4663, 77, [90, 10]));
    const body = await call();
    expect(body).toMatchObject({ blockNumber: '88', executionSupported, preview: { status: 'OK', navQuote: '100.000000000000000000', maxAbsDriftBps: 1000 } });
    expect(body.preview.allocations.map((a: { currentWeightBps: number }) => a.currentWeightBps)).toEqual([6000, 4000]);
  });

  it('keeps Base readable when the other network is unavailable', async () => {
    m.rpc.mockImplementation((chain: string) => {
      if (chain === 'robinhood') throw new Error('offline');
      return client(8453, 88);
    });
    expect(await call()).toMatchObject({ blockNumber: '88', preview: { status: 'OK' } });
  });

  it('does not display a false balance when the Base RPC serves the wrong chain', async () => {
    m.rpc.mockReturnValue(client(4663, 77));
    // Base itself supports rebalancing; the unreadable balances keep the preview from offering one.
    expect(await call()).toMatchObject({ blockNumber: null, executionSupported: true, preview: { status: 'UNREADABLE_BALANCES' } });
  });
});
