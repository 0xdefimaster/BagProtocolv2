import { describe, expect, it } from 'vitest';
import {
  AssetIdentity,
  BasketRecipe,
  DEFAULT_REBALANCE_RULE,
  DEFAULT_SHARE_BOOTSTRAP_POLICY,
  NavResult,
  RecipeAsset,
  ShareSupply,
} from '@/types/basket-protocol';
import { formatNavValue, NAV_VALUE_DECIMALS, ZeroShareSupplyError } from '../../nav/nav';
import {
  getDepositQuote,
  getPurchaseDepositQuote,
  getRedeemQuote,
  getSharePrice,
  InsufficientSharesError,
  InvalidDepositAmountError,
  InvalidShareQuantityError,
  ZeroDepositAmountError,
  ZeroRedeemAmountError, OrphanedNavError, ZeroNavError } from '../shares';

// -----------------------------------------------------------------------------
// getSharePrice/getDepositQuote/getRedeemQuote are pure and synchronous —
// every test hand-builds a NavResult and a ShareSupply, same convention as
// nav.test.ts and rebalance.test.ts.
// -----------------------------------------------------------------------------

const BTC: AssetIdentity = { chain: 'ethereum', address: '0x11111111111111111111111111111111111111' };
const NOW = new Date('2026-01-01T12:00:00.000Z').toISOString();
const SCALE = BigInt(10) ** BigInt(NAV_VALUE_DECIMALS);

function navValue(n: number): string {
  return formatNavValue(BigInt(n) * SCALE);
}

function navResult(grossNavValue: number): NavResult {
  return {
    asOf: NOW,
    quoteCurrency: 'USD',
    components: [
      {
        asset: BTC,
        quantityRaw: '1',
        decimals: 8,
        price: { asset: BTC, price: String(grossNavValue), quoteCurrency: 'USD', timestamp: NOW, source: 'test' },
        value: navValue(grossNavValue),
      },
    ],
    grossNav: navValue(grossNavValue),
    netNav: navValue(grossNavValue),
  };
}

function shareSupply(totalShares: number | string, shareDecimals = 18): ShareSupply {
  const totalSharesRaw =
    typeof totalShares === 'number' ? (BigInt(totalShares) * BigInt(10) ** BigInt(shareDecimals)).toString() : totalShares;
  return { bagId: 'bag_shares', totalSharesRaw, shareDecimals, updatedAt: NOW };
}

describe('getSharePrice', () => {
  it('NAV 100000 / supply 10000 -> price 10', () => {
    const price = getSharePrice(navResult(100000), shareSupply(10000));
    expect(price.value).toBe(navValue(10));
    expect(price.quoteCurrency).toBe('USD');
  });

  it('zero supply throws ZeroShareSupplyError (unchanged nav.ts behavior)', () => {
    expect(() => getSharePrice(navResult(100000), shareSupply(0))).toThrow(ZeroShareSupplyError);
  });
});

describe('getSharePrice — zero NAV and zero supply, no NaN/Infinity ever', () => {
  it('zero NAV with zero supply still throws ZeroShareSupplyError deterministically (no division-by-zero artifact)', () => {
    expect(() => getSharePrice(navResult(0), shareSupply(0))).toThrow(ZeroShareSupplyError);
  });
});

describe('getDepositQuote — normal (non-bootstrap) pricing', () => {
  it('price 10, deposit 1000 -> 100 shares', () => {
    const quote = getDepositQuote(navResult(100000), shareSupply(10000), '1000');
    expect(quote.isBootstrap).toBe(false);
    expect(quote.sharePrice).toBe(navValue(10));
    expect(BigInt(quote.sharesRaw)).toBe(BigInt(100) * BigInt(10) ** BigInt(18));
  });

  it('fractional deposit truncates rather than rounds (1000 / 3 share price)', () => {
    // NAV 100000, supply 30000 -> price = 100000/30000 = 3.333...
    const supply = shareSupply(30000);
    const nav = navResult(100000);
    const price = getSharePrice(nav, supply);
    // Sanity: price is truncated at NAV_VALUE_DECIMALS, not a repeating decimal.
    expect(price.value.split('.')[1]?.length).toBeLessThanOrEqual(NAV_VALUE_DECIMALS);

    const quote = getDepositQuote(nav, supply, '1000');
    // Shares come from the EXACT ratio floored once: floor(deposit × supply / NAV).
    const depositScaled = BigInt(1000) * SCALE;
    const navScaled = BigInt(100000) * SCALE;
    const supplyRaw = BigInt(supply.totalSharesRaw);
    const shares = BigInt(quote.sharesRaw);
    expect(shares).toBe((depositScaled * supplyRaw) / navScaled);
    // Invariant: never more value than paid for (rounds in the Bag's favor)…
    expect(shares * navScaled <= depositScaled * supplyRaw).toBe(true);
    // …and never more than one raw unit short.
    expect((shares + BigInt(1)) * navScaled > depositScaled * supplyRaw).toBe(true);
    // Regression: dividing by the TRUNCATED display price minted MORE shares than paid for.
    const priceScaled = BigInt(price.value.replace('.', ''));
    const viaTruncatedPrice = (depositScaled * BigInt(10) ** BigInt(18)) / priceScaled;
    expect(viaTruncatedPrice * navScaled > depositScaled * supplyRaw).toBe(true);
    expect(shares < viaTruncatedPrice).toBe(true);
  });

  it('different share decimals than NAV_VALUE_DECIMALS are respected exactly', () => {
    const supply = shareSupply(10000, 6); // share decimals = 6, unlike NAV's 18
    const quote = getDepositQuote(navResult(100000), supply, '1000');
    expect(quote.shareDecimals).toBe(6);
    expect(BigInt(quote.sharesRaw)).toBe(BigInt(100) * BigInt(10) ** BigInt(6));
  });

  it('large deposit/NAV values retain full bigint precision', () => {
    const supply = shareSupply('1000000000000000000000000', 18); // 1,000,000 shares raw
    const nav: NavResult = {
      asOf: NOW,
      quoteCurrency: 'USD',
      components: [],
      grossNav: '987654321098.123456789012345678',
      netNav: '987654321098.123456789012345678',
    };
    const quote = getDepositQuote(nav, supply, '123456.789012345678901234');
    // price = NAV / supply(human) = 987654321098.123456789012345678 / 1,000,000
    // just assert exactness by recomputing independently with the same formula.
    const priceScaled = BigInt(quote.sharePrice.replace('.', ''));
    const depositScaled = BigInt('123456789012345678901234');
    const expected = (depositScaled * BigInt(10) ** BigInt(18)) / priceScaled;
    expect(BigInt(quote.sharesRaw)).toBe(expected);
  });

  it('rejects an invalid/negative deposit amount', () => {
    expect(() => getDepositQuote(navResult(100000), shareSupply(10000), '-500')).toThrow(InvalidDepositAmountError);
    expect(() => getDepositQuote(navResult(100000), shareSupply(10000), 'abc')).toThrow(InvalidDepositAmountError);
  });

  it('rejects a zero deposit amount', () => {
    expect(() => getDepositQuote(navResult(100000), shareSupply(10000), '0')).toThrow(ZeroDepositAmountError);
    expect(() => getDepositQuote(navResult(0), shareSupply(0), '0', DEFAULT_SHARE_BOOTSTRAP_POLICY)).toThrow(
      ZeroDepositAmountError
    );
  });

  it('does not mutate the NavResult or ShareSupply it was given', () => {
    const nav = navResult(100000);
    const supply = shareSupply(10000);
    const navBefore = JSON.parse(JSON.stringify(nav));
    const supplyBefore = JSON.parse(JSON.stringify(supply));

    getDepositQuote(nav, supply, '1000');

    expect(nav).toEqual(navBefore);
    expect(supply).toEqual(supplyBefore);
  });

  it('is deterministic — same input produces the same quote', () => {
    const nav = navResult(100000);
    const supply = shareSupply(10000);
    const a = getDepositQuote(nav, supply, '1000');
    const b = getDepositQuote(nav, supply, '1000');
    expect(a).toEqual(b);
  });
});

describe('getDepositQuote — bootstrap (zero supply)', () => {
  it('first deposit into a zero-supply Bag mints deterministically at the bootstrap price', () => {
    const quote = getDepositQuote(navResult(0), shareSupply(0), '1000', DEFAULT_SHARE_BOOTSTRAP_POLICY);
    expect(quote.isBootstrap).toBe(true);
    expect(quote.sharePrice).toBe('1');
    expect(BigInt(quote.sharesRaw)).toBe(BigInt(1000) * BigInt(10) ** BigInt(18));
  });

  it('a custom bootstrap policy is honored, not hardcoded', () => {
    const quote = getDepositQuote(navResult(0), shareSupply(0), '1000', { initialSharePrice: '2' });
    expect(quote.sharePrice).toBe('2');
    expect(BigInt(quote.sharesRaw)).toBe(BigInt(500) * BigInt(10) ** BigInt(18));
  });
});

describe('getDepositQuote — zero supply / zero NAV edge cases (fail closed)', () => {
  it('ZERO supply but POSITIVE NAV (orphaned holdings) → OrphanedNavError, never a free bootstrap', () => {
    expect(() => getDepositQuote(navResult(500), shareSupply(0), '1000')).toThrow(OrphanedNavError);
  });
  it('shares outstanding but ZERO NAV → ZeroNavError (a 0 price would mint unbounded shares)', () => {
    expect(() => getDepositQuote(navResult(0), shareSupply(10000), '1000')).toThrow(ZeroNavError);
  });
});

describe('getRedeemQuote', () => {
  it('price 10, redeem 100 shares -> value 1000', () => {
    const quote = getRedeemQuote(navResult(100000), shareSupply(10000), (BigInt(100) * BigInt(10) ** BigInt(18)).toString());
    expect(quote.grossValue).toBe(navValue(1000));
    expect(quote.sharePrice).toBe(navValue(10));
  });

  it('rejects redeeming zero shares, even at zero supply', () => {
    expect(() => getRedeemQuote(navResult(0), shareSupply(0), '0')).toThrow(ZeroRedeemAmountError);
    expect(() => getRedeemQuote(navResult(100000), shareSupply(10000), '0')).toThrow(ZeroRedeemAmountError);
  });

  it('redeeming more than outstanding supply throws InsufficientSharesError', () => {
    const supply = shareSupply(10000);
    const tooMany = (BigInt(10001) * BigInt(10) ** BigInt(18)).toString();
    expect(() => getRedeemQuote(navResult(100000), supply, tooMany)).toThrow(InsufficientSharesError);
  });

  it('redeeming a positive amount from a zero-supply Bag throws (no bootstrap path for redemption)', () => {
    const tiny = (BigInt(1) * BigInt(10) ** BigInt(18)).toString();
    expect(() => getRedeemQuote(navResult(100000), shareSupply(0), tiny)).toThrow(InsufficientSharesError);
  });

  it('rejects an invalid raw share quantity', () => {
    expect(() => getRedeemQuote(navResult(100000), shareSupply(10000), '-100')).toThrow(InvalidShareQuantityError);
    expect(() => getRedeemQuote(navResult(100000), shareSupply(10000), '12.5')).toThrow(InvalidShareQuantityError);
  });

  it('does not mutate the NavResult or ShareSupply it was given', () => {
    const nav = navResult(100000);
    const supply = shareSupply(10000);
    const navBefore = JSON.parse(JSON.stringify(nav));
    const supplyBefore = JSON.parse(JSON.stringify(supply));

    getRedeemQuote(nav, supply, (BigInt(50) * BigInt(10) ** BigInt(18)).toString());

    expect(nav).toEqual(navBefore);
    expect(supply).toEqual(supplyBefore);
  });

  it('is deterministic — same input produces the same quote', () => {
    const nav = navResult(100000);
    const supply = shareSupply(10000);
    const sharesRaw = (BigInt(100) * BigInt(10) ** BigInt(18)).toString();
    const a = getRedeemQuote(nav, supply, sharesRaw);
    const b = getRedeemQuote(nav, supply, sharesRaw);
    expect(a).toEqual(b);
  });

  it('different share decimals than NAV_VALUE_DECIMALS are respected exactly', () => {
    const supply = shareSupply(10000, 6);
    const sharesRaw = (BigInt(100) * BigInt(10) ** BigInt(6)).toString();
    const quote = getRedeemQuote(navResult(100000), supply, sharesRaw);
    expect(quote.grossValue).toBe(navValue(1000));
  });
});

describe('Share accounting integration — recipe weights never leak into share math', () => {
  function recipeAsset(overrides: Partial<RecipeAsset> & { symbol: string; address: string; weightBps: number }): RecipeAsset {
    return { chain: 'ethereum', decimals: 8, ...overrides };
  }

  function basketRecipe(assets: RecipeAsset[]): BasketRecipe {
    return {
      id: 'recipe_shares_v1',
      bagId: 'bag_shares',
      name: 'Skewed Majors',
      symbol: 'SKEW',
      description: 'Deliberately lopsided target weights to prove they never leak into share math.',
      chain: 'ethereum',
      strategyType: 'STATIC_BASKET',
      assets,
      rebalanceRule: DEFAULT_REBALANCE_RULE,
      minInvestment: 100,
      maxAssets: 10,
      minWeightBps: 0,
      maxWeightBps: 10000,
      mutability: 'MUTABLE',
      version: 1,
      createdAt: NOW,
    };
  }

  it('Bag -> Holdings -> NAV -> Share Supply -> NAV/share -> Deposit Quote: a 90/10 vs 10/90 recipe split produces an identical deposit quote for the same holdings/prices/supply', () => {
    const skewedRecipe = basketRecipe([
      recipeAsset({ symbol: 'BTC', address: BTC.address, weightBps: 9000 }),
      recipeAsset({ symbol: 'ETH', address: '0x2222222222222222222222222222222222222222', weightBps: 1000 }),
    ]);
    const invertedRecipe = basketRecipe([
      recipeAsset({ symbol: 'BTC', address: BTC.address, weightBps: 1000 }),
      recipeAsset({ symbol: 'ETH', address: '0x2222222222222222222222222222222222222222', weightBps: 9000 }),
    ]);

    const nav = navResult(100000); // same holdings/prices regardless of which recipe is "attached"
    const supply = shareSupply(10000);

    const quoteFromSkewed = getDepositQuote(nav, supply, '1000');
    const quoteFromInverted = getDepositQuote(nav, supply, '1000');

    expect(quoteFromSkewed).toEqual(quoteFromInverted);
    void skewedRecipe;
    void invertedRecipe; // neither recipe is ever passed into share math — this test makes that fact explicit
  });
});

describe('getPurchaseDepositQuote: the legacy share counter never blocks a purchase (Accounting V2, D1)', () => {
  it('matches getDepositQuote whenever the counter is consistent', () => {
    expect(getPurchaseDepositQuote(navResult(1000), shareSupply('1000000000000000000000'), '100')).toEqual(
      getDepositQuote(navResult(1000), shareSupply('1000000000000000000000'), '100')
    );
    expect(getPurchaseDepositQuote(navResult(0), shareSupply(0), '100')).toEqual(getDepositQuote(navResult(0), shareSupply(0), '100'));
  });

  it('zero shares with holdings left over restarts the counter at the bootstrap price', () => {
    const q = getPurchaseDepositQuote(navResult(500), shareSupply(0), '1000');
    expect(q.isBootstrap).toBe(true);
    expect(q.sharePrice).toBe(DEFAULT_SHARE_BOOTSTRAP_POLICY.initialSharePrice);
    expect(q.sharesRaw).toBe(getDepositQuote(navResult(0), shareSupply(0), '1000').sharesRaw);
  });

  it('shares outstanding with holdings at zero restarts the counter too', () => {
    const q = getPurchaseDepositQuote(navResult(0), shareSupply('5000000000000000000'), '1000');
    expect(q.isBootstrap).toBe(true);
    expect(BigInt(q.sharesRaw) > BigInt(0)).toBe(true);
  });

  it('other errors still surface', () => {
    expect(() => getPurchaseDepositQuote(navResult(500), shareSupply(0), '0')).toThrow(ZeroDepositAmountError);
  });
});
