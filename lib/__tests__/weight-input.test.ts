import { describe, expect, it } from 'vitest';
import { bpsToPercent, equalWeightsBps, percentToBps } from '@/lib/weight-input';
import { bagDisplayName } from '@/lib/bag-display-name';

describe('weight input', () => {
  it('percent <-> basis points, exact', () => {
    expect(percentToBps('33.33')).toBe(3333);
    expect(percentToBps('50')).toBe(5000);
    expect(percentToBps('0.5')).toBe(50);
    expect(percentToBps('100')).toBe(10_000);
    for (const bad of ['', '-1', '100.01', '101', '1.234', 'abc', '1e2']) expect(percentToBps(bad)).toBeNull();
    expect(bpsToPercent(3333)).toBe('33.33');
    expect(bpsToPercent(5000)).toBe('50');
    expect(bpsToPercent(50)).toBe('0.5');
    expect(bpsToPercent(1205)).toBe('12.05');
  });

  it('equal weights always sum to exactly 100%', () => {
    for (const n of [1, 3, 6, 7]) expect(equalWeightsBps(n).reduce((a, b) => a + b, 0)).toBe(10_000);
    expect(equalWeightsBps(3)).toEqual([3334, 3333, 3333]);
  });
});

describe('bagDisplayName', () => {
  it('adds the version once the strategy was edited', () => {
    expect(bagDisplayName({ name: 'A' })).toBe('A');
    expect(bagDisplayName({ name: 'A', version: 1 })).toBe('A');
    expect(bagDisplayName({ name: 'A', version: 2 })).toBe('A v2');
  });
});
