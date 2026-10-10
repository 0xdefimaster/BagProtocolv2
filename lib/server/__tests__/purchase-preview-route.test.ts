import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import {
  BagRecord,
  BagVersionRecord,
  BasketRecipe,
  CanonicalAsset,
  DEFAULT_REBALANCE_RULE,
  NavResult,
  ShareSupply,
} from '@/types/basket-protocol';
import { ExecutionResult } from '@/lib/blockchain/execution-adapter';

// -----------------------------------------------------------------------------
// Phase 14 — route-level tests for `POST /api/bags/:id/purchase-preview`.
//
// `lib/server/__tests__/purchase-preview.test.ts` already exercises
// `computePurchasePreview()` (the pure allocation math) in full — this file
// does NOT re-test that. It only exercises what actually changed in Phase
// 14 at the HTTP boundary: the route wires `liFiExecutionAdapter` in behind
// an opt-in `?quotes=true` flag, without breaking any existing (pre-Phase-14)
// caller. Every repository module the route touches (bag-repo, asset-repo,
// bag-nav, bag-share-state-repo, supabase/server) is mocked — no real
// network or database call happens here, same "no real I/O in the unit
// suite" rule `lifi-execution-adapter.test.ts` documents for LI.FI itself.
//
// Placed under `lib/server/__tests__` (importing the route handler from its
// real `app/api/...` path) rather than under `app/api/...`, since
// `vitest.config.ts`'s `include` is scoped to `lib/**/*.test.ts` and this
// phase does not touch test-runner configuration.
// -----------------------------------------------------------------------------

const getBagByIdMock = vi.fn();
const getCurrentBagVersionMock = vi.fn();
const getVerifiedIdentityKeysMock = vi.fn();
const listAssetsMock = vi.fn();
const getBagNavMock = vi.fn();
const getShareSupplyMock = vi.fn();
const quoteExecutionPlanMock = vi.fn();
const checkRateLimitMock = vi.fn();

vi.mock('@/lib/server/rate-limit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/rate-limit')>();
  return {
    ...actual,
    checkRateLimit: (...args: unknown[]) => checkRateLimitMock(...args),
  };
});

vi.mock('@/lib/supabase/server', () => ({
  isSupabaseConfigured: () => true,
  supabaseAdmin: () => ({}) as never,
}));

vi.mock('@/lib/server/bag-repo', () => ({
  getBagById: (...args: unknown[]) => getBagByIdMock(...args),
  getCurrentBagVersion: (...args: unknown[]) => getCurrentBagVersionMock(...args),
}));

vi.mock('@/lib/server/asset-repo', () => ({
  getVerifiedIdentityKeys: (...args: unknown[]) => getVerifiedIdentityKeysMock(...args),
  listAssets: (...args: unknown[]) => listAssetsMock(...args),
}));

const navSafeOverride: { value: unknown } = { value: null };
const priceHoldingsIndividuallyMock = vi.fn();
vi.mock('@/lib/server/bag-nav', () => ({
  getBagNav: (...args: unknown[]) => getBagNavMock(...args),
  getBagNavSafe: async (...args: unknown[]) => navSafeOverride.value ?? { ok: true, nav: await getBagNavMock(...args) },
  getBagAssetHoldings: async () => [],
  priceHoldingsIndividually: (...args: unknown[]) => priceHoldingsIndividuallyMock(...args),
}));

vi.mock('@/lib/server/bag-share-state-repo', () => ({
  getShareSupply: (...args: unknown[]) => getShareSupplyMock(...args),
}));

vi.mock('@/lib/blockchain/lifi-execution-adapter', () => ({
  liFiExecutionAdapter: {
    name: 'lifi',
    isLive: true,
    quoteExecutionPlan: (...args: unknown[]) => quoteExecutionPlanMock(...args),
  },
}));

const priceMock = vi.fn();
vi.mock('@/lib/server/price-provider', () => ({ getPriceProvider: () => ({ getPrice: (...args: unknown[]) => priceMock(...args) }) }));

const { GET, POST } = await import('@/app/api/bags/[id]/purchase-preview/route');

const USDC: CanonicalAsset = {
  id: 'asset_usdc',
  chain: 'ethereum',
  address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  symbol: 'USDC',
  decimals: 6,
  name: 'USD Coin',
  status: 'VERIFIED',
  assetType: 'crypto',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const NVDA_ADDRESS = '0x1111111111111111111111111111111111111111';
const AAPL_ADDRESS = '0x2222222222222222222222222222222222222222';

function recipe(): BasketRecipe {
  return {
    id: 'recipe_bag_1_v1',
    bagId: 'bag_1',
    name: 'AI Revolution',
    symbol: 'AIREV',
    description: 'NVDA + AAPL',
    chain: 'ethereum',
    strategyType: 'STATIC_BASKET',
    assets: [
      { chain: 'ethereum', address: NVDA_ADDRESS, symbol: 'NVDA', decimals: 18, weightBps: 6000 },
      { chain: 'ethereum', address: AAPL_ADDRESS, symbol: 'AAPL', decimals: 18, weightBps: 4000 },
    ],
    rebalanceRule: DEFAULT_REBALANCE_RULE,
    minInvestment: 1,
    maxAssets: 10,
    minWeightBps: 100,
    maxWeightBps: 8000,
    mutability: 'MUTABLE',
    version: 1,
    createdAt: new Date().toISOString(),
  };
}

function bagRecord(): BagRecord {
  return {
    id: 'bag_1',
    slug: 'ai-revolution',
    name: 'AI Revolution',
    symbol: 'AIREV',
    description: 'NVDA + AAPL',
    creatorId: 'creator_1',
    chain: 'ethereum',
    strategyType: 'STATIC_BASKET',
    mutability: 'MUTABLE',
    status: 'ACTIVE',
    currentVersion: 1,
    currentVersionId: 'version_1',
    parentBagId: null,
    rootBagId: null,
    registryId: null,
    contractAddress: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function bagVersion(): BagVersionRecord {
  return {
    id: 'version_1',
    bagId: 'bag_1',
    version: 1,
    compositionHash: 'hash',
    recipe: recipe(),
    createdBy: 'creator_1',
    reason: 'initial',
    createdAt: new Date().toISOString(),
  };
}

function nav(): NavResult {
  return { asOf: new Date().toISOString(), quoteCurrency: 'USD', components: [], grossNav: '1000', netNav: '1000' };
}

function shareSupply(): ShareSupply {
  return { bagId: 'bag_1', totalSharesRaw: '100000000000000000000', shareDecimals: 18, updatedAt: new Date().toISOString() };
}

function mockExecutionResult(): ExecutionResult {
  return {
    bagId: 'bag_1',
    inputAsset: { chain: 'ethereum', address: USDC.address },
    inputAmountRaw: '100000000',
    steps: [],
    unallocatedRaw: '0',
  };
}

function postRequest(body: unknown, query = ''): NextRequest {
  return new NextRequest(`http://localhost/api/bags/bag_1/purchase-preview${query}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  getBagByIdMock.mockReset().mockResolvedValue(bagRecord());
  getCurrentBagVersionMock.mockReset().mockResolvedValue(bagVersion());
  // The recipe's own two assets are "verified" — registry validation
  // (Phase 13, untouched by this phase) passes and the preview proceeds.
  getVerifiedIdentityKeysMock.mockReset().mockResolvedValue(new Set(['ethereum:' + NVDA_ADDRESS, 'ethereum:' + AAPL_ADDRESS]));
  listAssetsMock.mockReset().mockResolvedValue([USDC]);
  getBagNavMock.mockReset().mockResolvedValue(nav());
  getShareSupplyMock.mockReset().mockResolvedValue(shareSupply());
  quoteExecutionPlanMock.mockReset().mockResolvedValue(mockExecutionResult());
  checkRateLimitMock.mockReset().mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
  navSafeOverride.value = null;
  priceHoldingsIndividuallyMock.mockReset().mockResolvedValue({ prices: new Map(), failures: [] });
  priceMock.mockReset().mockImplementation(async (asset: { chain: string; address: string }) => ({
    asset,
    price: '3000',
    quoteCurrency: 'USD',
    timestamp: new Date().toISOString(),
    source: 'test',
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('POST /api/bags/:id/purchase-preview', () => {
  // Production-hardening P1-10 — this route is unauthenticated by design
  // and fans out to a real LI.FI quote per leg, so it's IP-rate-limited
  // rather than per-user.
  it('is rate limited per IP — 429, no repository/LI.FI call ever happens', async () => {
    checkRateLimitMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 14 });

    const res = await POST(postRequest({ inputAssetId: USDC.id, amount: '100' }), { params: Promise.resolve({ id: 'bag_1' }) });
    const body = await res.json();

    expect(res.status).toBe(429);
    expect(body.retryAfterSeconds).toBe(14);
    expect(getBagByIdMock).not.toHaveBeenCalled();
    expect(quoteExecutionPlanMock).not.toHaveBeenCalled();
    expect(checkRateLimitMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringMatching(/^purchase-preview:ip:/),
      expect.objectContaining({ maxRequests: expect.any(Number) })
    );
  });

  it('backward compatible: without ?quotes=true, response has no quotes field and LI.FI is never called', async () => {
    const res = await POST(postRequest({ inputAssetId: USDC.id, amount: '100' }), { params: Promise.resolve({ id: 'bag_1' }) });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(quoteExecutionPlanMock).not.toHaveBeenCalled();
    expect(json.preview.quotes).toBeNull();
    expect(json.preview.quotesError).toBeNull();
    // Every field an existing (pre-Phase-14) caller relied on is still present.
    expect(json.preview.ok).toBe(true);
    expect(json.preview.executionPlan).toBeDefined();
  });

  it('quotes=true: calls liFiExecutionAdapter.quoteExecutionPlan with the computed executionPlan and attaches the result', async () => {
    const res = await POST(postRequest({ inputAssetId: USDC.id, amount: '100' }, '?quotes=true'), {
      params: Promise.resolve({ id: 'bag_1' }),
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(quoteExecutionPlanMock).toHaveBeenCalledTimes(1);
    const passedPlan = quoteExecutionPlanMock.mock.calls[0][0];
    expect(passedPlan.bagId).toBe('bag_1');
    expect(json.preview.quotes).toEqual(mockExecutionResult());
    expect(json.preview.quotesError).toBeNull();
  });

  it('quotes=true degrades gracefully: a rejected quote call never turns a valid preview into a 500', async () => {
    quoteExecutionPlanMock.mockRejectedValueOnce(new Error('LI.FI is unreachable'));

    const res = await POST(postRequest({ inputAssetId: USDC.id, amount: '100' }, '?quotes=true'), {
      params: Promise.resolve({ id: 'bag_1' }),
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.preview.ok).toBe(true);
    expect(json.preview.quotes).toBeNull();
    expect(json.preview.quotesError).toBe('LI.FI is unreachable');
  });

  it('no transaction/signing/approval: the route never imports or calls anything beyond quoteExecutionPlan on the adapter', async () => {
    await POST(postRequest({ inputAssetId: USDC.id, amount: '100' }, '?quotes=true'), { params: Promise.resolve({ id: 'bag_1' }) });

    // The mocked adapter only exposes quoteExecutionPlan (see the vi.mock
    // factory above) — there is no execute/sign/send method for this route
    // to call even if it wanted to, and it never calls anything beyond it.
    expect(quoteExecutionPlanMock).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/bags/:id/purchase-preview — market price unavailable (e.g. Stock Tokens on a weekend)', () => {
  it('still returns the allocation preview (200) and names each holding that has no usable price, and why', async () => {
    navSafeOverride.value = { ok: false, reason: 'PRICE_UNAVAILABLE', message: 'x', asset: { chain: 'ethereum', address: NVDA_ADDRESS }, cause: 'SPREAD_TOO_WIDE' };
    listAssetsMock.mockResolvedValue([USDC, { ...USDC, id: 'asset_nvda', address: NVDA_ADDRESS, symbol: 'NVDA', decimals: 18, assetType: 'stock' }]);
    priceHoldingsIndividuallyMock.mockResolvedValue({ prices: new Map(), failures: [{ asset: { chain: 'ethereum', address: NVDA_ADDRESS }, cause: 'MARKET_CLOSED_OR_HALTED' }] });

    const res = await POST(postRequest({ inputAssetId: 'asset_usdc', amount: '100' }), { params: Promise.resolve({ id: 'bag_1' }) });
    expect(res.status).toBe(200);
    const { preview } = await res.json();
    expect(preview.depositQuote).toBeNull();
    expect(preview.shareValuation).toBe('EXECUTION_QUOTE');
    expect(preview.depositPlan.allocations).toHaveLength(2);
    expect(preview.executionPlan.steps.length).toBeGreaterThan(0);
    expect(preview.valuation).toEqual({ available: false, unavailable: [{ chain: 'ethereum', address: NVDA_ADDRESS, symbol: 'NVDA', cause: 'MARKET_CLOSED_OR_HALTED' }] });
  });

  it('with prices available, the response is unchanged (oracle shares, valuation available)', async () => {
    const res = await POST(postRequest({ inputAssetId: 'asset_usdc', amount: '100' }), { params: Promise.resolve({ id: 'bag_1' }) });
    const { preview } = await res.json();
    expect(preview.shareValuation).toBe('ORACLE_NAV');
    expect(preview.depositQuote).not.toBeNull();
    expect(preview.valuation).toEqual({ available: true });
    expect(priceHoldingsIndividuallyMock).not.toHaveBeenCalled();
  });
});

describe('purchase-preview — native ETH', () => {
  const params = { params: Promise.resolve({ id: 'bag_1' }) };

  it('GET offers the stablecoin first, then native ETH', async () => {
    const res = await GET(new NextRequest('http://localhost/api/bags/bag_1/purchase-preview'), params);
    const body = await res.json();
    expect(body.inputAssets.map((a: { symbol: string }) => a.symbol)).toEqual(['USDC', 'ETH']);
    expect(body.inputAssets[1]).toMatchObject({ id: 'native:ethereum', address: '0x0000000000000000000000000000000000000000', decimals: 18 });
  });

  it('POST values 0.05 ETH at the WETH price: shares from $150, allocations in wei', async () => {
    const res = await POST(postRequest({ inputAssetId: 'native:ethereum', amount: '0.05' }), params);
    expect(res.status).toBe(200);
    const { preview } = await res.json();
    expect(preview.quoteAmount).toBe('150.000000000000000000');
    expect(preview.inputUsdPrice).toBe('3000');
    expect(preview.inputAmountRaw).toBe('50000000000000000');
    // NAV $1000 / 100 shares = $10 a share → 15 shares.
    expect(preview.depositQuote.sharesRaw).toBe('15000000000000000000');
    expect(priceMock).toHaveBeenCalledWith({ chain: 'ethereum', address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' });
  });

  it('POST with a stablecoin never asks for a price', async () => {
    const res = await POST(postRequest({ inputAssetId: 'asset_usdc', amount: '100' }), params);
    const { preview } = await res.json();
    expect(preview.quoteAmount).toBe('100');
    expect(priceMock).not.toHaveBeenCalled();
  });

  it('POST: no ETH price → 503, never an estimate', async () => {
    priceMock.mockRejectedValue(new Error('down'));
    const res = await POST(postRequest({ inputAssetId: 'native:ethereum', amount: '0.05' }), params);
    expect(res.status).toBe(503);
  });
});
