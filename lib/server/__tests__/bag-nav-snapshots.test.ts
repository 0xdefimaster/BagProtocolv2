import { beforeEach, describe, expect, it, vi } from 'vitest';

const getShareSupplyMock = vi.fn();
const getBagNavSafeMock = vi.fn();
vi.mock('@/lib/server/bag-share-state-repo', () => ({ getShareSupply: (...a: unknown[]) => getShareSupplyMock(...a) }));
vi.mock('@/lib/server/bag-nav', () => ({ getBagNavSafe: (...a: unknown[]) => getBagNavSafeMock(...a) }));
vi.mock('@/lib/server/price-provider', () => ({ getPriceProvider: () => ({}), getDisplayPriceProvider: () => ({}) }));

const { computeBagPerformance, recordNavSnapshot, SNAPSHOT_MIN_INTERVAL_MS } = await import('../bag-nav-snapshots');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 1, 12, 0, 0);
const at = (msAgo: number, navPerShare: string) => ({ capturedAt: new Date(NOW - msAgo).toISOString(), grossNav: '0', navPerShare });

/** Minimal Supabase stand-in: `select(...).eq().order().limit()` resolves to `lastRows`; `insert()` records the row. */
function fakeAdmin(lastRows: { captured_at: string }[] = []) {
  const inserted: Record<string, unknown>[] = [];
  const query = { eq: () => query, order: () => query, limit: async () => ({ data: lastRows, error: null }) };
  const admin = {
    from: () => ({
      select: () => query,
      insert: async (row: Record<string, unknown>) => {
        inserted.push(row);
        return { error: null };
      },
    }),
  };
  return { admin: admin as never, inserted };
}

const NAV = { asOf: new Date(NOW).toISOString(), quoteCurrency: 'USD', grossNav: '2.5', netNav: '2.5', components: [] };

beforeEach(() => {
  vi.clearAllMocks();
  getShareSupplyMock.mockResolvedValue({ bagId: 'b', totalSharesRaw: '2000000000000000000', shareDecimals: 18, updatedAt: '' });
});

describe('computeBagPerformance', () => {
  it('has no figures with fewer than two snapshots — nothing is estimated', () => {
    expect(computeBagPerformance([], NOW)).toMatchObject({ '7D': null, '30D': null, YTD: null, sinceFirst: null, snapshots: 0 });
    expect(computeBagPerformance([at(DAY, '1')], NOW)).toMatchObject({ '7D': null, sinceFirst: null, snapshots: 1 });
  });

  it('measures each range from the snapshot at or just before its start to the latest one', () => {
    const points = [at(40 * DAY, '1.00'), at(10 * DAY, '1.10'), at(5 * DAY, '1.20'), at(0, '1.32')];
    const perf = computeBagPerformance(points, NOW);
    expect(perf['7D']).toBeCloseTo(((1.32 - 1.1) / 1.1) * 100, 6); // base = 10 days ago (last one before 7D start)
    expect(perf['30D']).toBeCloseTo(32, 6); // base = 40 days ago
    expect(perf.sinceFirst).toBeCloseTo(32, 6);
    expect(perf.firstSnapshotAt).toBe(points[0].capturedAt);
  });

  it('reports null for a range the recorded history does not reach back to', () => {
    const perf = computeBagPerformance([at(2 * DAY, '1.00'), at(0, '0.95')], NOW);
    expect(perf['7D']).toBeNull();
    expect(perf['30D']).toBeNull();
    expect(perf.sinceFirst).toBeCloseTo(-5, 6);
  });
});

describe('recordNavSnapshot', () => {
  it('skips when the last snapshot is newer than the minimum interval', async () => {
    const { admin, inserted } = fakeAdmin([{ captured_at: new Date(NOW - SNAPSHOT_MIN_INTERVAL_MS + 1000).toISOString() }]);
    expect(await recordNavSnapshot(admin, 'b', { now: NOW, nav: NAV })).toBe('recent');
    expect(inserted).toHaveLength(0);
  });

  it('skips a Bag with no shares (no NAV per share exists)', async () => {
    getShareSupplyMock.mockResolvedValue({ bagId: 'b', totalSharesRaw: '0', shareDecimals: 18, updatedAt: '' });
    const { admin, inserted } = fakeAdmin();
    expect(await recordNavSnapshot(admin, 'b', { now: NOW, nav: NAV })).toBe('no-shares');
    expect(inserted).toHaveLength(0);
  });

  it('skips when NAV cannot be priced, never storing a guess', async () => {
    getBagNavSafeMock.mockResolvedValue({ ok: false, reason: 'PRICE_UNAVAILABLE', message: 'x' });
    const { admin, inserted } = fakeAdmin();
    expect(await recordNavSnapshot(admin, 'b', { now: NOW })).toBe('no-nav');
    expect(inserted).toHaveLength(0);
  });

  it('records NAV and NAV per share from an already-priced NAV without pricing again', async () => {
    const { admin, inserted } = fakeAdmin([{ captured_at: new Date(NOW - SNAPSHOT_MIN_INTERVAL_MS - 1).toISOString() }]);
    expect(await recordNavSnapshot(admin, 'b', { now: NOW, nav: NAV })).toBe('recorded');
    expect(getBagNavSafeMock).not.toHaveBeenCalled();
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ bag_id: 'b', gross_nav: '2.5', total_shares_raw: '2000000000000000000', share_decimals: 18 });
    expect(Number(inserted[0].nav_per_share)).toBeCloseTo(1.25, 12);
  });
});
