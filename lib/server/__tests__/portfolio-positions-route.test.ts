import { beforeEach, describe, expect, it, vi } from 'vitest';

const listPositionsMock = vi.fn();
const getBagByIdMock = vi.fn();
const getBagNavSafeMock = vi.fn();
const getShareSupplyMock = vi.fn();

vi.mock('@/lib/supabase/server', () => ({ isSupabaseConfigured: () => true, supabaseAdmin: () => ({}) }));
vi.mock('@/lib/auth/require-session', () => ({ requireSession: async () => ({ ok: true, session: { userId: 'user_1', walletAddress: '0xabc' } }) }));
vi.mock('@/lib/server/bag-investor-position-repo', () => ({ listInvestorPositionsForUser: (...a: unknown[]) => listPositionsMock(...a) }));
vi.mock('@/lib/server/bag-repo', () => ({ getBagById: (...a: unknown[]) => getBagByIdMock(...a) }));
vi.mock('@/lib/server/bag-nav', () => ({ getBagNavSafe: (...a: unknown[]) => getBagNavSafeMock(...a) }));
vi.mock('@/lib/server/bag-share-state-repo', () => ({ getShareSupply: (...a: unknown[]) => getShareSupplyMock(...a) }));
vi.mock('@/lib/server/price-provider', () => ({ getPriceProvider: () => ({}), getDisplayPriceProvider: () => ({}) }));

const { GET } = await import('@/app/api/portfolio/positions/route');

const E18 = BigInt(10) ** BigInt(18);
const position = (bagId: string, sharesRaw: string, costBasisQuote: string) => ({
  userId: 'user_1',
  bagId,
  sharesRaw,
  shareDecimals: 18,
  costBasisQuote,
  updatedAt: '',
});

describe('GET /api/portfolio/positions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getBagByIdMock.mockImplementation(async (_a: unknown, id: string) => ({ id, name: `Bag ${id}`, symbol: id.toUpperCase(), status: 'ACTIVE' }));
    getShareSupplyMock.mockResolvedValue({ bagId: 'x', totalSharesRaw: (E18 * BigInt(10)).toString(), shareDecimals: 18, updatedAt: '' });
  });

  it('values priced positions at NAV per share, leaves unpriced ones null, and drops zero-share rows', async () => {
    listPositionsMock.mockResolvedValue([position('a', (E18 * BigInt(5)).toString(), '5'), position('b', E18.toString(), '1'), position('z', '0', '0')]);
    getBagNavSafeMock.mockImplementation(async (_a: unknown, bagId: string) =>
      bagId === 'a'
        ? { ok: true, nav: { grossNav: '12', netNav: '12', quoteCurrency: 'USD', asOf: new Date().toISOString(), components: [] } }
        : { ok: false, reason: 'PRICE_UNAVAILABLE', message: 'no price' }
    );

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.positions.map((p: { bagId: string }) => p.bagId)).toEqual(['a', 'b']);
    // 5 of 10 shares of a $12 bag = $6.
    expect(Number(body.positions[0].currentValue)).toBeCloseTo(6);
    expect(body.positions[0]).toMatchObject({ bagName: 'Bag a', costBasis: '5' });
    expect(body.positions[1].currentValue).toBeNull();
  });
});
