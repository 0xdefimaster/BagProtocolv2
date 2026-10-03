import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { DEFAULT_REBALANCE_RULE } from '@/types/basket-protocol';

// GET /api/bags/:id — the per-asset holdings the Breakdown shows come from the
// SAME NAV call as the TVL, so they always add up to it; when prices are
// unavailable the quantities are still listed with null price/value.

const getBagByIdMock = vi.fn();
const getCurrentBagVersionMock = vi.fn();
const getBagNavSafeMock = vi.fn();
const getBagHoldingsMock = vi.fn();

vi.mock('@/lib/supabase/server', () => ({ isSupabaseConfigured: () => true, supabaseAdmin: () => ({}) }));
vi.mock('@/lib/auth/require-session', () => ({ requireSession: async () => ({ ok: false }) }));
vi.mock('@/lib/server/bag-repo', () => ({
  getBagById: (...a: unknown[]) => getBagByIdMock(...a),
  getCurrentBagVersion: (...a: unknown[]) => getCurrentBagVersionMock(...a),
  updateBagMetadata: vi.fn(),
}));
vi.mock('@/lib/server/bag-asset-context', () => ({ loadRecipeAssets: async () => new Map() }));
vi.mock('@/lib/server/user-profile-repo', () => ({ loadCreatorProfiles: async () => new Map() }));
vi.mock('@/lib/server/bag-nav', () => ({ getBagNavSafe: (...a: unknown[]) => getBagNavSafeMock(...a) }));
vi.mock('@/lib/server/bag-holdings-repo', () => ({ getBagHoldings: (...a: unknown[]) => getBagHoldingsMock(...a) }));
vi.mock('@/lib/server/price-provider', () => ({ getPriceProvider: () => ({}), getDisplayPriceProvider: () => ({}) }));
const recordNavSnapshotMock = vi.fn();
const getNavSnapshotsMock = vi.fn();
vi.mock('@/lib/server/bag-nav-snapshots', async (orig) => ({
  computeBagPerformance: (await orig<typeof import('@/lib/server/bag-nav-snapshots')>()).computeBagPerformance,
  recordNavSnapshot: (...a: unknown[]) => recordNavSnapshotMock(...a),
  getNavSnapshots: (...a: unknown[]) => getNavSnapshotsMock(...a),
}));

const { GET } = await import('@/app/api/bags/[id]/route');

const INDA = { chain: 'robinhood', address: '0xInda' };
const PONS = { chain: 'robinhood', address: '0xPons' };

beforeEach(() => {
  vi.clearAllMocks();
  recordNavSnapshotMock.mockResolvedValue('recorded');
  getNavSnapshotsMock.mockResolvedValue([]);
  getBagByIdMock.mockResolvedValue({
    id: 'bag_1', name: 'asdasda', slug: 'asdasda', symbol: 'ASD', description: 'd', creatorId: 'u1', status: 'ACTIVE', chain: 'robinhood',
    strategyType: 'STATIC_BASKET', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  });
  getCurrentBagVersionMock.mockResolvedValue({
    id: 'v1', bagId: 'bag_1', version: 1, compositionHash: 'h', createdAt: '2026-01-01T00:00:00.000Z',
    recipe: { assets: [{ ...INDA, symbol: 'INDA', decimals: 18, weightBps: 6000 }, { ...PONS, symbol: 'PONS', decimals: 18, weightBps: 4000 }], rebalanceRule: DEFAULT_REBALANCE_RULE, strategyType: 'STATIC_BASKET' },
  });
});

async function get() {
  const res = await GET(new NextRequest('http://localhost/api/bags/bag_1'), { params: Promise.resolve({ id: 'bag_1' }) });
  return (await res.json()).bag;
}

describe('GET /api/bags/:id — holdings breakdown', () => {
  it('lists each held asset with quantity, per-token price and value from the same NAV as the TVL', async () => {
    getBagNavSafeMock.mockResolvedValue({
      ok: true,
      nav: {
        asOf: '2026-01-01T00:00:00.000Z',
        quoteCurrency: 'USD',
        grossNav: '1.36',
        netNav: '1.36',
        components: [
          { asset: INDA, quantityRaw: '10700000000000000', decimals: 18, price: { price: '46.68' }, value: '0.50' },
          { asset: PONS, quantityRaw: '660000000000000000', decimals: 18, price: { price: '1.30' }, value: '0.86' },
        ],
      },
    });
    const bag = await get();
    expect(bag.tvl).toBe(1.36);
    expect(bag.holdings).toEqual([
      { symbol: 'INDA', chain: 'robinhood', address: '0xInda', quantityRaw: '10700000000000000', decimals: 18, price: '46.68', value: '0.50', quoteCurrency: 'USD' },
      { symbol: 'PONS', chain: 'robinhood', address: '0xPons', quantityRaw: '660000000000000000', decimals: 18, price: '1.30', value: '0.86', quoteCurrency: 'USD' },
    ]);
    const sum = bag.holdings.reduce((t: number, h: { value: string }) => t + Number(h.value), 0);
    expect(sum).toBeCloseTo(bag.tvl, 10);
  });

  it('still lists quantities (price/value null, TVL 0) when prices are unavailable', async () => {
    getBagNavSafeMock.mockResolvedValue({ ok: false, reason: 'PRICE_UNAVAILABLE', message: 'no price' });
    getBagHoldingsMock.mockResolvedValue([{ bagId: 'bag_1', asset: INDA, quantityRaw: '5', decimals: 18, updatedAt: 'x' }]);
    const bag = await get();
    expect(bag.tvl).toBe(0);
    expect(bag.holdings).toEqual([{ symbol: 'INDA', chain: 'robinhood', address: '0xInda', quantityRaw: '5', decimals: 18, price: null, value: null, quoteCurrency: 'USD' }]);
  });

  it('records a snapshot from the NAV it just priced and returns recorded performance', async () => {
    const nav = { asOf: '2026-01-01T00:00:00.000Z', quoteCurrency: 'USD', grossNav: '2.00', netNav: '2.00', components: [] };
    getBagNavSafeMock.mockResolvedValue({ ok: true, nav });
    getNavSnapshotsMock.mockResolvedValue([
      { capturedAt: '2026-01-01T00:00:00.000Z', grossNav: '2', navPerShare: '1.00' },
      { capturedAt: new Date().toISOString(), grossNav: '2.2', navPerShare: '1.10' },
    ]);
    const bag = await get();
    expect(recordNavSnapshotMock).toHaveBeenCalledWith(expect.anything(), 'bag_1', { nav });
    expect(bag.performanceRecorded.sinceFirst).toBeCloseTo(10, 6);
    expect(bag.performanceRecorded.snapshots).toBe(2);
  });

  it('a snapshot failure never fails the page — performance is simply absent', async () => {
    getBagNavSafeMock.mockResolvedValue({ ok: true, nav: { asOf: '', quoteCurrency: 'USD', grossNav: '1', netNav: '1', components: [] } });
    recordNavSnapshotMock.mockRejectedValue(new Error('relation "bag_nav_snapshots" does not exist'));
    const bag = await get();
    expect(bag.tvl).toBe(1);
    expect(bag.performanceRecorded).toBeUndefined();
  });
});
