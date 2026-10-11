import { beforeEach, describe, expect, it, vi } from 'vitest';

// The 5-minute NAV pass: due Bags only, stalest first, never past its time budget.

const mocks = vi.hoisted(() => ({ record: vi.fn(), summaries: vi.fn() }));
vi.mock('@/lib/server/bag-nav-snapshots', () => ({
  recordNavSnapshot: (...a: unknown[]) => mocks.record(...a),
  getNavSummaries: (...a: unknown[]) => mocks.summaries(...a),
}));

const { snapshotActiveBags, SWEEP_MIN_INTERVAL_MS } = await import('../nav-snapshot-sweep');

const NOW = Date.parse('2026-10-11T12:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const admin = (ids: string[]) =>
  ({ from: () => ({ select: () => ({ eq: async () => ({ data: ids.map((id) => ({ id })), error: null }) }) }) }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.record.mockResolvedValue('recorded');
});

describe('snapshotActiveBags', () => {
  it('snapshots only Bags whose latest snapshot is older than the interval, never-snapshotted and stalest first', async () => {
    mocks.summaries.mockResolvedValue(
      new Map([
        ['fresh', { latestAt: ago(60_000) }],
        ['old', { latestAt: ago(30 * 60_000) }],
        ['older', { latestAt: ago(60 * 60_000) }],
      ])
    );
    const r = await snapshotActiveBags(admin(['fresh', 'old', 'new', 'older']), { concurrency: 1, now: () => NOW });
    expect(mocks.record.mock.calls.map((c) => c[1])).toEqual(['new', 'older', 'old']);
    expect(mocks.record.mock.calls[0][2]).toEqual({ minIntervalMs: SWEEP_MIN_INTERVAL_MS });
    expect(r).toEqual({ bags: 4, attempted: 3, outcomes: { recorded: 3 } });
  });

  it('starts no Bag once the time budget has passed; a failing Bag is counted, not fatal', async () => {
    mocks.summaries.mockResolvedValue(new Map());
    let t = NOW;
    mocks.record.mockImplementation(async (_a: unknown, id: string) => {
      t += 5_000;
      if (id === 'b') throw new Error('price feed down');
      return 'recorded';
    });
    const r = await snapshotActiveBags(admin(['a', 'b', 'c', 'd']), { concurrency: 1, budgetMs: 8_000, now: () => t });
    expect(r.attempted).toBe(2);
    expect(r.outcomes).toEqual({ recorded: 1, error: 1 });
  });

  it('an unreadable summary treats every Bag as due', async () => {
    mocks.summaries.mockRejectedValue(new Error('rpc missing'));
    const r = await snapshotActiveBags(admin(['a', 'b']), { now: () => NOW });
    expect(r.attempted).toBe(2);
  });
});
