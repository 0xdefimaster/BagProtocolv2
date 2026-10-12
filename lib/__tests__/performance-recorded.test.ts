import { describe, expect, it } from 'vitest';
import { recordedSeries } from '../performance-recorded';
import { formatUsdCompact } from '../format';

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 1, 12);
const p = (hoursAgo: number, v: string) => ({ capturedAt: new Date(NOW - hoursAgo * HOUR).toISOString(), grossNav: '0', navPerShare: null, priceIndex: v });

describe('recordedSeries', () => {
  it('starts the window from the value at its start, so the change covers the whole range', () => {
    const s = recordedSeries([p(48, '1.00'), p(30, '1.05'), p(12, '1.10'), p(0, '0.99')], '24H', NOW)!;
    expect(s.points.map((x) => x.value)).toEqual([1.05, 1.1, 0.99]);
    expect(s.changePct).toBeCloseTo(((0.99 - 1.05) / 1.05) * 100, 9);
    expect(s.changeAbs).toBeCloseTo(-0.06, 9);
    expect(s.high).toBe(1.1);
    expect(s.low).toBe(0.99);
  });

  it('ALL covers every snapshot; fewer than two points gives no series', () => {
    expect(recordedSeries([p(48, '1'), p(0, '2')], 'ALL', NOW)!.changePct).toBeCloseTo(100, 9);
    expect(recordedSeries([p(0, '1')], 'ALL', NOW)).toBeNull();
    expect(recordedSeries([p(48, '1'), p(40, '1.1')], '24H', NOW)).toBeNull();
  });

  it('snapshots recorded before the price index existed are not drawn', () => {
    const legacy = { capturedAt: new Date(NOW - 60 * HOUR).toISOString(), grossNav: '0', navPerShare: '5', priceIndex: null };
    expect(recordedSeries([legacy, p(48, '100'), p(0, '110')], 'ALL', NOW)!.points.map((x) => x.value)).toEqual([100, 110]);
  });
});

describe('formatUsdCompact', () => {
  it('shows 2 decimals below 1,000 and compact above', () => {
    expect(formatUsdCompact(2.99630519114648)).toBe('3.00');
    expect(formatUsdCompact(0)).toBe('0.00');
    expect(formatUsdCompact(12_345)).toBe('12K');
    expect(formatUsdCompact(Number.NaN)).toBe('0.00');
  });
});
