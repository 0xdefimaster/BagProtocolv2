import { describe, expect, it } from 'vitest';
import { InvalidRedeemFractionError, calculateRedeemAllocation, sharesToBurnForFraction } from '../allocation';
import { ZeroRedeemAmountError } from '../../shares/shares';

const OUT = { chain: 'robinhood' as const, address: '0x00000000000000000000000000000000000000c0' };
const h = (address: string, quantityRaw: string, sellableRaw = quantityRaw) => ({ chain: 'robinhood' as const, address, decimals: 18, quantityRaw, sellableRaw });
const alloc = (fractionBps: number, holdings: ReturnType<typeof h>[]) =>
  calculateRedeemAllocation({ bagId: 'b', fractionBps, outputAsset: OUT, outputDecimals: 6, holdings }).map((a) => [a.sourceAsset.address, a.sellQuantityRaw]);

describe('calculateRedeemAllocation (A4: fraction of effective holdings)', () => {
  it('full exit sells everything sellable', () => {
    expect(alloc(10_000, [h('0xa', '100'), h('0xb', '7')])).toEqual([['0xa', '100'], ['0xb', '7']]);
  });

  it('partial exit sells the fraction, floored — never more', () => {
    expect(alloc(5000, [h('0xa', '101')])).toEqual([['0xa', '50']]);
    expect(alloc(3333, [h('0xa', '30')])).toEqual([['0xa', '9']]);
  });

  it('drift: tracked 100, wallet 60 — a full exit sells 60, half sells 30', () => {
    expect(alloc(10_000, [h('0xa', '100', '60')])).toEqual([['0xa', '60']]);
    expect(alloc(5000, [h('0xa', '100', '60')])).toEqual([['0xa', '30']]);
  });

  it('never above what BAG tracks, even if the caller passes more sellable', () => {
    expect(alloc(10_000, [h('0xa', '100', '150')])).toEqual([['0xa', '100']]);
  });

  it('skips holdings whose share floors to 0, and refuses when nothing at all would be sold', () => {
    expect(alloc(5000, [h('0xa', '1'), h('0xb', '10')])).toEqual([['0xb', '5']]);
    expect(() => alloc(10_000, [h('0xa', '100', '0')])).toThrow(ZeroRedeemAmountError);
    expect(() => alloc(1, [h('0xa', '1')])).toThrow(ZeroRedeemAmountError);
  });

  it('rejects fractions outside 1..10000 and non-integers', () => {
    for (const bad of [0, -1, 10_001, 12.5, Number.NaN]) {
      expect(() => alloc(bad, [h('0xa', '100')])).toThrow(InvalidRedeemFractionError);
    }
  });

  it('is deterministic: the same inputs allocate the same legs', () => {
    const holdings = [h('0xa', '12345', '9999'), h('0xb', '777')];
    expect(alloc(4321, holdings)).toEqual(alloc(4321, holdings));
  });
});

describe('sharesToBurnForFraction (legacy bookkeeping only)', () => {
  it('same proportion; all on a full exit; at least 1 while any are held; 0 when none', () => {
    expect(sharesToBurnForFraction('100', 5000)).toBe('50');
    expect(sharesToBurnForFraction('101', 10_000)).toBe('101');
    expect(sharesToBurnForFraction('3', 1)).toBe('1');
    expect(sharesToBurnForFraction('0', 10_000)).toBe('0');
  });
});
