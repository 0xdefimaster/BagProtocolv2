import { beforeEach, describe, expect, it, vi } from 'vitest';

// A4: the preview sells a FRACTION of what the wallet effectively holds, and reports the position value of that
// slice separately from (never as) the sale's proceeds.

const listAssets = vi.fn();
const observeMock = vi.fn();
const sellableMock = vi.fn();
const valueMock = vi.fn();
vi.mock('@/lib/supabase/server', () => ({ isSupabaseConfigured: () => true, supabaseAdmin: () => ({}) }));
vi.mock('@/lib/auth/require-session', () => ({ requireSession: async () => ({ ok: true, session: { userId: 'u1', walletAddress: '0xw' } }) }));
vi.mock('@/lib/server/rate-limit', () => ({ checkRateLimit: async () => ({ allowed: true }), rateLimitedResponseBody: () => ({}) }));
vi.mock('@/lib/server/price-provider', () => ({
  getPriceProvider: () => ({}),
  getDisplayPriceProvider: () => ({ getPrice: async (a: { address: string }) => ({ price: a.address.toLowerCase() === '0xmsft' ? '400' : '1' }) }),
}));
vi.mock('@/lib/blockchain/rpc/clients', () => ({ getChainPublicClient: () => ({}) }));
vi.mock('@/lib/server/bag-repo', () => ({ getBagById: async () => ({ id: 'b1', chain: 'robinhood', name: 'AI', symbol: 'AI' }) }));
vi.mock('@/lib/server/asset-repo', () => ({ listAssets: (...a: unknown[]) => listAssets(...a) }));
vi.mock('@/lib/server/payment-assets', () => ({ paymentAssetsFor: (assets: { symbol: string }[]) => assets.filter((a) => a.symbol === 'USDG') }));
vi.mock('@/lib/server/position-valuation', async (orig) => ({
  ...(await orig<object>()),
  observeUserHoldings: (...a: unknown[]) => observeMock(...a),
  sellableHoldingsForBag: (...a: unknown[]) => sellableMock(...a),
  valueUserPositions: (...a: unknown[]) => valueMock(...a),
}));

import { GET, POST } from '@/app/api/bags/[id]/redeem-preview/route';

const post = (body: unknown) =>
  POST(new Request('http://x', { method: 'POST', body: JSON.stringify(body) }) as never, { params: Promise.resolve({ id: 'b1' }) });

beforeEach(() => {
  vi.clearAllMocks();
  listAssets.mockResolvedValue([
    { id: 'usdg', chain: 'robinhood', address: '0xUSDG', symbol: 'USDG', decimals: 6, name: 'Global Dollar', status: 'VERIFIED' },
    { id: 'msft', chain: 'robinhood', address: '0xmsft', symbol: 'MSFT', decimals: 6, name: 'Microsoft', status: 'VERIFIED' },
  ]);
  observeMock.mockResolvedValue({ rows: [{ bagId: 'b1' }] });
  // Tracked 100 MSFT, wallet effectively 60 (drift); 5 USDG in sync.
  sellableMock.mockReturnValue([
    { chain: 'robinhood', address: '0xMSFT', decimals: 6, quantityRaw: '100000000', sellableRaw: '60000000' },
    { chain: 'robinhood', address: '0xusdg', decimals: 6, quantityRaw: '5000000', sellableRaw: '5000000' },
  ]);
});

describe('POST /api/bags/:id/redeem-preview', () => {
  it('a full exit sells only what the wallet holds (60 of tracked 100), names every asset, values the slice', async () => {
    const res = await post({ fractionBps: 10_000, outputAssetId: 'usdg' });
    expect(res.status).toBe(200);
    const { preview } = await res.json();
    expect(preview.allocation.map((a: { symbol: string; sellQuantityRaw: string }) => [a.symbol, a.sellQuantityRaw])).toEqual([
      ['MSFT', '60000000'],
      ['USDG', '5000000'],
    ]);
    expect(preview.allocation[1].isOutputAsset).toBe(true);
    expect(preview.sliceValueQuote).toBe('24005');
    expect(preview).not.toHaveProperty('redeemQuote');
  });

  it('a partial exit sells that fraction of each sellable holding', async () => {
    const { preview } = await (await post({ fractionBps: 2500, outputAssetId: 'usdg' })).json();
    expect(preview.allocation.map((a: { sellQuantityRaw: string }) => a.sellQuantityRaw)).toEqual(['15000000', '1250000']);
  });

  it('unreadable wallet balances refuse to quote (503), never assume the tokens are there', async () => {
    sellableMock.mockReturnValue(null);
    expect((await post({ fractionBps: 10_000, outputAssetId: 'usdg' })).status).toBe(503);
  });

  it('rejects a fraction outside 1..10000 and the old share-count body', async () => {
    expect((await post({ fractionBps: 0, outputAssetId: 'usdg' })).status).toBe(422);
    expect((await post({ fractionBps: 10_001, outputAssetId: 'usdg' })).status).toBe(422);
    expect((await post({ sharesToRedeemRaw: '10', outputAssetId: 'usdg' })).status).toBe(400);
  });

  it('only a VERIFIED payment asset can be the output', async () => {
    listAssets.mockResolvedValue([{ id: 'usdg', chain: 'robinhood', address: '0xUSDG', symbol: 'USDG', decimals: 6, name: 'G', status: 'PENDING' }]);
    expect((await post({ fractionBps: 10_000, outputAssetId: 'usdg' })).status).toBe(400);
  });
});

describe('GET /api/bags/:id/redeem-preview', () => {
  it('returns the holdings-based position value, no share fields', async () => {
    valueMock.mockResolvedValue(
      new Map([['b1', { bagId: 'b1', blockNumber: '9', assets: [], strategyExposureQuote: '10000', observedWalletQuote: '8700', effectivePositionQuote: '8700', hasDrift: true, hasUnreadable: false }]])
    );
    const body = await (await GET(new Request('http://x') as never, { params: Promise.resolve({ id: 'b1' }) })).json();
    expect(body.position).toMatchObject({ strategyExposureQuote: '10000', observedWalletQuote: '8700', effectivePositionQuote: '8700', hasDrift: true });
    expect(body.position).not.toHaveProperty('sharesRaw');
  });
});
