import { describe, expect, it } from 'vitest';
import { nextPriceIndex, PRICE_INDEX_BASE, type IndexComponent } from '../price-index';

const NVDA = '0x' + '1'.repeat(40);
const TSLA = '0x' + '2'.repeat(40);
const c = (address: string, quantityRaw: string, price: string, decimals = 18): IndexComponent => ({ chain: 'robinhood', address, quantityRaw, decimals, price });
const E18 = '000000000000000000';
const num = (s: string) => Number(s); // display comparison only

describe('nextPriceIndex', () => {
  it('starts at the base on the first indexed snapshot', () => {
    expect(nextPriceIndex(null, [c(NVDA, '1' + E18, '100')])).toBe(PRICE_INDEX_BASE);
  });

  it('moves with prices: NVDA +10% → index +10%', () => {
    const prev = { index: '100', components: [c(NVDA, '1' + E18, '100')] };
    expect(nextPriceIndex(prev, [c(NVDA, '1' + E18, '110')])).toBe('110.000000000000000000');
  });

  it('weights by the earlier holdings: 3/4 NVDA +20%, 1/4 TSLA −20% → +10%', () => {
    const prev = { index: '100', components: [c(NVDA, '3' + E18, '100'), c(TSLA, '1' + E18, '100')] };
    expect(nextPriceIndex(prev, [c(NVDA, '3' + E18, '120'), c(TSLA, '1' + E18, '80')])).toBe('110.000000000000000000');
  });

  it('a sale or an outside transfer (quantities fall, prices flat) is not a loss', () => {
    const prev = { index: '105', components: [c(NVDA, '5' + E18, '100'), c(TSLA, '5' + E18, '50')] };
    // Half of NVDA left the wallets and TSLA is gone entirely; prices unchanged.
    expect(nextPriceIndex(prev, [c(NVDA, '25' + E18.slice(1), '100')])).toBe('105.000000000000000000');
  });

  it('a purchase (quantities rise, prices flat) is not a gain', () => {
    const prev = { index: '100', components: [c(NVDA, '1' + E18, '100')] };
    expect(nextPriceIndex(prev, [c(NVDA, '9' + E18, '100'), c(TSLA, '4' + E18, '30')])).toBe('100.000000000000000000');
  });

  it('mixed decimals are put on one scale', () => {
    const prev = { index: '100', components: [c(NVDA, '1000000', '1', 6), c(TSLA, '1' + E18, '1')] };
    // NVDA (6 decimals) doubles, TSLA (18 decimals) flat: equal weights → +50%.
    expect(nextPriceIndex(prev, [c(NVDA, '1000000', '2', 6), c(TSLA, '1' + E18, '1')])).toBe('150.000000000000000000');
  });

  it('carries the index when no asset is priced in both snapshots', () => {
    expect(nextPriceIndex({ index: '97.5', components: [c(NVDA, '1' + E18, '100')] }, [c(TSLA, '1' + E18, '10')])).toBe('97.5');
    expect(nextPriceIndex({ index: '97.5', components: [] }, [c(TSLA, '1' + E18, '10')])).toBe('97.5');
  });

  it('chains: +10% then −10% is −1% overall', () => {
    const a = nextPriceIndex({ index: '100', components: [c(NVDA, '1' + E18, '100')] }, [c(NVDA, '1' + E18, '110')]);
    const b = nextPriceIndex({ index: a, components: [c(NVDA, '1' + E18, '110')] }, [c(NVDA, '1' + E18, '99')]);
    expect(num(b)).toBeCloseTo(99, 12);
  });

  it('ignores unusable rows (bad quantity, zero or invalid price)', () => {
    const prev = { index: '100', components: [c(NVDA, 'x', '100'), c(TSLA, '1' + E18, '0')] };
    expect(nextPriceIndex(prev, [c(NVDA, '1' + E18, '200'), c(TSLA, '1' + E18, '200')])).toBe('100');
  });
});
