import { describe, expect, it } from 'vitest';
import { MockPriceProvider } from '../mock-provider';
import { isValidDecimalString, toDisplayPrice, toProtocolPrice } from '../price-precision';
import { DEFAULT_MAX_PRICE_AGE_MS, isPriceStale, priceAgeMs } from '../staleness';

const BTC = { chain: 'ethereum' as const, address: '0x1111111111111111111111111111111111111a' };
const ETH = { chain: 'ethereum' as const, address: '0x2222222222222222222222222222222222222b' };

describe('MockPriceProvider — deterministic', () => {
  it('returns the same price for the same identity across repeated calls', async () => {
    const provider = new MockPriceProvider();
    const first = await provider.getPrice(BTC);
    const second = await provider.getPrice(BTC);
    expect(second.price).toBe(first.price);
  });

  it('normalizes the identity before pricing — mixed-case address gets the same price', async () => {
    const provider = new MockPriceProvider();
    const lower = await provider.getPrice(BTC);
    const mixed = await provider.getPrice({ chain: BTC.chain, address: BTC.address.toUpperCase() });
    expect(mixed.price).toBe(lower.price);
  });

  it('two different assets are not required to (and typically don\'t) share a price', async () => {
    const provider = new MockPriceProvider();
    const btcPrice = await provider.getPrice(BTC);
    const ethPrice = await provider.getPrice(ETH);
    expect(btcPrice.price).not.toBe(ethPrice.price);
  });

  it('setPrice() overrides the deterministic default', async () => {
    const provider = new MockPriceProvider();
    provider.setPrice(BTC, '99999.99');
    const price = await provider.getPrice(BTC);
    expect(price.price).toBe('99999.99');
  });

  it('always returns a valid decimal string', async () => {
    const provider = new MockPriceProvider();
    const price = await provider.getPrice(BTC);
    expect(isValidDecimalString(price.price)).toBe(true);
  });
});

describe('MockPriceProvider — timestamp', () => {
  it('uses the injected clock, preserved exactly', async () => {
    const fixed = new Date('2026-01-01T00:00:00.000Z');
    const provider = new MockPriceProvider({ now: () => fixed });
    const price = await provider.getPrice(BTC);
    expect(price.timestamp).toBe(fixed.toISOString());
  });

  it('defaults source and quoteCurrency', async () => {
    const provider = new MockPriceProvider();
    const price = await provider.getPrice(BTC);
    expect(price.source).toBe('mock');
    expect(price.quoteCurrency).toBe('USD');
  });
});

describe('price precision — protocol price (bigint, truncates)', () => {
  it('scales a decimal string to the requested precision', () => {
    expect(toProtocolPrice('43250.125', 6)).toBe(BigInt('43250125000'));
  });

  it('truncates (never rounds) precision beyond scaleDecimals', () => {
    // 6 decimals kept, 7th+ digit dropped entirely — not rounded to 43250.1234568
    expect(toProtocolPrice('43250.12345678', 6)).toBe(BigInt('43250123456'));
  });

  it('handles whole numbers with no fractional part', () => {
    expect(toProtocolPrice('100', 2)).toBe(BigInt('10000'));
  });

  it('handles negative prices', () => {
    expect(toProtocolPrice('-5.5', 2)).toBe(BigInt('-550'));
  });

  it('rejects an invalid decimal string', () => {
    expect(() => toProtocolPrice('abc', 2)).toThrow();
  });
});

describe('price precision — display price (string, rounds half-up)', () => {
  it('pads short fractions', () => {
    expect(toDisplayPrice('43250.1', 2)).toBe('43250.10');
  });

  it('rounds half-up on the removed digit', () => {
    expect(toDisplayPrice('43250.125', 2)).toBe('43250.13');
  });

  it('rounds down when the removed digit is below 5', () => {
    expect(toDisplayPrice('43250.124', 2)).toBe('43250.12');
  });

  it('carries a round-up through the whole part', () => {
    expect(toDisplayPrice('9.995', 2)).toBe('10.00');
  });

  it('handles negative prices', () => {
    expect(toDisplayPrice('-1.005', 2)).toBe('-1.01');
  });
});

describe('stale prices', () => {
  const fresh = { asset: BTC, price: '1', quoteCurrency: 'USD', source: 'mock', timestamp: new Date().toISOString() };

  it('a fresh price is not stale', () => {
    expect(isPriceStale(fresh)).toBe(false);
  });

  it('a price older than the threshold is stale', () => {
    const old = { ...fresh, timestamp: new Date(Date.now() - DEFAULT_MAX_PRICE_AGE_MS - 1000).toISOString() };
    expect(isPriceStale(old)).toBe(true);
  });

  it('respects a custom threshold', () => {
    const tenSecondsOld = { ...fresh, timestamp: new Date(Date.now() - 10_000).toISOString() };
    expect(isPriceStale(tenSecondsOld, 5_000)).toBe(true);
    expect(isPriceStale(tenSecondsOld, 60_000)).toBe(false);
  });

  it('priceAgeMs reflects an injected "now"', () => {
    const timestamp = new Date('2026-01-01T00:00:00.000Z').toISOString();
    const now = new Date('2026-01-01T00:01:00.000Z');
    expect(priceAgeMs({ ...fresh, timestamp }, now)).toBe(60_000);
  });
});
