import { describe, expect, it } from 'vitest';
import { AssetHolding, AssetIdentity, AssetPrice } from '@/types/basket-protocol';
import { assetIdentityKey } from '../../asset-identity';
import { PriceUnavailableError } from '../../pricing/provider';
import {
  calculateNavFromPrices,
  calculateNavPerShare,
  findMissingHoldings,
  formatNavValue,
  InvalidQuantityError,
  NAV_VALUE_DECIMALS,
  StalePriceError,
  ZeroShareSupplyError,
} from '../nav';

// -----------------------------------------------------------------------------
// calculateNavFromPrices() is the pure, synchronous core — every case here
// hand-builds prices (no PriceProvider, no async) so results are asserted
// against exact expected strings. See nav-integration.test.ts for the
// provider-driven, recipe-vs-holdings end-to-end scenario (spec section 18).
// -----------------------------------------------------------------------------

const BTC: AssetIdentity = { chain: 'ethereum', address: '0x11111111111111111111111111111111111111' };
const ETH: AssetIdentity = { chain: 'ethereum', address: '0x22222222222222222222222222222222222222' };
const SOL: AssetIdentity = { chain: 'solana', address: 'So11111111111111111111111111111111111111112' };

function price(asset: AssetIdentity, value: string, overrides: Partial<AssetPrice> = {}): AssetPrice {
  return {
    asset,
    price: value,
    quoteCurrency: 'USD',
    timestamp: new Date('2026-01-01T12:00:00.000Z').toISOString(),
    source: 'test',
    ...overrides,
  };
}

function priceMap(...entries: AssetPrice[]): Map<string, AssetPrice> {
  return new Map(entries.map((p) => [assetIdentityKey(p.asset), p]));
}

const NOW = new Date('2026-01-01T12:00:00.000Z');

describe('calculateNavFromPrices — basic exact arithmetic', () => {
  it('2 BTC @ 100 + 3 ETH @ 50 = 350', () => {
    const holdings: AssetHolding[] = [
      { asset: BTC, quantityRaw: '2', decimals: 0 },
      { asset: ETH, quantityRaw: '3', decimals: 0 },
    ];
    const prices = priceMap(price(BTC, '100', { timestamp: NOW.toISOString() }), price(ETH, '50', { timestamp: NOW.toISOString() }));

    const result = calculateNavFromPrices(holdings, prices, { now: NOW });
    expect(result.grossNav).toBe(formatNavValue(BigInt(350) * BigInt(10) ** BigInt(NAV_VALUE_DECIMALS)));
    expect(result.netNav).toBe(result.grossNav);
    expect(result.components).toHaveLength(2);
    expect(result.components[0].value).toBe(formatNavValue(BigInt(200) * BigInt(10) ** BigInt(NAV_VALUE_DECIMALS)));
    expect(result.components[1].value).toBe(formatNavValue(BigInt(150) * BigInt(10) ** BigInt(NAV_VALUE_DECIMALS)));
  });
});

describe('calculateNavFromPrices — different decimals, exact result', () => {
  it('1.25 ETH (18 decimals) @ $2000 + 100 units of a 6-decimal asset @ $1 = 2600', () => {
    const holdings: AssetHolding[] = [
      { asset: ETH, quantityRaw: '1250000000000000000', decimals: 18 }, // 1.25 ETH
      { asset: BTC, quantityRaw: '100000000', decimals: 6 }, // 100 units, 6-decimal asset (BTC identity reused as a stand-in)
    ];
    const prices = priceMap(
      price(ETH, '2000', { timestamp: NOW.toISOString() }),
      price(BTC, '1', { timestamp: NOW.toISOString() })
    );

    const result = calculateNavFromPrices(holdings, prices, { now: NOW });
    // 1.25 * 2000 = 2500, 100 * 1 = 100, total = 2600
    expect(result.grossNav).toBe(formatNavValue(BigInt(2600) * BigInt(10) ** BigInt(NAV_VALUE_DECIMALS)));
  });

  it('different price precision (8-decimal price string) still resolves exactly', () => {
    const holdings: AssetHolding[] = [{ asset: BTC, quantityRaw: '3', decimals: 0 }];
    const prices = priceMap(price(BTC, '43250.12345678', { timestamp: NOW.toISOString() }));

    const result = calculateNavFromPrices(holdings, prices, { now: NOW });
    // 3 * 43250.12345678 = 129750.37037034
    expect(result.grossNav).toBe('129750.370370340000000000');
  });
});

describe('calculateNavFromPrices — zero and empty', () => {
  it('a holding with zero quantity contributes zero value, not an error', () => {
    const holdings: AssetHolding[] = [{ asset: BTC, quantityRaw: '0', decimals: 8 }];
    const prices = priceMap(price(BTC, '50000', { timestamp: NOW.toISOString() }));

    const result = calculateNavFromPrices(holdings, prices, { now: NOW });
    expect(result.components[0].value).toBe(formatNavValue(BigInt(0)));
    expect(result.grossNav).toBe(formatNavValue(BigInt(0)));
  });

  it('empty holdings -> grossNav "0", no components', () => {
    const result = calculateNavFromPrices([], new Map(), { now: NOW });
    expect(result.components).toEqual([]);
    expect(result.grossNav).toBe(formatNavValue(BigInt(0)));
    expect(result.netNav).toBe(result.grossNav);
  });
});

describe('calculateNavFromPrices — missing price fails loud, never partial', () => {
  it('throws PriceUnavailableError when a holding has no matching price, even if other holdings do', () => {
    const holdings: AssetHolding[] = [
      { asset: BTC, quantityRaw: '1', decimals: 0 },
      { asset: ETH, quantityRaw: '1', decimals: 0 },
      { asset: SOL, quantityRaw: '1', decimals: 0 }, // no price provided for SOL
    ];
    const prices = priceMap(price(BTC, '100', { timestamp: NOW.toISOString() }), price(ETH, '50', { timestamp: NOW.toISOString() }));

    expect(() => calculateNavFromPrices(holdings, prices, { now: NOW })).toThrow(PriceUnavailableError);
  });
});

describe('calculateNavFromPrices — stale price fails loud', () => {
  it('throws StalePriceError for a price older than maxAgeMs', () => {
    const staleTimestamp = new Date(NOW.getTime() - 10 * 60 * 1000).toISOString(); // 10 min old
    const holdings: AssetHolding[] = [{ asset: BTC, quantityRaw: '1', decimals: 0 }];
    const prices = priceMap(price(BTC, '100', { timestamp: staleTimestamp }));

    expect(() => calculateNavFromPrices(holdings, prices, { now: NOW, maxPriceAgeMs: 5 * 60 * 1000 })).toThrow(
      StalePriceError
    );
  });

  it('does not throw for a price within maxAgeMs', () => {
    const freshTimestamp = new Date(NOW.getTime() - 60 * 1000).toISOString(); // 1 min old
    const holdings: AssetHolding[] = [{ asset: BTC, quantityRaw: '1', decimals: 0 }];
    const prices = priceMap(price(BTC, '100', { timestamp: freshTimestamp }));

    expect(() => calculateNavFromPrices(holdings, prices, { now: NOW, maxPriceAgeMs: 5 * 60 * 1000 })).not.toThrow();
  });

  it('rejects an invalid quantity string rather than silently coercing it', () => {
    const holdings: AssetHolding[] = [{ asset: BTC, quantityRaw: '1.5', decimals: 0 }];
    const prices = priceMap(price(BTC, '100', { timestamp: NOW.toISOString() }));
    expect(() => calculateNavFromPrices(holdings, prices, { now: NOW })).toThrow(InvalidQuantityError);
  });
});

describe('calculateNavFromPrices — exact arithmetic on large values, no precision loss', () => {
  it('handles a very large quantity and price with no float rounding', () => {
    // 1,000,000 whole tokens (18 decimals) at a very precise price.
    const holdings: AssetHolding[] = [{ asset: BTC, quantityRaw: '1000000000000000000000000', decimals: 18 }];
    const prices = priceMap(price(BTC, '123456.789012345678', { timestamp: NOW.toISOString() }));

    const result = calculateNavFromPrices(holdings, prices, { now: NOW });
    // 1,000,000 * 123456.789012345678 = 123456789012.345678
    expect(result.grossNav).toBe('123456789012.345678000000000000');
  });
});

describe('calculateNavPerShare', () => {
  it('NAV 1000 / supply 100 = 10', () => {
    const nav = calculateNavFromPrices(
      [{ asset: BTC, quantityRaw: '10', decimals: 0 }],
      priceMap(price(BTC, '100', { timestamp: NOW.toISOString() })),
      { now: NOW }
    );
    expect(nav.grossNav).toBe(formatNavValue(BigInt(1000) * BigInt(10) ** BigInt(NAV_VALUE_DECIMALS)));

    const perShare = calculateNavPerShare(nav, '100', 0);
    expect(perShare).toBe(formatNavValue(BigInt(10) * BigInt(10) ** BigInt(NAV_VALUE_DECIMALS)));
  });

  it('handles fractional share supply (raw units + decimals) exactly', () => {
    const nav = calculateNavFromPrices(
      [{ asset: BTC, quantityRaw: '10', decimals: 0 }],
      priceMap(price(BTC, '100', { timestamp: NOW.toISOString() })),
      { now: NOW }
    );
    // 100 shares at 18 decimals = "100000000000000000000" raw
    const perShare = calculateNavPerShare(nav, '100000000000000000000', 18);
    expect(perShare).toBe(formatNavValue(BigInt(10) * BigInt(10) ** BigInt(NAV_VALUE_DECIMALS)));
  });

  it('throws ZeroShareSupplyError for zero supply, explicitly', () => {
    const nav = calculateNavFromPrices(
      [{ asset: BTC, quantityRaw: '10', decimals: 0 }],
      priceMap(price(BTC, '100', { timestamp: NOW.toISOString() })),
      { now: NOW }
    );
    expect(() => calculateNavPerShare(nav, '0', 0)).toThrow(ZeroShareSupplyError);
  });

  it('truncates (never rounds up) a non-terminating division, same policy as toProtocolPrice', () => {
    const nav = calculateNavFromPrices(
      [{ asset: BTC, quantityRaw: '1', decimals: 0 }],
      priceMap(price(BTC, '1000', { timestamp: NOW.toISOString() })),
      { now: NOW }
    );
    const perShare = calculateNavPerShare(nav, '3', 0); // 1000 / 3 = 333.333...
    expect(perShare.startsWith('333.333333333333333')).toBe(true);
    expect(perShare).not.toContain('334');
  });
});

describe('findMissingHoldings', () => {
  it('flags a recipe asset with no corresponding holding, without affecting NAV math', () => {
    const missing = findMissingHoldings([BTC, ETH, SOL], [{ asset: BTC, quantityRaw: '1', decimals: 0 }]);
    expect(missing).toEqual([ETH, SOL]);
  });

  it('returns empty when every recipe asset has a holding', () => {
    const missing = findMissingHoldings(
      [BTC, ETH],
      [
        { asset: BTC, quantityRaw: '1', decimals: 0 },
        { asset: ETH, quantityRaw: '1', decimals: 0 },
      ]
    );
    expect(missing).toEqual([]);
  });
});

describe('no JS float path', () => {
  it('formatNavValue produces exact strings for values a float would mis-round', () => {
    // 0.1 + 0.2 !== 0.3 in IEEE-754 — verify the fixed-point path doesn't
    // reproduce that error for the equivalent scaled integers.
    const a = BigInt('100000000000000000'); // 0.1 at 18 decimals
    const b = BigInt('200000000000000000'); // 0.2 at 18 decimals
    expect(formatNavValue(a + b)).toBe('0.300000000000000000');
  });
});
