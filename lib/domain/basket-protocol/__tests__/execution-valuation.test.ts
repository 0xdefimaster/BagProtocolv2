import { describe, expect, it } from 'vitest';
import { executionPricesFromLegs, legFloorOutputRaw, navAtExecutionPrices, EXECUTION_QUOTE_PRICE_SOURCE, ExecutionLeg } from '../shares/execution-valuation';
import { getDepositQuote } from '../shares/shares';
import { assetIdentityKey } from '../asset-identity';
import type { AssetHolding, AssetPrice, ShareSupply } from '@/types/basket-protocol';

const USDG = { chain: 'robinhood' as const, address: '0x5fc5360d0400a0fd4f2af552add042d716f1d168' };
const NVDA = { chain: 'robinhood' as const, address: '0x1111111111111111111111111111111111111111' };
const AAPL = { chain: 'robinhood' as const, address: '0x2222222222222222222222222222222222222222' };
const OLD = { chain: 'robinhood' as const, address: '0x3333333333333333333333333333333333333333' };
const NOW = new Date('2026-10-03T15:00:00Z');
const input = { asset: USDG, decimals: 6 };
const e18 = (n: number | string) => BigInt(Math.round(Number(n) * 1e6)) * BigInt(1e12);

const leg = (asset: typeof NVDA, inputUsdg: number, minOut: string, decimals = 18): ExecutionLeg => ({
  action: 'SWAP',
  outputAsset: asset,
  inputAmountRaw: String(inputUsdg * 1e6),
  minOutputRaw: minOut,
  outputDecimals: decimals,
});
const holding = (asset: typeof NVDA, qty: string, decimals = 18): AssetHolding => ({ asset, quantityRaw: qty, decimals });
const supply = (shares: number): ShareSupply => ({ bagId: 'b', totalSharesRaw: e18(shares).toString(), shareDecimals: 18, updatedAt: NOW.toISOString() });

describe('executionPricesFromLegs', () => {
  it('prices each bought asset as input spent / BAG minimum output, and the payment token at 1', () => {
    const p = executionPricesFromLegs([leg(NVDA, 60, e18(9.9).toString()), leg(AAPL, 40, e18(4).toString())], input, NOW.toISOString());
    expect(p.get(assetIdentityKey(USDG))?.price).toBe('1');
    expect(p.get(assetIdentityKey(AAPL))?.price).toBe('10');
    // 60 / 9.9 = 6.060606…, rounded UP at 18 decimals (never under-values existing holdings).
    expect(p.get(assetIdentityKey(NVDA))?.price).toBe('6.060606060606060607');
    expect(p.get(assetIdentityKey(NVDA))?.source).toBe(EXECUTION_QUOTE_PRICE_SOURCE);
  });

  it('respects decimals on both sides', () => {
    // 50 USDG buys at least 0.0005 of an 8-decimal token -> 100000 per token.
    const p = executionPricesFromLegs([leg(NVDA, 50, '50000', 8)], input, NOW.toISOString());
    expect(p.get(assetIdentityKey(NVDA))?.price).toBe('100000');
  });

  it('never prices from an unquoted leg, a KEEP step or a zero amount', () => {
    const p = executionPricesFromLegs(
      [
        { ...leg(NVDA, 60, e18(1).toString()), minOutputRaw: null },
        { ...leg(AAPL, 40, e18(1).toString()), outputDecimals: null },
        { action: 'KEEP', outputAsset: USDG, inputAmountRaw: '1000000', minOutputRaw: null, outputDecimals: null },
        leg(OLD, 0, e18(1).toString()),
      ],
      input,
      NOW.toISOString()
    );
    expect([...p.keys()]).toEqual([assetIdentityKey(USDG)]);
  });

  it('two legs into the same asset keep the higher (more conservative) price', () => {
    const p = executionPricesFromLegs([leg(NVDA, 10, e18(1).toString()), leg(NVDA, 10, e18(0.5).toString())], input, NOW.toISOString());
    expect(p.get(assetIdentityKey(NVDA))?.price).toBe('20');
  });
});

describe('share pricing at execution prices', () => {
  // Existing Bag: 99 NVDA + 40 AAPL, 100 shares. Deposit 100 USDG: 60 → ≥9.9 NVDA, 40 → ≥4 AAPL.
  const holdings = [holding(NVDA, e18(99).toString()), holding(AAPL, e18(40).toString())];
  const prices = executionPricesFromLegs([leg(NVDA, 60, e18(9.9).toString()), leg(AAPL, 40, e18(4).toString())], input, NOW.toISOString());

  it('is the in-kind ratio: the deposit adds 10% of every holding, so it gets (at most) 10% more shares', () => {
    const v = navAtExecutionPrices(holdings, prices, new Map(), NOW);
    if (!v.ok) throw new Error('unpriced');
    const q = getDepositQuote(v.nav, supply(100), '100');
    expect(BigInt(q.sharesRaw)).toBeLessThanOrEqual(e18(10));
    expect(BigInt(q.sharesRaw)).toBeGreaterThan(e18(9.9999));
  });

  it('never gives the buyer more than the in-kind ratio, whatever the market price', () => {
    // Same holdings and fills, at very different absolute price levels: the share count does not move.
    for (const scale of [0.01, 1, 37, 5000]) {
      const p = executionPricesFromLegs(
        [leg(NVDA, 60 * scale, e18(9.9).toString()), leg(AAPL, 40 * scale, e18(4).toString())],
        input,
        NOW.toISOString()
      );
      const v = navAtExecutionPrices(holdings, p, new Map(), NOW);
      if (!v.ok) throw new Error('unpriced');
      const q = getDepositQuote(v.nav, supply(100), String(100 * scale));
      expect(BigInt(q.sharesRaw)).toBeLessThanOrEqual(e18(10));
      expect(BigInt(q.sharesRaw)).toBeGreaterThan(e18(9.999));
    }
  });

  it('a holding the purchase does not buy is priced only from another real price, or the valuation fails naming it', () => {
    const withOld = [...holdings, holding(OLD, e18(1).toString())];
    expect(navAtExecutionPrices(withOld, prices, new Map(), NOW)).toEqual({ ok: false, unpriced: [OLD] });
    const oracle: AssetPrice = { asset: OLD, price: '5', quoteCurrency: 'USD', timestamp: NOW.toISOString(), source: 'oracle' };
    const v = navAtExecutionPrices(withOld, prices, new Map([[assetIdentityKey(OLD), oracle]]), NOW);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.nav.components.find((c) => c.asset.address === OLD.address)?.price.source).toBe('oracle');
  });

  it('payment-token holdings (kept input) are valued at 1', () => {
    const v = navAtExecutionPrices([holding(USDG, '25000000', 6)], prices, new Map(), NOW);
    expect(v.ok && Number(v.nav.grossNav)).toBe(25);
  });
});

describe('legFloorOutputRaw: the lowest output a leg can end with, strictest source first', () => {
  const base: ExecutionLeg = { action: 'SWAP', outputAsset: NVDA, inputAmountRaw: '1000000', minOutputRaw: null, outputDecimals: 18 };
  it("BAG's own minimum first, then the provider-enforced minimum (Composer amountOutMin)", () => {
    expect(legFloorOutputRaw({ ...base, minOutputRaw: '90', providerEnforcedMinOutputRaw: '95', outputAmountRaw: '100' }, 100)).toBe(BigInt(90));
    expect(legFloorOutputRaw({ ...base, providerEnforcedMinOutputRaw: '95', outputAmountRaw: '100' }, 100)).toBe(BigInt(95));
  });
  it('without any minimum: the simulated output reduced by the slippage tolerance, never the raw simulation', () => {
    expect(legFloorOutputRaw({ ...base, outputAmountRaw: '10000' }, 100)).toBe(BigInt(9900));
    expect(legFloorOutputRaw({ ...base, outputAmountRaw: '10000' }, 37.5)).toBe(BigInt(9962)); // tolerance rounded up
  });
  it('no usable number, or no tolerance configured: no floor (the asset stays unpriced)', () => {
    expect(legFloorOutputRaw({ ...base, outputAmountRaw: '10000' }, -1)).toBeNull();
    expect(legFloorOutputRaw({ ...base, minOutputRaw: '0', providerEnforcedMinOutputRaw: 'abc' }, 100)).toBeNull();
    expect(legFloorOutputRaw(base, 100)).toBeNull();
  });
  it('a Composer-shaped leg is priced from amountOutMin', () => {
    const p = executionPricesFromLegs([{ ...base, inputAmountRaw: String(60e6), providerEnforcedMinOutputRaw: e18(9.9).toString(), outputAmountRaw: e18(10).toString() }], input, NOW.toISOString());
    expect(p.get(assetIdentityKey(NVDA))?.price).toBe('6.060606060606060607');
  });
});
