import { beforeEach, describe, expect, it, vi } from 'vitest';

const listAssets = vi.fn();
vi.mock('@/lib/supabase/server', () => ({ isSupabaseConfigured: () => true, supabaseAdmin: () => ({}) }));
vi.mock('@/lib/auth/require-session', () => ({ requireSession: async () => ({ ok: true, session: { userId: 'u1', walletAddress: '0xw' } }) }));
vi.mock('@/lib/server/rate-limit', () => ({ checkRateLimit: async () => ({ allowed: true }), rateLimitedResponseBody: () => ({}) }));
vi.mock('@/lib/server/price-provider', () => ({ getPriceProvider: () => ({}) }));
vi.mock('@/lib/server/bag-repo', () => ({ getBagById: async () => ({ id: 'b1', chain: 'robinhood', name: 'AI', symbol: 'AI' }) }));
vi.mock('@/lib/server/bag-nav', () => ({ getBagNavSafe: async () => ({ ok: true, nav: {} }) }));
vi.mock('@/lib/server/bag-share-state-repo', () => ({ getShareSupply: async () => ({}) }));
vi.mock('@/lib/server/bag-investor-position-repo', () => ({ getInvestorPosition: async () => ({ sharesRaw: '10' }) }));
vi.mock('@/lib/server/bag-investor-holdings-repo', () => ({ getInvestorHoldings: async () => [] }));
vi.mock('@/lib/server/asset-repo', () => ({ listAssets: (...a: unknown[]) => listAssets(...a) }));
vi.mock('@/lib/server/payment-assets', () => ({ paymentAssetsFor: (assets: { symbol: string }[]) => assets.filter((a) => a.symbol === 'USDG') }));
vi.mock('@/lib/domain/basket-protocol/shares/shares', async (orig) => ({
  ...(await orig<object>()),
  getRedeemQuote: () => ({ sharesRaw: '10', shareDecimals: 18, sharePrice: '0.99', grossValue: '9.94' }),
}));
vi.mock('@/lib/domain/basket-protocol/redeem/allocation', async (orig) => ({
  ...(await orig<object>()),
  calculateRedeemAllocation: () => [
    { sourceAsset: { chain: 'robinhood', address: '0xMSFT' }, sellQuantityRaw: '4230', sourceDecimals: 6 },
    { sourceAsset: { chain: 'robinhood', address: '0xusdg' }, sellQuantityRaw: '1', sourceDecimals: 6 },
  ],
}));

import { POST } from '@/app/api/bags/[id]/redeem-preview/route';

beforeEach(() => {
  listAssets.mockReset();
  listAssets.mockResolvedValue([
    { id: 'usdg', chain: 'robinhood', address: '0xUSDG', symbol: 'USDG', decimals: 6, name: 'Global Dollar', status: 'VERIFIED' },
    { id: 'msft', chain: 'robinhood', address: '0xmsft', symbol: 'MSFT', decimals: 6, name: 'Microsoft', status: 'VERIFIED' },
  ]);
});

describe('POST /api/bags/:id/redeem-preview', () => {
  it('names every asset being sold, not only payment assets', async () => {
    const req = new Request('http://x', { method: 'POST', body: JSON.stringify({ sharesToRedeemRaw: '10', outputAssetId: 'usdg' }) });
    const res = await POST(req as never, { params: Promise.resolve({ id: 'b1' }) });
    expect(res.status).toBe(200);
    const { preview } = await res.json();
    expect(preview.allocation.map((a: { symbol: string }) => a.symbol)).toEqual(['MSFT', 'USDG']);
    expect(preview.allocation[1].isOutputAsset).toBe(true);
  });

  it('only a VERIFIED payment asset can be the output', async () => {
    listAssets.mockResolvedValue([{ id: 'usdg', chain: 'robinhood', address: '0xUSDG', symbol: 'USDG', decimals: 6, name: 'G', status: 'PENDING' }]);
    const req = new Request('http://x', { method: 'POST', body: JSON.stringify({ sharesToRedeemRaw: '10', outputAssetId: 'usdg' }) });
    expect((await POST(req as never, { params: Promise.resolve({ id: 'b1' }) })).status).toBe(400);
  });
});
