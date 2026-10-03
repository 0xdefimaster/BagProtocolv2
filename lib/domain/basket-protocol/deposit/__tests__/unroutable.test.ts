import { describe, expect, it } from 'vitest';
import { BasketRecipe, DEFAULT_REBALANCE_RULE } from '@/types/basket-protocol';
import { applyUnroutablePolicy, rawToDecimalString, scaleAmountRaw } from '../unroutable';
import { calculateDepositAllocation } from '../allocation';

const USDG = { chain: 'robinhood' as const, address: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', symbol: 'USDG', decimals: 6 };
const A = { chain: 'robinhood' as const, address: '0xaaaa00000000000000000000000000000000aaaa', symbol: 'AAA', decimals: 18 };
const B = { chain: 'robinhood' as const, address: '0xbbbb00000000000000000000000000000000bbbb', symbol: 'BBB', decimals: 18 };
const QNT = { chain: 'robinhood' as const, address: '0x55601b1ad2d23000000000000000000000000001', symbol: 'QNT', decimals: 18 };

function recipe(over: Partial<BasketRecipe> = {}): BasketRecipe {
  return {
    id: 'r',
    bagId: 'bag_1',
    name: 'Test',
    symbol: 'TST',
    description: '',
    chain: 'robinhood',
    strategyType: 'STATIC_BASKET',
    assets: [
      { ...A, weightBps: 5000 },
      { ...B, weightBps: 3800 },
      { ...QNT, weightBps: 1200 },
    ],
    rebalanceRule: DEFAULT_REBALANCE_RULE,
    minInvestment: 100,
    maxAssets: 10,
    minWeightBps: 100,
    maxWeightBps: 8000,
    mutability: 'MUTABLE',
    version: 1,
    createdAt: '',
    ...over,
  };
}

describe('applyUnroutablePolicy', () => {
  it('nothing unroutable: recipe unchanged, full amount', () => {
    const r = recipe();
    const out = applyUnroutablePolicy(r, USDG, [], 'REFUND');
    expect(out).toMatchObject({ ok: true, amountScaleBps: 10000, unroutableWeightBps: 0 });
    if (out.ok) expect(out.recipe).toBe(r);
  });

  it('defaults to BLOCK when the recipe has no policy', () => {
    expect(applyUnroutablePolicy(recipe(), USDG, [QNT])).toMatchObject({ ok: false, reason: 'BLOCKED', unroutableWeightBps: 1200 });
  });

  it('HOLD_INPUT: the unroutable weight moves to the payment token, which the allocator then KEEPs', () => {
    const out = applyUnroutablePolicy(recipe(), USDG, [QNT], 'HOLD_INPUT');
    if (!out.ok) throw new Error('expected ok');
    expect(out.amountScaleBps).toBe(10000);
    expect(out.recipe.assets.map((a) => [a.symbol, a.weightBps])).toEqual([['AAA', 5000], ['BBB', 3800], ['USDG', 1200]]);

    const plan = calculateDepositAllocation({ bagId: 'bag_1', inputAsset: USDG, amountRaw: '100000000' }, out.recipe);
    const usdg = plan.allocations.find((a) => a.targetSymbol === 'USDG')!;
    expect(usdg).toMatchObject({ action: 'KEEP', valueRaw: '12000000' });
    expect(plan.unallocatedRaw).toBe('0');
  });

  it('HOLD_INPUT merges into an existing payment-token entry instead of duplicating it', () => {
    const r = recipe({ assets: [{ ...A, weightBps: 6000 }, { ...USDG, weightBps: 2000 }, { ...QNT, weightBps: 2000 }] });
    const out = applyUnroutablePolicy(r, USDG, [QNT], 'HOLD_INPUT');
    if (!out.ok) throw new Error('expected ok');
    expect(out.recipe.assets.map((a) => [a.symbol, a.weightBps])).toEqual([['AAA', 6000], ['USDG', 4000]]);
  });

  it('REFUND: drops the asset, renormalizes to exactly 100%, and scales the spend and the minimum', () => {
    const out = applyUnroutablePolicy(recipe(), USDG, [QNT], 'REFUND');
    if (!out.ok) throw new Error('expected ok');
    expect(out.amountScaleBps).toBe(8800);
    expect(out.recipe.assets.map((a) => a.symbol)).toEqual(['AAA', 'BBB']);
    expect(out.recipe.assets.reduce((s, a) => s + a.weightBps, 0)).toBe(10000);
    expect(out.recipe.minInvestment).toBeCloseTo(88);

    // Each routable asset gets what it would have in a full $100 buy, within
    // the rounding of integer bps weights (well under 0.01%).
    const spend = scaleAmountRaw('100000000', out.amountScaleBps);
    expect(spend).toBe('88000000');
    const plan = calculateDepositAllocation({ bagId: 'bag_1', inputAsset: USDG, amountRaw: spend }, out.recipe);
    const value = (sym: string) => Number(plan.allocations.find((a) => a.targetSymbol === sym)!.valueRaw);
    expect(Math.abs(value('AAA') - 50_000_000) / 50_000_000).toBeLessThan(0.0001);
    expect(Math.abs(value('BBB') - 38_000_000) / 38_000_000).toBeLessThan(0.0001);
  });

  it('refuses either partial mode above the cap', () => {
    const r = recipe({ assets: [{ ...A, weightBps: 6000 }, { ...QNT, weightBps: 4000 }] });
    expect(applyUnroutablePolicy(r, USDG, [QNT], 'HOLD_INPUT')).toMatchObject({ ok: false, reason: 'TOO_MUCH_UNROUTABLE' });
    expect(applyUnroutablePolicy(r, USDG, [QNT], 'REFUND')).toMatchObject({ ok: false, reason: 'TOO_MUCH_UNROUTABLE' });
  });

  it('matches by chain+address (case-insensitive), never by symbol, and ignores the input asset itself', () => {
    const upper = { chain: 'robinhood' as const, address: QNT.address.toUpperCase().replace('0X', '0x') };
    expect(applyUnroutablePolicy(recipe(), USDG, [upper], 'REFUND')).toMatchObject({ ok: true, unroutableWeightBps: 1200 });
    expect(applyUnroutablePolicy(recipe(), USDG, [{ chain: 'robinhood', address: '0x0000000000000000000000000000000000000001' }], 'REFUND')).toMatchObject({
      ok: true,
      unroutableWeightBps: 0,
    });
    const withUsdg = recipe({ assets: [{ ...A, weightBps: 8000 }, { ...USDG, weightBps: 2000 }] });
    expect(applyUnroutablePolicy(withUsdg, USDG, [USDG], 'BLOCK')).toMatchObject({ ok: true, unroutableWeightBps: 0 });
  });

  it('is deterministic: the same inputs give the same effective recipe', () => {
    const a = applyUnroutablePolicy(recipe(), USDG, [QNT], 'REFUND');
    const b = applyUnroutablePolicy(recipe(), USDG, [QNT], 'REFUND');
    expect(a).toEqual(b);
  });
});

describe('rawToDecimalString', () => {
  it('formats exactly', () => {
    expect(rawToDecimalString('88000000', 6)).toBe('88');
    expect(rawToDecimalString('1500001', 6)).toBe('1.500001');
    expect(rawToDecimalString('5', 6)).toBe('0.000005');
    expect(rawToDecimalString('42', 0)).toBe('42');
  });
});
