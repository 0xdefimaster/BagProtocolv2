import { describe, expect, it } from 'vitest';
import { normalizeToTotal, setWeightKeepingTotal } from '../weight-input';

const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);

describe('setWeightKeepingTotal (weight sliders)', () => {
  it('moves the others in proportion and keeps exactly 100%', () => {
    // 50/30/20 → first to 70: the 3000 left splits 30:20 → 18/12.
    expect(setWeightKeepingTotal([5000, 3000, 2000], 0, 7000)).toEqual([7000, 1800, 1200]);
  });

  it('gives the rest equally when the others are all zero', () => {
    expect(setWeightKeepingTotal([10_000, 0, 0], 0, 4000)).toEqual([4000, 3000, 3000]);
  });

  it('clamps to 0..100% and handles one asset', () => {
    expect(setWeightKeepingTotal([5000, 5000], 0, 12_000)).toEqual([10_000, 0]);
    expect(setWeightKeepingTotal([5000, 5000], 1, -5)).toEqual([10_000, 0]);
    expect(setWeightKeepingTotal([4000], 0, 2000)).toEqual([10_000]);
  });

  it('always sums to 10000 for awkward splits', () => {
    for (let v = 0; v <= 10_000; v += 137) {
      const out = setWeightKeepingTotal([3333, 3333, 3334, 1], 2, v);
      expect(sum(out)).toBe(10_000);
      expect(out[2]).toBe(v);
      expect(out.every((x) => Number.isInteger(x) && x >= 0)).toBe(true);
    }
  });
});

describe('normalizeToTotal (after removing an asset)', () => {
  it('scales the rest back to 100%', () => {
    expect(normalizeToTotal([3000, 2000])).toEqual([6000, 4000]);
    expect(sum(normalizeToTotal([3333, 3333, 1]))).toBe(10_000);
    expect(normalizeToTotal([0, 0])).toEqual([5000, 5000]);
  });
});
