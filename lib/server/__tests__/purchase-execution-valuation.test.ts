import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssetHolding, AssetIdentity, AssetPrice, BagRecord, BagVersionRecord, BasketRecipe, CanonicalAsset, NavResult, ShareSupply } from '@/types/basket-protocol';
import { DEFAULT_REBALANCE_RULE } from '@/types/basket-protocol';
import type { PurchaseIntentStepRecord } from '@/types/purchase-intent';

// -----------------------------------------------------------------------------
// Purchase intent creation when the oracle cannot value the Bag (e.g. Stock
// Tokens on a weekend): the purchase must still work from its own executable
// quote, must stop when there is no quote or a holding cannot be valued, and
// must keep the oracle path unchanged when the oracle works.
// -----------------------------------------------------------------------------

const getBagNavSafeMock = vi.fn();
const getBagAssetHoldingsMock = vi.fn();
const priceHoldingsIndividuallyMock = vi.fn();
const buildPurchaseIntentStepsMock = vi.fn();
const createPurchaseIntentMock = vi.fn();
const stockGuardMock = vi.fn();
const listAssetsMock = vi.fn();
const getCurrentBagVersionMock = vi.fn();

vi.mock('@/lib/server/bag-repo', () => ({ getBagById: async () => bagRecord(), getCurrentBagVersion: (...a: unknown[]) => getCurrentBagVersionMock(...a) }));
vi.mock('@/lib/server/asset-repo', () => ({
  getVerifiedIdentityKeys: async () => new Set(['ethereum:' + NVDA, 'ethereum:' + AAPL]),
  listAssets: (...a: unknown[]) => listAssetsMock(...a),
}));
vi.mock('@/lib/server/asset-route-check', () => ({ checkAssetRoute: async () => 'ROUTABLE' }));
vi.mock('@/lib/server/stock-token-guard', () => ({ checkStockTokensForPurchase: (...a: unknown[]) => stockGuardMock(...a) }));
vi.mock('@/lib/server/bag-nav', () => ({
  getBagNavSafe: (...a: unknown[]) => getBagNavSafeMock(...a),
  getBagAssetHoldings: (...a: unknown[]) => getBagAssetHoldingsMock(...a),
  priceHoldingsIndividually: (...a: unknown[]) => priceHoldingsIndividuallyMock(...a),
}));
vi.mock('@/lib/server/bag-share-state-repo', () => ({ getShareSupply: async () => supply() }));
vi.mock('@/lib/blockchain/lifi-purchase-quote', () => ({
  buildPurchaseIntentSteps: (...a: unknown[]) => buildPurchaseIntentStepsMock(...a),
  DEFAULT_COMPOSER_SLIPPAGE_BPS: 100,
}));
vi.mock('@/lib/server/purchase-intent-repo', () => ({
  createPurchaseIntent: (...a: unknown[]) => createPurchaseIntentMock(...a),
  findActivePurchaseIntentForBag: async () => null,
}));
const priceMock = vi.fn();
vi.mock('@/lib/server/price-provider', () => ({ getPriceProvider: () => ({ getPrice: (...a: unknown[]) => priceMock(...a) }) }));

const { createPurchaseIntentForUser } = await import('../purchase-execution');

const NVDA = '0x1111111111111111111111111111111111111111';
const AAPL = '0x2222222222222222222222222222222222222222';
const OLD = '0x3333333333333333333333333333333333333333';
const e18 = (n: number) => (BigInt(Math.round(n * 1e6)) * BigInt(1e12)).toString();
const USDC: CanonicalAsset = {
  id: 'asset_usdc', chain: 'ethereum', address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', symbol: 'USDC', decimals: 6, name: 'USD Coin',
  status: 'VERIFIED', assetType: 'crypto', createdAt: '', updatedAt: '',
};

function recipe(over: Partial<BasketRecipe> = {}): BasketRecipe {
  return {
    id: 'r', bagId: 'bag_1', name: 'AI', symbol: 'AI', description: '', chain: 'ethereum', strategyType: 'STATIC_BASKET',
    assets: [
      { chain: 'ethereum', address: NVDA, symbol: 'NVDA', decimals: 18, weightBps: 6000 },
      { chain: 'ethereum', address: AAPL, symbol: 'AAPL', decimals: 18, weightBps: 4000 },
    ],
    rebalanceRule: DEFAULT_REBALANCE_RULE, minInvestment: 1, maxAssets: 10, minWeightBps: 100, maxWeightBps: 8000, mutability: 'MUTABLE', version: 1, createdAt: '', ...over,
  };
}
function bagRecord(): BagRecord {
  return {
    id: 'bag_1', slug: 'ai', name: 'AI', symbol: 'AI', description: '', creatorId: 'c', chain: 'ethereum', strategyType: 'STATIC_BASKET', mutability: 'MUTABLE',
    status: 'ACTIVE', currentVersion: 1, currentVersionId: 'v1', parentBagId: null, rootBagId: null, registryId: null, contractAddress: null, createdAt: '', updatedAt: '',
  };
}
const version = (r = recipe()): BagVersionRecord => ({ id: 'v1', bagId: 'bag_1', version: 1, compositionHash: 'h', recipe: r, createdBy: 'c', reason: '', createdAt: '' });
const supply = (): ShareSupply => ({ bagId: 'bag_1', totalSharesRaw: e18(100), shareDecimals: 18, updatedAt: '' });
const oracleNav = (gross = '1000'): NavResult => ({ asOf: new Date().toISOString(), quoteCurrency: 'USD', components: [], grossNav: gross, netNav: gross });
const navDown = { ok: false, reason: 'PRICE_UNAVAILABLE', message: 'x', asset: { chain: 'ethereum', address: NVDA }, cause: 'MARKET_CLOSED_OR_HALTED' };
const holdings = (extra: AssetHolding[] = []): AssetHolding[] => [
  { asset: { chain: 'ethereum', address: NVDA }, quantityRaw: e18(99), decimals: 18 },
  { asset: { chain: 'ethereum', address: AAPL }, quantityRaw: e18(40), decimals: 18 },
  ...extra,
];

function step(i: number, address: string, inputUsdc: number, minOut: number, over: Partial<PurchaseIntentStepRecord> = {}): PurchaseIntentStepRecord {
  return {
    stepIndex: i, action: 'SWAP', targetSymbol: address === NVDA ? 'NVDA' : 'AAPL', inputAsset: { chain: 'ethereum', address: USDC.address }, outputAsset: { chain: 'ethereum', address },
    sourceChain: 'ethereum', destinationChain: 'ethereum', inputAmountRaw: String(inputUsdc * 1e6), targetValueRaw: String(inputUsdc * 1e6),
    outputAmountRaw: e18(minOut * 1.01), outputDecimals: 18, minOutputRaw: e18(minOut), route: 'x', lifiStep: {}, status: 'PENDING',
    approvalTxHash: null, txHash: null, providerSubstatus: null, failureCode: null, ...over,
  } as PurchaseIntentStepRecord;
}
const quotedSteps = () => [step(0, NVDA, 60, 9.9), step(1, AAPL, 40, 4)];
const create = (amount = '100') =>
  createPurchaseIntentForUser({ admin: {} as never, session: { userId: 'u', walletAddress: '0xREALWALLET000000000000000000000000000001' }, bagId: 'bag_1', inputAssetId: 'asset_usdc', amount });
const insertedShares = () => BigInt((createPurchaseIntentMock.mock.calls[0][1] as { sharesRaw: string }).sharesRaw);

beforeEach(() => {
  vi.clearAllMocks();
  priceMock.mockImplementation(async () => {
    throw new Error('unused');
  });
  delete process.env.LIFI_API_KEY;
  delete process.env.BAG_EXECUTION_COMPILER_ENABLED;
  stockGuardMock.mockResolvedValue({ ok: true });
  listAssetsMock.mockResolvedValue([USDC]);
  getCurrentBagVersionMock.mockResolvedValue(version());
  getBagAssetHoldingsMock.mockResolvedValue(holdings());
  priceHoldingsIndividuallyMock.mockResolvedValue({ prices: new Map(), failures: [] });
  buildPurchaseIntentStepsMock.mockResolvedValue({ steps: quotedSteps(), allSwapsQuoted: true, firstFailure: null, composerTransaction: null });
  createPurchaseIntentMock.mockImplementation(async (_a: unknown, input: Record<string, unknown>) => ({ id: 'intent_1', ...input }));
});

describe('purchase when the oracle cannot value the Bag (A, E, F)', () => {
  it('still creates a READY intent, with shares priced from the executable quote (in-kind, never above the ratio)', async () => {
    getBagNavSafeMock.mockResolvedValue(navDown);
    const outcome = await create();
    expect(outcome.ok).toBe(true);
    const input = createPurchaseIntentMock.mock.calls[0][1] as { status: string; navSnapshot: { grossNav: string }; steps: PurchaseIntentStepRecord[] };
    expect(input.status).toBe('READY');
    // The deposit adds 10% of every holding (9.9/99 NVDA, 4/40 AAPL) -> at most 10% of 100 shares.
    expect(insertedShares()).toBeLessThanOrEqual(BigInt(e18(10)));
    expect(insertedShares()).toBeGreaterThan(BigInt(e18(9.999)));
    expect(Number(input.navSnapshot.grossNav)).toBeCloseTo(1000, 6);
    // The buyer's protections are the quote's, untouched.
    expect(input.steps.map((s) => s.minOutputRaw)).toEqual([e18(9.9), e18(4)]);
    // Every holding was bought, so no other price source was asked.
    expect(priceHoldingsIndividuallyMock).not.toHaveBeenCalled();
  });

  it('works for any market price level: the share count follows the fill ratio, not an external price', async () => {
    getBagNavSafeMock.mockResolvedValue(navDown);
    buildPurchaseIntentStepsMock.mockResolvedValue({ steps: [step(0, NVDA, 60, 0.99), step(1, AAPL, 40, 0.4)], allSwapsQuoted: true, firstFailure: null, composerTransaction: null });
    expect((await create()).ok).toBe(true);
    // Fills are 10x smaller (prices 10x higher): the deposit now adds 1% of every holding -> ~1 share.
    expect(insertedShares()).toBeLessThanOrEqual(BigInt(e18(1)));
    expect(insertedShares()).toBeGreaterThan(BigInt(e18(0.9999)));
  });
});

describe('LI.FI Composer purchases (the production path)', () => {
  // Composer steps leave BAG's own minOutputRaw null; the on-chain floor is LI.FI's amountOutMin
  // (providerEnforcedMinOutputRaw). Reproduces the live "Your shares can't be priced right now" failure.
  const composerStep = (i: number, address: string, inputUsdc: number, providerMin: number | null, simulated: number) =>
    step(i, address, inputUsdc, 0, { minOutputRaw: null, providerEnforcedMinOutputRaw: providerMin === null ? null : e18(providerMin), outputAmountRaw: e18(simulated) });

  it('prices shares from the provider-enforced minimum (amountOutMin)', async () => {
    getBagNavSafeMock.mockResolvedValue(navDown);
    buildPurchaseIntentStepsMock.mockResolvedValue({
      steps: [composerStep(0, NVDA, 60, 9.9, 10), composerStep(1, AAPL, 40, 4, 4.04)],
      allSwapsQuoted: true,
      firstFailure: null,
      composerTransaction: { to: '0xc', data: '0x', value: '0', chainId: 1, userProxy: '0xp' },
    });
    const outcome = await create();
    expect(outcome.ok).toBe(true);
    expect(insertedShares()).toBeLessThanOrEqual(BigInt(e18(10)));
    expect(insertedShares()).toBeGreaterThan(BigInt(e18(9.999)));
    expect(priceHoldingsIndividuallyMock).not.toHaveBeenCalled();
  });

  it('without any reported minimum, uses the simulated output reduced by the Bag slippage tolerance (never the raw simulation)', async () => {
    getBagNavSafeMock.mockResolvedValue(navDown);
    buildPurchaseIntentStepsMock.mockResolvedValue({
      steps: [composerStep(0, NVDA, 60, null, 10), composerStep(1, AAPL, 40, null, 4.04)],
      allSwapsQuoted: true,
      firstFailure: null,
      composerTransaction: { to: '0xc', data: '0x', value: '0', chainId: 1, userProxy: '0xp' },
    });
    expect((await create()).ok).toBe(true);
    // Simulated 10 NVDA / 4.04 AAPL would be 10.1% / 10%; the haircut floor keeps the buyer at or below 10%.
    expect(insertedShares()).toBeLessThanOrEqual(BigInt(e18(10)));
  });
});

describe('purchase is blocked with an accurate reason (B, G, H)', () => {
  it('oracle down AND no executable quote: QUOTE_FAILED, nothing written, no price invented', async () => {
    getBagNavSafeMock.mockResolvedValue(navDown);
    buildPurchaseIntentStepsMock.mockResolvedValue({
      steps: [step(0, NVDA, 60, 9.9, { status: 'FAILED', minOutputRaw: null, outputAmountRaw: null }), step(1, AAPL, 40, 4)],
      allSwapsQuoted: false,
      firstFailure: { failureCode: 'PROVIDER_ERROR', message: 'Quote request timed out.' },
      composerTransaction: null,
    });
    const outcome = await create();
    expect(outcome).toEqual({ ok: false, error: { kind: 'QUOTE_FAILED', failureCode: 'PROVIDER_ERROR', message: 'Quote request timed out.' } });
    expect(createPurchaseIntentMock).not.toHaveBeenCalled();
  });

  it('a holding the purchase does not buy and that has no price: VALUATION_UNAVAILABLE naming it, nothing written', async () => {
    getBagNavSafeMock.mockResolvedValue(navDown);
    getBagAssetHoldingsMock.mockResolvedValue(holdings([{ asset: { chain: 'ethereum', address: OLD }, quantityRaw: e18(1), decimals: 18 }]));
    const outcome = await create();
    expect(outcome).toEqual({ ok: false, error: { kind: 'VALUATION_UNAVAILABLE', assets: [{ chain: 'ethereum', address: OLD }], labels: ['0x3333…3333'] } });
    expect(priceHoldingsIndividuallyMock).toHaveBeenCalledWith([{ asset: { chain: 'ethereum', address: OLD }, quantityRaw: e18(1), decimals: 18 }], expect.anything());
    expect(createPurchaseIntentMock).not.toHaveBeenCalled();
  });

  it('…but if that holding has a real oracle price of its own, the purchase proceeds', async () => {
    getBagNavSafeMock.mockResolvedValue(navDown);
    const old: AssetIdentity = { chain: 'ethereum', address: OLD };
    getBagAssetHoldingsMock.mockResolvedValue(holdings([{ asset: old, quantityRaw: e18(1), decimals: 18 }]));
    const price: AssetPrice = { asset: old, price: '5', quoteCurrency: 'USD', timestamp: new Date().toISOString(), source: 'oracle' };
    priceHoldingsIndividuallyMock.mockResolvedValue({ prices: new Map([[`ethereum:${OLD}`, price]]), failures: [] });
    expect((await create()).ok).toBe(true);
    expect(insertedShares()).toBeLessThan(BigInt(e18(10)));
  });

  it("Robinhood's Stock Token registry unreachable is reported as such, not as a price problem", async () => {
    stockGuardMock.mockResolvedValue({ ok: false, kind: 'REGISTRY_UNAVAILABLE', message: 'registry down' });
    getBagNavSafeMock.mockResolvedValue({ ok: true, nav: oracleNav() });
    expect(await create()).toEqual({ ok: false, error: { kind: 'STOCK_REGISTRY_UNAVAILABLE', message: 'registry down' } });
  });

  it('the minimum investment still applies without a price', async () => {
    getBagNavSafeMock.mockResolvedValue(navDown);
    getCurrentBagVersionMock.mockResolvedValue(version(recipe({ minInvestment: 500 })));
    const outcome = await create('100');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toMatchObject({ kind: 'PREVIEW_ERROR', message: 'The minimum investment for this Bag is $500.' });
    expect(buildPurchaseIntentStepsMock).not.toHaveBeenCalled();
  });
});

describe('oracle available: unchanged behaviour', () => {
  it('prices shares from the oracle NAV and never asks for execution valuation', async () => {
    getBagNavSafeMock.mockResolvedValue({ ok: true, nav: oracleNav('1000') });
    expect((await create()).ok).toBe(true);
    expect(insertedShares()).toBe(BigInt(e18(10)));
    expect(getBagAssetHoldingsMock).not.toHaveBeenCalled();
    expect(priceHoldingsIndividuallyMock).not.toHaveBeenCalled();
  });
});

describe('paying with native ETH', () => {
  const NATIVE = '0x0000000000000000000000000000000000000000';
  const WETH_MAINNET = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
  const ethStep = (i: number, address: string, wei: string, minOut: number) =>
    step(i, address, 0, minOut, { inputAsset: { chain: 'ethereum', address: NATIVE }, inputAmountRaw: wei, targetValueRaw: wei });
  const buyWithEth = (amount: string) =>
    createPurchaseIntentForUser({ admin: {} as never, session: { userId: 'u', walletAddress: '0xREALWALLET000000000000000000000000000001' }, bagId: 'bag_1', inputAssetId: 'native:ethereum', amount });
  const inserted = () => createPurchaseIntentMock.mock.calls[0][1] as { inputAsset: AssetIdentity; inputAmountRaw: string; depositAmount: string; sharesRaw: string; status: string };

  beforeEach(() => {
    priceMock.mockImplementation(async (asset: AssetIdentity): Promise<AssetPrice> => {
      if (asset.address !== WETH_MAINNET) throw new Error(`unexpected price request ${asset.address}`);
      return { asset, price: '3000', quoteCurrency: 'USD', timestamp: new Date().toISOString(), source: 'test' };
    });
    buildPurchaseIntentStepsMock.mockResolvedValue({
      steps: [ethStep(0, NVDA, '30000000000000000', 9.9), ethStep(1, AAPL, '20000000000000000', 4)],
      allSwapsQuoted: true,
      firstFailure: null,
      composerTransaction: null,
    });
  });

  it('oracle NAV: routes wei, but shares and cost basis are the USD value (0.05 ETH × $3000 = $150 → 15 shares at $10)', async () => {
    getBagNavSafeMock.mockResolvedValue({ ok: true, nav: oracleNav('1000') });
    expect((await buyWithEth('0.05')).ok).toBe(true);
    const row = inserted();
    expect(row.inputAsset).toEqual({ chain: 'ethereum', address: NATIVE });
    expect(row.inputAmountRaw).toBe('50000000000000000');
    expect(BigInt(row.sharesRaw)).toBe(BigInt(e18(15)));
    expect(row.depositAmount).toMatch(/^150(\.0+)?$/);
    // The legs the routes are quoted for spend ETH, never USDC.
    const routedSteps = buildPurchaseIntentStepsMock.mock.calls[0][0] as { route: { inputAsset: AssetIdentity; inputAmountRaw: string } }[];
    expect(routedSteps.every((st) => st.route.inputAsset.address === NATIVE)).toBe(true);
  });

  it('oracle down: shares from the ETH execution quote, valued in USD — the in-kind ratio still holds (10% of every holding → ≤ 10 shares)', async () => {
    getBagNavSafeMock.mockResolvedValue(navDown);
    expect((await buyWithEth('0.05')).ok).toBe(true);
    expect(insertedShares()).toBeLessThanOrEqual(BigInt(e18(10)));
    expect(insertedShares()).toBeGreaterThan(BigInt(e18(9.999)));
    expect(inserted().status).toBe('READY');
  });

  it('no ETH price: the purchase stops before any route is quoted or row written (nothing is estimated)', async () => {
    getBagNavSafeMock.mockResolvedValue({ ok: true, nav: oracleNav('1000') });
    priceMock.mockRejectedValue(new Error('price source down'));
    const outcome = await buyWithEth('0.05');
    expect(outcome).toMatchObject({ ok: false, error: { kind: 'PREVIEW_ERROR' } });
    expect(buildPurchaseIntentStepsMock).not.toHaveBeenCalled();
    expect(createPurchaseIntentMock).not.toHaveBeenCalled();
  });

  it('a minimum investment is checked in USD: 0.0003 ETH ($0.90) is below a $1 minimum', async () => {
    getBagNavSafeMock.mockResolvedValue({ ok: true, nav: oracleNav('1000') });
    const outcome = await buyWithEth('0.0003');
    expect(outcome).toMatchObject({ ok: false, error: { kind: 'PREVIEW_ERROR' } });
    expect(createPurchaseIntentMock).not.toHaveBeenCalled();
  });
});
