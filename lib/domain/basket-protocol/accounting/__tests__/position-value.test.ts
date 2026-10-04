import { describe, expect, it } from 'vitest';
import { effectiveQuantityRaw, valuePosition } from '../position-value';

const E18 = BigInt(10) ** BigInt(18);
const units = (n: number) => (BigInt(n) * E18).toString();
const asset = (o: Partial<Parameters<typeof valuePosition>[0][number]> = {}) => ({
  chain: 'robinhood',
  address: '0xa',
  decimals: 18,
  trackedRaw: units(100),
  trackedAllStrategiesRaw: units(100),
  observedRaw: units(100) as string | null,
  price: '100' as string | null,
  ...o,
});

describe('effectiveQuantityRaw (D3 attribution)', () => {
  it('wallet holds at least what BAG tracks: the full tracked quantity, surplus belongs to no strategy', () => {
    expect(effectiveQuantityRaw(BigInt(100), BigInt(100), BigInt(150))).toBe(BigInt(100));
  });
  it('wallet 60 vs tracked 100: 60', () => {
    expect(effectiveQuantityRaw(BigInt(100), BigInt(100), BigInt(60))).toBe(BigInt(60));
  });
  it('two strategies 60/40 share a wallet of 80 pro rata, never summing above it', () => {
    const a = effectiveQuantityRaw(BigInt(60), BigInt(100), BigInt(80));
    const b = effectiveQuantityRaw(BigInt(40), BigInt(100), BigInt(80));
    expect([a, b]).toEqual([BigInt(48), BigInt(32)]);
    expect(effectiveQuantityRaw(BigInt(1), BigInt(3), BigInt(1)) * BigInt(3)).toBeLessThanOrEqual(BigInt(1));
  });
  it('nothing tracked: nothing effective', () => {
    expect(effectiveQuantityRaw(BigInt(0), BigInt(10), BigInt(10))).toBe(BigInt(0));
  });
});

describe('valuePosition', () => {
  it('the brief: exposure $10,000, wallet $8,700, effective $8,700 — three separate numbers', () => {
    const v = valuePosition([asset({ observedRaw: units(87) })]);
    expect(v).toMatchObject({ strategyExposureQuote: '10000', observedWalletQuote: '8700', effectivePositionQuote: '8700', hasDrift: true, hasUnreadable: false });
    expect(v.assets[0]).toMatchObject({ status: 'DRIFT', effectiveRaw: units(87), driftRaw: units(13) });
  });

  it('in sync: all three agree and no drift', () => {
    const v = valuePosition([asset()]);
    expect(v).toMatchObject({ strategyExposureQuote: '10000', observedWalletQuote: '10000', effectivePositionQuote: '10000', hasDrift: false });
  });

  it('an unreadable balance: exposure known, wallet and effective unknown (null, never 0)', () => {
    const v = valuePosition([asset({ observedRaw: null })]);
    expect(v).toMatchObject({ strategyExposureQuote: '10000', observedWalletQuote: null, effectivePositionQuote: null, hasUnreadable: true });
    expect(v.assets[0].effectiveRaw).toBeNull();
  });

  it('a missing price makes the totals unknown, quantities still known', () => {
    const v = valuePosition([asset(), asset({ address: '0xb', price: null, observedRaw: units(50) })]);
    expect(v.strategyExposureQuote).toBeNull();
    expect(v.effectivePositionQuote).toBeNull();
    expect(v.assets[1]).toMatchObject({ effectiveRaw: units(50), effectiveQuote: null });
  });

  it('exact across decimals (6-decimal token)', () => {
    const v = valuePosition([asset({ decimals: 6, trackedRaw: '1500000', trackedAllStrategiesRaw: '1500000', observedRaw: '1500000', price: '2.5' })]);
    expect(v.effectivePositionQuote).toBe('3.75');
  });

  it('zero-tracked rows are not part of the position', () => {
    expect(valuePosition([asset({ trackedRaw: '0' })]).assets).toEqual([]);
  });
});
