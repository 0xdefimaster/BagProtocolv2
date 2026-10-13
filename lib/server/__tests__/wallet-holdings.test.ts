import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublicClient } from 'viem';
import type { SupabaseClient } from '@supabase/supabase-js';
import { CanonicalAsset } from '@/types/basket-protocol';

const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const AAPL = '0x00000000000000000000000000000000000000a1';
const DOGE = '0x00000000000000000000000000000000000000d2';
const NONE = '0x00000000000000000000000000000000000000e3';
const WALLET = '0x49da000000000000000000000000000000fe46';

function asset(address: string, symbol: string, decimals: number, assetType: 'stock' | 'crypto' = 'crypto'): CanonicalAsset {
  return { id: symbol, chain: 'robinhood', address, symbol, name: symbol, decimals, status: 'VERIFIED', assetType, createdAt: '', updatedAt: '' };
}
const registry = [asset(USDG, 'USDG', 6), asset(AAPL, 'AAPL', 18, 'stock'), asset(DOGE, 'DOGE', 8), asset(NONE, 'NONE', 18)];

const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const BASE_WETH = '0x00000000000000000000000000000000000000b4';
const baseRegistry = [{ ...asset(BASE_USDC, 'USDC', 6), chain: 'base' as const }, { ...asset(BASE_WETH, 'WETH', 18), chain: 'base' as const }];
const listAssets = vi.fn(async (_admin: unknown, filter: { chain: string }) => (filter.chain === 'base' ? baseRegistry : filter.chain === 'robinhood' ? registry : []));
vi.mock('@/lib/server/asset-repo', () => ({ listAssets: (...a: [unknown, { chain: string }]) => listAssets(...a) }));
const buildComposerSweep = vi.fn();
vi.mock('@/lib/blockchain/lifi-composer-adapter', () => ({
  buildComposerSweep: (...args: unknown[]) => buildComposerSweep(...args),
  sweepNodeId: (i: number) => `sweep_${i}`,
}));

import { getWalletHoldings, getWalletHoldingsAllChains, quoteWalletSweep, usdValueOf } from '../wallet-holdings';

const balances: Record<string, bigint> = {
  [USDG.toLowerCase()]: BigInt(2_500_000), // 2.5 USDG
  [AAPL]: BigInt('500000000000000000'), // 0.5 AAPL
  [DOGE]: BigInt(1_000_000_000), // 10 DOGE
  [NONE]: BigInt(0),
  [BASE_USDC.toLowerCase()]: BigInt(4_000_000), // 4 USDC
  [BASE_WETH]: BigInt('1000000000000000'), // 0.001 WETH
};

function fakeClient(opts: { multicall?: boolean } = {}) {
  const readContract = vi.fn(async ({ address }: { address: string }) => balances[address.toLowerCase()] ?? BigInt(0));
  const multicall = vi.fn(async ({ contracts }: { contracts: { address: string }[] }) =>
    contracts.map((c) => ({ status: 'success', result: balances[c.address.toLowerCase()] ?? BigInt(0) }))
  );
  const client = {
    getCode: vi.fn(async () => (opts.multicall ? '0x6080' : undefined)),
    getBalance: vi.fn(async () => BigInt('20000000000000000')),
    readContract,
    multicall,
  };
  return { client: client as unknown as PublicClient, readContract, multicall };
}

const prices: Record<string, string> = { [USDG.toLowerCase()]: '1', [AAPL]: '230.5' };
const priceProvider = {
  getPrice: vi.fn(async ({ address }: { address: string }) => {
    const price = prices[address.toLowerCase()];
    if (!price) throw new Error('no price');
    return { asset: { chain: 'robinhood' as const, address }, price, quoteCurrency: 'USD', timestamp: '', source: 'test' };
  }),
};
const admin = {} as SupabaseClient;

beforeEach(() => {
  buildComposerSweep.mockReset();
});

describe('usdValueOf', () => {
  it('multiplies in integer math and rounds down to cents', () => {
    expect(usdValueOf(BigInt('500000000000000000'), 18, '230.5')).toBe('115.25');
    expect(usdValueOf(BigInt(1), 6, '0.123456789012345678901')).toBe('0');
  });
});

describe('getWalletHoldings', () => {
  it('lists only held tokens, priced when a price exists, USDG marked as the receive token', async () => {
    const { client, multicall } = fakeClient();
    const h = await getWalletHoldings(admin, client, priceProvider, WALLET);
    expect(multicall).not.toHaveBeenCalled(); // no Multicall3 deployed → one call per token
    expect(h.tokens.map((t) => t.symbol)).toEqual(['AAPL', 'USDG', 'DOGE']);
    expect(h.tokens.find((t) => t.symbol === 'AAPL')).toMatchObject({ balance: '0.5', usdValue: '115.25', sellable: true });
    expect(h.tokens.find((t) => t.symbol === 'USDG')).toMatchObject({ usdValue: '2.5', sellable: false });
    expect(h.tokens.find((t) => t.symbol === 'DOGE')).toMatchObject({ balance: '10', priceUsd: null, usdValue: null });
    expect(h.nativeBalance).toBe('0.02');
  });

  it('uses Multicall3 only when its contract is deployed', async () => {
    const { client, multicall, readContract } = fakeClient({ multicall: true });
    await getWalletHoldings(admin, client, priceProvider, WALLET);
    expect(multicall).toHaveBeenCalledTimes(1);
    expect(readContract).not.toHaveBeenCalled();
  });
});

describe('quoteWalletSweep', () => {
  const sell = (tokens: { address: string; amountRaw: string }[], extra: object = {}) =>
    quoteWalletSweep(admin, fakeClient().client, WALLET, { tokens, ...extra }, { apiKey: 'k' });

  it('refuses unknown tokens, the receive token, duplicates and amounts above the balance — before asking LI.FI', async () => {
    expect(await sell([{ address: '0x0000000000000000000000000000000000000bad', amountRaw: '1' }])).toMatchObject({ ok: false, status: 400 });
    expect(await sell([{ address: USDG, amountRaw: '1' }])).toMatchObject({ ok: false, error: expect.stringMatching(/receive/) });
    expect(await sell([{ address: DOGE, amountRaw: '1' }, { address: DOGE, amountRaw: '1' }])).toMatchObject({ ok: false, error: expect.stringMatching(/twice/) });
    expect(await sell([{ address: DOGE, amountRaw: '1000000001' }])).toMatchObject({ ok: false, error: expect.stringMatching(/Not enough DOGE/) });
    expect(await sell([{ address: DOGE, amountRaw: '1' }], { acceptedPriceImpactBps: 1600 })).toMatchObject({ ok: false, status: 400 });
    expect(await quoteWalletSweep(admin, fakeClient().client, WALLET, { tokens: [{ address: DOGE, amountRaw: '1' }] }, { apiKey: undefined })).toMatchObject({ ok: false, status: 503 });
    expect(buildComposerSweep).not.toHaveBeenCalled();
  });

  it('returns one transaction with per-token and total expected / minimum USDG', async () => {
    buildComposerSweep.mockResolvedValue({
      transactionRequest: { to: '0xVM', data: '0xabc', value: '0', chainId: 4663 },
      approvals: [{ token: AAPL, spender: '0xVM', amountRaw: '500000000000000000' }],
      producedResources: {
        'sweep_0.amountOut': { simulated: { amountOut: BigInt(115_000_000), amountOutMin: BigInt(113_850_000) } },
        'sweep_1.amountOut': { simulated: { amountOut: BigInt(1_200_000), amountOutMin: BigInt(1_188_000) } },
      },
      priceImpact: { impactBps: 42 },
    });
    const r = await sell([{ address: AAPL, amountRaw: '500000000000000000' }, { address: DOGE, amountRaw: '1000000000' }]);
    expect(r).toMatchObject({ ok: true, expectedOutRaw: '116200000', minOutRaw: '115038000', priceImpactBps: 42 });
    expect(buildComposerSweep.mock.calls[0][0]).toMatchObject({ outputTokenAddress: USDG, signerAddress: WALLET, slippageBps: 100 });
  });

  it('reports a price-impact refusal so the user can accept it, with the accepted limit passed on the retry', async () => {
    buildComposerSweep.mockRejectedValueOnce(
      new Error('Composer flow compilation failed: simulation — Price impact 820 bps exceeds maximum 500 bps (input: $10.00, output: $9.18)')
    );
    const refused = await sell([{ address: DOGE, amountRaw: '1000000000' }]);
    expect(refused).toMatchObject({ ok: false, status: 422, composerFallback: { reason: 'PRICE_IMPACT', priceImpactBps: 820 } });

    buildComposerSweep.mockResolvedValueOnce({ transactionRequest: { to: '0xVM', data: '0x', value: '0', chainId: 4663 }, approvals: [], producedResources: {}, priceImpact: null });
    await sell([{ address: DOGE, amountRaw: '1000000000' }], { acceptedPriceImpactBps: 820 });
    expect(buildComposerSweep.mock.calls[1][0]).toMatchObject({ maxPriceImpactBps: 920 });
  });
});

describe('other chains', () => {
  it('reads the chain\'s own registry and marks its stablecoin (USDC on Base) as the receive token', async () => {
    const { client } = fakeClient();
    const h = await getWalletHoldings(admin, client, priceProvider, WALLET, 'base');
    expect(h).toMatchObject({ chain: 'base', chainId: 8453, outputToken: { address: BASE_USDC, symbol: 'USDC', decimals: 6 } });
    expect(h.tokens.map((t) => [t.symbol, t.sellable])).toEqual(expect.arrayContaining([['USDC', false], ['WETH', true]]));
    expect(priceProvider.getPrice).toHaveBeenCalledWith({ chain: 'base', address: BASE_WETH });
  });

  it('a sale on Base is compiled on Base, into USDC, and only for Base registry tokens', async () => {
    buildComposerSweep.mockResolvedValue({ transactionRequest: { to: '0xVM', data: '0x', value: '0', chainId: 8453 }, approvals: [], producedResources: {}, priceImpact: null });
    const r = await quoteWalletSweep(admin, fakeClient().client, WALLET, { tokens: [{ address: BASE_WETH, amountRaw: '1000000000000000' }] }, { apiKey: 'k' }, 'base');
    expect(r).toMatchObject({ ok: true, transaction: { chainId: 8453 }, outputToken: { symbol: 'USDC' } });
    expect(buildComposerSweep.mock.calls[0][0]).toMatchObject({ chain: 'base', outputTokenAddress: BASE_USDC });
    // A Robinhood token is unknown on Base; USDC is what you receive there.
    expect(await quoteWalletSweep(admin, fakeClient().client, WALLET, { tokens: [{ address: AAPL, amountRaw: '1' }] }, { apiKey: 'k' }, 'base')).toMatchObject({ ok: false, status: 400 });
    expect(await quoteWalletSweep(admin, fakeClient().client, WALLET, { tokens: [{ address: BASE_USDC, amountRaw: '1' }] }, { apiKey: 'k' }, 'base')).toMatchObject({ ok: false, status: 400 });
  });

  it('all chains: each read independently; one failing chain reports its error and the others still load', async () => {
    const good = fakeClient().client;
    const bad = { ...fakeClient().client, getBalance: vi.fn(async () => { throw new Error('rpc down'); }) } as unknown as PublicClient;
    const r = await getWalletHoldingsAllChains(admin, (c) => (c === 'ethereum' ? bad : good), priceProvider, WALLET, ['ethereum', 'base', 'robinhood']);
    expect(r.map((x) => [x.chain, 'error' in x ? x.error : 'ok'])).toEqual([['ethereum', 'rpc down'], ['base', 'ok'], ['robinhood', 'ok']]);
  });
});

