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
const buildComposerPurchase = vi.fn();
vi.mock('@/lib/blockchain/lifi-composer-adapter', async (orig) => {
  const actual = await orig<typeof import('@/lib/blockchain/lifi-composer-adapter')>();
  return {
    buildComposerSweep: (...args: unknown[]) => buildComposerSweep(...args),
    buildComposerPurchase: (...args: unknown[]) => buildComposerPurchase(...args),
    // The real readers and error classifier: the tests feed them 0.6-shaped `outputs` and typed errors.
    sweepNodeId: actual.sweepNodeId,
    composerPortAmounts: actual.composerPortAmounts,
    composerLegSimulatedOutputRaw: actual.composerLegSimulatedOutputRaw,
    composerLegEnforcedMinOutputRaw: actual.composerLegEnforcedMinOutputRaw,
    composeErrorOf: actual.composeErrorOf,
  };
});
const { composeError, out } = await import('@/lib/blockchain/__tests__/composer-fixtures');

import { getWalletHoldings, getWalletHoldingsAllChains, quoteWalletBuy, quoteWalletSweep, usdValueOf } from '../wallet-holdings';

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
      outputs: {
        'sweep_0.amountOut': out(115_000_000, 113_850_000),
        'sweep_1.amountOut': out(1_200_000, 1_188_000),
      },
      kept: [{ address: AAPL }, { address: DOGE }],
      priceImpact: { impactBps: 42 },
    });
    const r = await sell([{ address: AAPL, amountRaw: '500000000000000000' }, { address: DOGE, amountRaw: '1000000000' }]);
    expect(r).toMatchObject({ ok: true, expectedOutRaw: '116200000', minOutRaw: '115038000', priceImpactBps: 42 });
    expect(buildComposerSweep.mock.calls[0][0]).toMatchObject({ outputTokenAddress: USDG, signerAddress: WALLET, slippageBps: 100 });
  });

  it('reports a price-impact refusal so the user can accept it, with the accepted limit passed on the retry', async () => {
    buildComposerSweep.mockRejectedValueOnce(await composeError('price_impact_exceeded', 'Price impact 820 bps exceeds maximum 500 bps (input: $10.00, output: $9.18)'));
    const refused = await sell([{ address: DOGE, amountRaw: '1000000000' }]);
    expect(refused).toMatchObject({ ok: false, status: 422, composerFallback: { reason: 'PRICE_IMPACT', priceImpactBps: 820 } });

    buildComposerSweep.mockResolvedValueOnce({ transactionRequest: { to: '0xVM', data: '0x', value: '0', chainId: 4663 }, approvals: [], outputs: {}, kept: [], priceImpact: null });
    await sell([{ address: DOGE, amountRaw: '1000000000' }], { acceptedPriceImpactBps: 820 });
    expect(buildComposerSweep.mock.calls[1][0]).toMatchObject({ maxPriceImpactBps: 920 });
  });
});

describe('Multi-sell: a token with no route', () => {
  const sell = (tokens: { address: string; amountRaw: string }[]) => quoteWalletSweep(admin, fakeClient().client, WALLET, { tokens }, { apiKey: 'k' });
  it('asks Composer to skip unroutable tokens and reports what was left out; legs and totals cover only what is sold', async () => {
    buildComposerSweep.mockResolvedValue({
      transactionRequest: { to: '0xVM', data: '0xabc', value: '0', chainId: 4663 },
      approvals: [],
      outputs: { 'sweep_0.amountOut': out(1_200_000, 1_188_000) },
      kept: [{ address: DOGE }],
      skipped: [{ index: 0, address: AAPL, symbol: 'AAPL', reason: 'No available quotes' }],
      priceImpact: null,
    });
    const r = await sell([{ address: AAPL, amountRaw: '500000000000000000' }, { address: DOGE, amountRaw: '1000000000' }]);
    expect(buildComposerSweep.mock.calls[0][0]).toMatchObject({ skipUnroutable: true });
    expect(r).toMatchObject({ ok: true, expectedOutRaw: '1200000', minOutRaw: '1188000', skipped: [{ address: AAPL, symbol: 'AAPL', reason: 'No available quotes' }] });
    expect((r as { legs: { symbol: string }[] }).legs.map((l) => l.symbol)).toEqual(['DOGE']);
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
    buildComposerSweep.mockResolvedValue({ transactionRequest: { to: '0xVM', data: '0x', value: '0', chainId: 8453 }, approvals: [], outputs: {}, kept: [], priceImpact: null });
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

describe('receive native ETH', () => {
  it('sells into ETH: compiled with nativeOutput, the stablecoin is allowed as an input, ETH reported as what you receive', async () => {
    buildComposerSweep.mockResolvedValue({ transactionRequest: { to: '0xVM', data: '0x', value: '0', chainId: 4663 }, approvals: [], outputs: {}, kept: [], priceImpact: null });
    const r = await quoteWalletSweep(admin, fakeClient().client, WALLET, { receive: 'NATIVE', tokens: [{ address: USDG, amountRaw: '2500000' }, { address: AAPL, amountRaw: '1' }] }, { apiKey: 'k' });
    expect(r).toMatchObject({ ok: true, outputToken: { address: '0x0000000000000000000000000000000000000000', symbol: 'ETH', decimals: 18, native: true } });
    expect(buildComposerSweep.mock.calls[0][0]).toMatchObject({ nativeOutput: true });
  });

  it('the default stays the stablecoin, and an unknown receive value is refused', async () => {
    buildComposerSweep.mockResolvedValue({ transactionRequest: { to: '0xVM', data: '0x', value: '0', chainId: 4663 }, approvals: [], outputs: {}, kept: [], priceImpact: null });
    const r = await quoteWalletSweep(admin, fakeClient().client, WALLET, { tokens: [{ address: AAPL, amountRaw: '1' }] }, { apiKey: 'k' });
    expect(r).toMatchObject({ ok: true, outputToken: { symbol: 'USDG', native: false } });
    expect(buildComposerSweep.mock.calls[0][0].nativeOutput).toBeUndefined();
    expect(await quoteWalletSweep(admin, fakeClient().client, WALLET, { receive: 'BTC' as never, tokens: [{ address: AAPL, amountRaw: '1' }] }, { apiKey: 'k' })).toMatchObject({ ok: false, status: 400 });
  });
});

describe('quoteWalletBuy', () => {
  const ETH = BigInt('20000000000000000'); // fakeClient's native balance: 0.02 ETH
  const compiled = (value: string, approvals: unknown[] = []) => ({
    transactionRequest: { to: '0xVM', data: '0xabc', value, chainId: 4663 },
    approvals,
    outputs: {
      'swap_0.amountOut': out(40, 39),
      'swap_1.amountOut': out(7, 6),
    },
    priceImpact: { impactBps: 12 },
  });
  const buy = (req: Record<string, unknown>, chain: 'robinhood' | 'base' = 'robinhood') =>
    quoteWalletBuy(admin, fakeClient().client, WALLET, req as never, { apiKey: 'k' }, chain);

  beforeEach(() => buildComposerPurchase.mockReset());

  it('pays with ETH by default: one Composer purchase from the native sentinel, no approval, legs with expected and minimum outputs', async () => {
    buildComposerPurchase.mockResolvedValue(compiled('10000000000000000'));
    const r = await buy({ amountRaw: '10000000000000000', buys: [{ address: AAPL, weightBps: 5000 }, { address: DOGE, weightBps: 5000 }] });
    expect(r).toMatchObject({
      ok: true,
      transaction: { value: '10000000000000000', chainId: 4663 },
      approvals: [],
      payToken: { symbol: 'ETH', native: true },
      legs: [
        { symbol: 'AAPL', weightBps: 5000, expectedOutRaw: '40', minOutRaw: '39' },
        { symbol: 'DOGE', weightBps: 5000, expectedOutRaw: '7', minOutRaw: '6' },
      ],
      priceImpactBps: 12,
    });
    expect(buildComposerPurchase.mock.calls[0][0]).toMatchObject({
      chain: 'robinhood',
      inputTokenAddress: '0x0000000000000000000000000000000000000000',
      inputAmountRaw: '10000000000000000',
      legs: [{ address: AAPL, weightBps: 5000 }, { address: DOGE, weightBps: 5000 }],
      signerAddress: WALLET,
    });
  });

  it('refuses tokens the liquidity pass marked NO_ROUTE, naming them, before asking Composer', async () => {
    const base = await listAssets(admin, { chain: 'robinhood' });
    listAssets.mockImplementationOnce(async () => base.map((a) => (a.address === DOGE ? { ...a, routeStatus: 'NO_ROUTE' as const } : a)));
    const r = await buy({ amountRaw: '10000000000000000', buys: [{ address: AAPL, weightBps: 5000 }, { address: DOGE, weightBps: 5000 }] });
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect((r as { error: string }).error).toContain('DOGE');
    expect((r as { error: string }).error).not.toContain('AAPL');
    expect(buildComposerPurchase).not.toHaveBeenCalled();
  });

  it('pays with the stablecoin when asked; the stablecoin itself cannot be bought then', async () => {
    buildComposerPurchase.mockResolvedValue(compiled('0', [{ token: USDG, spender: '0xVM', amountRaw: '1000000' }]));
    expect(await buy({ pay: 'STABLE', amountRaw: '1000000', buys: [{ address: AAPL, weightBps: 10000 }] })).toMatchObject({ ok: true, payToken: { symbol: 'USDG', native: false } });
    expect(buildComposerPurchase.mock.calls[0][0]).toMatchObject({ inputTokenAddress: USDG });
    expect(await buy({ pay: 'STABLE', amountRaw: '1000000', buys: [{ address: USDG, weightBps: 10000 }] })).toMatchObject({ ok: false, status: 400 });
  });

  it('refuses before asking LI.FI: no amount, unknown or duplicate tokens, shares not 100%, more than the wallet holds, a bad pay value', async () => {
    const one = [{ address: AAPL, weightBps: 10000 }];
    for (const req of [
      { amountRaw: '0', buys: one },
      { amountRaw: '1', buys: [] },
      { amountRaw: '1', buys: [{ address: NONE.replace('e3', 'ff'), weightBps: 10000 }] },
      { amountRaw: '1', buys: [{ address: AAPL, weightBps: 5000 }, { address: AAPL, weightBps: 5000 }] },
      { amountRaw: '1', buys: [{ address: AAPL, weightBps: 6000 }, { address: DOGE, weightBps: 3000 }] },
      { amountRaw: (ETH + BigInt(1)).toString(), buys: one },
      { pay: 'BTC', amountRaw: '1', buys: one },
    ]) {
      expect(await buy(req), JSON.stringify(req)).toMatchObject({ ok: false, status: 400 });
    }
    expect(buildComposerPurchase).not.toHaveBeenCalled();
  });

  it('on Base, ETH pays for Base registry tokens; a Robinhood token is unknown there', async () => {
    buildComposerPurchase.mockResolvedValue({ ...compiled('1000'), transactionRequest: { to: '0xVM', data: '0x', value: '1000', chainId: 8453 } });
    expect(await buy({ amountRaw: '1000', buys: [{ address: BASE_WETH, weightBps: 10000 }] }, 'base')).toMatchObject({ ok: true, transaction: { chainId: 8453 } });
    expect(await buy({ amountRaw: '1000', buys: [{ address: AAPL, weightBps: 10000 }] }, 'base')).toMatchObject({ ok: false, status: 400 });
  });

  it('a price-impact refusal is reported so the buyer can accept it', async () => {
    buildComposerPurchase.mockRejectedValueOnce(await composeError('price_impact_exceeded', 'Price impact 820 bps exceeds maximum 500 bps (input: $10.00, output: $9.18)'));
    expect(await buy({ amountRaw: '1000', buys: [{ address: AAPL, weightBps: 10000 }] })).toMatchObject({ ok: false, status: 422, composerFallback: { priceImpactBps: 820 } });
  });
});

