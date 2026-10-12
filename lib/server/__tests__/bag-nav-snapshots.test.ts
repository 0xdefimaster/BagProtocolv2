import { beforeEach, describe, expect, it, vi } from 'vitest';

const getShareSupplyMock = vi.fn();
const getBagNavSafeMock = vi.fn();
vi.mock('@/lib/server/bag-share-state-repo', () => ({ getShareSupply: (...a: unknown[]) => getShareSupplyMock(...a) }));
vi.mock('@/lib/server/bag-nav', () => ({ getBagNavSafe: (...a: unknown[]) => getBagNavSafeMock(...a) }));
vi.mock('@/lib/server/price-provider', () => ({ getPriceProvider: () => ({}), getDisplayPriceProvider: () => ({}) }));

const { computeBagPerformance, recordNavSnapshot, SNAPSHOT_MIN_INTERVAL_MS } = await import('../bag-nav-snapshots');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 1, 12, 0, 0);
const at = (msAgo: number, priceIndex: string | null) => ({ capturedAt: new Date(NOW - msAgo).toISOString(), grossNav: '0', navPerShare: null, priceIndex });
const NVDA = '0x' + '1'.repeat(40);

/**
 * Minimal Supabase stand-in. Reads: the interval check resolves to `lastRows`, the latest-indexed read (it calls
 * `.not()`) to `indexedRows`. `insert()` records the row; `failFirstInsert` makes the first insert fail like a
 * database without migration 0055.
 */
function fakeAdmin(opts: { lastRows?: { captured_at: string }[]; indexedRows?: unknown[]; failFirstInsert?: boolean } = {}) {
  const inserted: Record<string, unknown>[] = [];
  let inserts = 0;
  const query = (rows: unknown[]) => {
    const q: Record<string, unknown> = {};
    q.eq = () => q;
    q.order = () => q;
    q.not = () => query(opts.indexedRows ?? []);
    q.limit = async () => ({ data: rows, error: null });
    return q;
  };
  const admin = {
    from: () => ({
      select: () => query(opts.lastRows ?? []),
      insert: async (row: Record<string, unknown>) => {
        inserts++;
        if (opts.failFirstInsert && inserts === 1) return { error: { message: 'column "price_index" does not exist' } };
        inserted.push(row);
        return { error: null };
      },
    }),
  };
  return { admin: admin as never, inserted };
}

const ASSET = { chain: 'robinhood' as const, address: NVDA };
const component = (price: string) => ({
  asset: ASSET,
  quantityRaw: '2000000000000000000',
  decimals: 18,
  price: { asset: ASSET, price, quoteCurrency: 'USD', timestamp: '', source: 't' },
  value: '0',
});
const navAt = (price: string) => ({ asOf: new Date(NOW).toISOString(), quoteCurrency: 'USD', grossNav: '2.5', netNav: '2.5', components: [component(price)] });
const NAV = navAt('1.25');
const OLD = new Date(NOW - SNAPSHOT_MIN_INTERVAL_MS - 1).toISOString();

beforeEach(() => {
  vi.clearAllMocks();
  getShareSupplyMock.mockResolvedValue({ bagId: 'b', totalSharesRaw: '2000000000000000000', shareDecimals: 18, updatedAt: '' });
});

describe('computeBagPerformance', () => {
  it('has no figures with fewer than two indexed snapshots — nothing is estimated', () => {
    expect(computeBagPerformance([], NOW)).toMatchObject({ '7D': null, '30D': null, YTD: null, sinceFirst: null, snapshots: 0 });
    expect(computeBagPerformance([at(DAY, '100')], NOW)).toMatchObject({ '7D': null, sinceFirst: null, snapshots: 1 });
  });

  it('measures each range from the snapshot at or just before its start to the latest one', () => {
    const points = [at(40 * DAY, '100'), at(10 * DAY, '110'), at(5 * DAY, '120'), at(0, '132')];
    const perf = computeBagPerformance(points, NOW);
    expect(perf['7D']).toBeCloseTo(((132 - 110) / 110) * 100, 6); // base = 10 days ago (last one before 7D start)
    expect(perf['30D']).toBeCloseTo(32, 6); // base = 40 days ago
    expect(perf.sinceFirst).toBeCloseTo(32, 6);
    expect(perf.firstSnapshotAt).toBe(points[0].capturedAt);
  });

  it('reports null for a range the indexed history does not reach back to', () => {
    const perf = computeBagPerformance([at(2 * DAY, '100'), at(0, '95')], NOW);
    expect(perf['7D']).toBeNull();
    expect(perf['30D']).toBeNull();
    expect(perf.sinceFirst).toBeCloseTo(-5, 6);
  });

  it('ignores snapshots recorded before the price index (their NAV per share moved with investor flows)', () => {
    const perf = computeBagPerformance([at(40 * DAY, null), at(20 * DAY, null), at(2 * DAY, '100'), at(0, '101')], NOW);
    expect(perf['30D']).toBeNull();
    expect(perf.sinceFirst).toBeCloseTo(1, 6);
    expect(perf.snapshots).toBe(2);
  });
});

describe('recordNavSnapshot', () => {
  it('skips when the last snapshot is newer than the minimum interval', async () => {
    const { admin, inserted } = fakeAdmin({ lastRows: [{ captured_at: new Date(NOW - SNAPSHOT_MIN_INTERVAL_MS + 1000).toISOString() }] });
    expect(await recordNavSnapshot(admin, 'b', { now: NOW, nav: NAV })).toBe('recent');
    expect(inserted).toHaveLength(0);
  });

  it('skips when NAV cannot be priced, never storing a guess', async () => {
    getBagNavSafeMock.mockResolvedValue({ ok: false, reason: 'PRICE_UNAVAILABLE', message: 'x' });
    const { admin, inserted } = fakeAdmin();
    expect(await recordNavSnapshot(admin, 'b', { now: NOW })).toBe('no-nav');
    expect(inserted).toHaveLength(0);
  });

  it('skips a Bag that holds nothing', async () => {
    const { admin, inserted } = fakeAdmin();
    expect(await recordNavSnapshot(admin, 'b', { now: NOW, nav: { ...NAV, components: [] } })).toBe('no-holdings');
    expect(inserted).toHaveLength(0);
  });

  it("the first indexed snapshot starts at 100 and stores the holdings it was priced from", async () => {
    const { admin, inserted } = fakeAdmin({ lastRows: [{ captured_at: OLD }] });
    expect(await recordNavSnapshot(admin, 'b', { now: NOW, nav: NAV })).toBe('recorded');
    expect(getBagNavSafeMock).not.toHaveBeenCalled();
    expect(inserted[0]).toMatchObject({ bag_id: 'b', gross_nav: '2.5', price_index: '100', total_shares_raw: '2000000000000000000', share_decimals: 18 });
    expect(inserted[0].components).toEqual([{ chain: 'robinhood', address: NVDA, quantityRaw: '2000000000000000000', decimals: 18, price: '1.25' }]);
    expect(Number(inserted[0].nav_per_share)).toBeCloseTo(1.25, 12);
  });

  it('chains the index from the previous indexed snapshot', async () => {
    const previous = { price_index: '100', components: [{ chain: 'robinhood', address: NVDA, quantityRaw: '1000000000000000000', decimals: 18, price: '1.25' }] };
    const { admin, inserted } = fakeAdmin({ lastRows: [{ captured_at: OLD }], indexedRows: [previous] });
    await recordNavSnapshot(admin, 'b', { now: NOW, nav: navAt('1.5') });
    expect(inserted[0].price_index).toBe('120.000000000000000000');
  });

  it('records a Bag whose shares reached zero (holdings outlived them): index yes, NAV per share no', async () => {
    getShareSupplyMock.mockResolvedValue({ bagId: 'b', totalSharesRaw: '0', shareDecimals: 18, updatedAt: '' });
    const { admin, inserted } = fakeAdmin();
    expect(await recordNavSnapshot(admin, 'b', { now: NOW, nav: NAV })).toBe('recorded');
    expect(inserted[0]).toMatchObject({ price_index: '100', nav_per_share: null, total_shares_raw: null });
  });

  it('before migration 0055: falls back to the old row, or skips a Bag without shares', async () => {
    const legacy = fakeAdmin({ failFirstInsert: true });
    expect(await recordNavSnapshot(legacy.admin, 'b', { now: NOW, nav: NAV })).toBe('recorded');
    expect(legacy.inserted[0]).not.toHaveProperty('price_index');
    expect(legacy.inserted[0]).toMatchObject({ gross_nav: '2.5', total_shares_raw: '2000000000000000000' });

    getShareSupplyMock.mockResolvedValue({ bagId: 'b', totalSharesRaw: '0', shareDecimals: 18, updatedAt: '' });
    const noShares = fakeAdmin({ failFirstInsert: true });
    expect(await recordNavSnapshot(noShares.admin, 'b', { now: NOW, nav: NAV })).toBe('no-shares');
    expect(noShares.inserted).toHaveLength(0);
  });
});
