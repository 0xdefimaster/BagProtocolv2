import { describe, expect, it } from 'vitest';
import {
  AssetIdentity,
  AssetPrice,
  BasketRecipe,
  DEFAULT_REBALANCE_RULE,
  NavComponent,
  NavResult,
  RebalanceRule,
  RecipeAsset,
} from '@/types/basket-protocol';
import { calculateRebalancePlan, InvalidTargetWeightsError } from '../rebalance';
import { formatNavValue, NAV_VALUE_DECIMALS } from '../../nav/nav';

// -----------------------------------------------------------------------------
// calculateRebalancePlan() is pure and synchronous — every test hand-builds
// a BasketRecipe and a NavResult (no PriceProvider, no async), so results
// are asserted against exact expected strings/bigints, same convention as
// nav.test.ts.
// -----------------------------------------------------------------------------

const BTC: AssetIdentity = { chain: 'ethereum', address: '0x11111111111111111111111111111111111111' };
const ETH: AssetIdentity = { chain: 'ethereum', address: '0x22222222222222222222222222222222222222' };
const USDC: AssetIdentity = { chain: 'ethereum', address: '0x33333333333333333333333333333333333333' };
const SOL: AssetIdentity = { chain: 'solana', address: 'So11111111111111111111111111111111111111112' };
const DOGE: AssetIdentity = { chain: 'ethereum', address: '0x44444444444444444444444444444444444444' };

const NOW = new Date('2026-01-01T12:00:00.000Z').toISOString();
const SCALE = BigInt(10) ** BigInt(NAV_VALUE_DECIMALS);

function nav(value: number | string): string {
  return typeof value === 'number' ? formatNavValue(BigInt(value) * SCALE) : value;
}

function recipeAsset(overrides: Partial<RecipeAsset> & { symbol: string; address: string; weightBps: number }): RecipeAsset {
  return {
    chain: 'ethereum',
    decimals: 8,
    ...overrides,
  };
}

function basketRecipe(assets: RecipeAsset[], rebalanceRule: RebalanceRule = DEFAULT_REBALANCE_RULE): BasketRecipe {
  return {
    id: 'recipe_rebalance_v1',
    bagId: 'bag_rebalance',
    name: 'Test Bag',
    symbol: 'TEST',
    description: 'Rebalance planning test fixture.',
    chain: 'ethereum',
    strategyType: 'STATIC_BASKET',
    assets,
    rebalanceRule,
    minInvestment: 100,
    maxAssets: 10,
    minWeightBps: 0,
    maxWeightBps: 10000,
    mutability: 'MUTABLE',
    version: 1,
    createdAt: NOW,
  };
}

function price(asset: AssetIdentity, value: string): AssetPrice {
  return { asset, price: value, quoteCurrency: 'USD', timestamp: NOW, source: 'test' };
}

/** Builds a NavComponent directly from a target dollar value (no quantity/price math needed for most tests — value is what the planner actually reads). */
function component(asset: AssetIdentity, value: number, decimals = 8, priceValue = '1'): NavComponent {
  return {
    asset,
    quantityRaw: '0',
    decimals,
    price: price(asset, priceValue),
    value: nav(value),
  };
}

function navResult(components: NavComponent[], grossNavValue: number): NavResult {
  return {
    asOf: NOW,
    quoteCurrency: 'USD',
    components,
    grossNav: nav(grossNavValue),
    netNav: nav(grossNavValue),
  };
}

describe('calculateRebalancePlan — exact target (no drift)', () => {
  it('BTC 50 / ETH 50, current matches exactly -> requiresRebalance = false, orders = []', () => {
    const recipe = basketRecipe([
      recipeAsset({ symbol: 'BTC', address: BTC.address, weightBps: 5000 }),
      recipeAsset({ symbol: 'ETH', address: ETH.address, weightBps: 5000 }),
    ]);
    const result = navResult([component(BTC, 50000), component(ETH, 50000)], 100000);

    const plan = calculateRebalancePlan(recipe, result);

    expect(plan.requiresRebalance).toBe(false);
    expect(plan.orders).toEqual([]);
    expect(plan.allocations.find((a) => a.asset.address === BTC.address)?.driftBps).toBe(0);
    expect(plan.allocations.find((a) => a.asset.address === ETH.address)?.driftBps).toBe(0);
  });
});

describe('calculateRebalancePlan — threshold semantics', () => {
  it('drift under threshold (target 40, current 43, threshold 5) -> no rebalance', () => {
    const recipe = basketRecipe(
      [
        recipeAsset({ symbol: 'BTC', address: BTC.address, weightBps: 4000 }),
        recipeAsset({ symbol: 'ETH', address: ETH.address, weightBps: 6000 }),
      ],
      { ...DEFAULT_REBALANCE_RULE, driftThresholdBps: 500 }
    );
    const result = navResult([component(BTC, 43000), component(ETH, 57000)], 100000);

    const plan = calculateRebalancePlan(recipe, result);

    expect(plan.allocations.find((a) => a.asset.address === BTC.address)?.driftBps).toBe(300);
    expect(plan.requiresRebalance).toBe(false);
    expect(plan.orders).toEqual([]);
  });

  it('drift over threshold (target 40, current 46, threshold 5) -> rebalance, SELL BTC', () => {
    const recipe = basketRecipe(
      [
        recipeAsset({ symbol: 'BTC', address: BTC.address, weightBps: 4000 }),
        recipeAsset({ symbol: 'ETH', address: ETH.address, weightBps: 6000 }),
      ],
      { ...DEFAULT_REBALANCE_RULE, driftThresholdBps: 500 }
    );
    const result = navResult([component(BTC, 46000), component(ETH, 54000)], 100000);

    const plan = calculateRebalancePlan(recipe, result);

    expect(plan.allocations.find((a) => a.asset.address === BTC.address)?.driftBps).toBe(600);
    expect(plan.requiresRebalance).toBe(true);
    const btcOrder = plan.orders.find((o) => o.asset.address === BTC.address);
    expect(btcOrder?.side).toBe('SELL');
    expect(btcOrder?.value).toBe(nav(6000)); // 46000 -> target 40000
  });

  it('drift exactly AT the threshold does not trigger (strict >, not >=)', () => {
    const recipe = basketRecipe(
      [
        recipeAsset({ symbol: 'BTC', address: BTC.address, weightBps: 4000 }),
        recipeAsset({ symbol: 'ETH', address: ETH.address, weightBps: 6000 }),
      ],
      { ...DEFAULT_REBALANCE_RULE, driftThresholdBps: 500 }
    );
    // Current BTC = 45% -> drift = +500 bps, exactly the threshold.
    const result = navResult([component(BTC, 45000), component(ETH, 55000)], 100000);

    const plan = calculateRebalancePlan(recipe, result);

    expect(plan.allocations.find((a) => a.asset.address === BTC.address)?.driftBps).toBe(500);
    expect(plan.requiresRebalance).toBe(false);
    expect(plan.orders).toEqual([]);
  });
});

describe('calculateRebalancePlan — overweight / underweight', () => {
  it('underweight ETH (target 30, current 20) -> BUY ETH', () => {
    const recipe = basketRecipe([
      recipeAsset({ symbol: 'BTC', address: BTC.address, weightBps: 7000 }),
      recipeAsset({ symbol: 'ETH', address: ETH.address, weightBps: 3000 }),
    ]);
    const result = navResult([component(BTC, 80000), component(ETH, 20000)], 100000);

    const plan = calculateRebalancePlan(recipe, result);

    expect(plan.requiresRebalance).toBe(true);
    const ethOrder = plan.orders.find((o) => o.asset.address === ETH.address);
    expect(ethOrder?.side).toBe('BUY');
    expect(ethOrder?.value).toBe(nav(10000)); // 20000 -> target 30000
  });
});

describe('calculateRebalancePlan — new / missing target holding', () => {
  it('target SOL 10%, never held -> BUY SOL, quantityRaw is null (no price ever observed for it)', () => {
    const recipe = basketRecipe([
      recipeAsset({ symbol: 'BTC', address: BTC.address, weightBps: 9000, chain: 'ethereum' }),
      recipeAsset({ symbol: 'SOL', address: SOL.address, weightBps: 1000, chain: 'solana', decimals: 9 }),
    ]);
    // SOL has no NavComponent at all — it has never been held.
    const result = navResult([component(BTC, 100000)], 100000);

    const plan = calculateRebalancePlan(recipe, result);

    expect(plan.requiresRebalance).toBe(true);
    const solOrder = plan.orders.find((o) => o.asset.address === SOL.address);
    expect(solOrder?.side).toBe('BUY');
    expect(solOrder?.value).toBe(nav(10000));
    expect(solOrder?.quantityRaw).toBeNull();

    const solAllocation = plan.allocations.find((a) => a.asset.address === SOL.address);
    expect(solAllocation?.currentWeightBps).toBe(0);
    expect(solAllocation?.targetWeightBps).toBe(1000);
    expect(solAllocation?.driftBps).toBe(-1000);
  });
});

describe('calculateRebalancePlan — unexpected holding', () => {
  it('DOGE is held but not in the recipe -> implicit target 0, full SELL of its value', () => {
    const recipe = basketRecipe([recipeAsset({ symbol: 'BTC', address: BTC.address, weightBps: 10000 })]);
    const result = navResult([component(BTC, 92000), component(DOGE, 8000, 8, '0.5')], 100000);

    const plan = calculateRebalancePlan(recipe, result);

    const dogeAllocation = plan.allocations.find((a) => a.asset.address === DOGE.address);
    expect(dogeAllocation?.targetWeightBps).toBe(0);
    expect(dogeAllocation?.currentWeightBps).toBe(800);
    expect(dogeAllocation?.driftBps).toBe(800);

    expect(plan.requiresRebalance).toBe(true);
    const dogeOrder = plan.orders.find((o) => o.asset.address === DOGE.address);
    expect(dogeOrder?.side).toBe('SELL');
    expect(dogeOrder?.value).toBe(nav(8000)); // 100% of its current value
    // price = 0.5, value = 8000 -> quantity = 16000 units at 8 decimals
    expect(dogeOrder?.quantityRaw).toBe((BigInt(16000) * BigInt(10) ** BigInt(8)).toString());
  });
});

describe('calculateRebalancePlan — multiple assets', () => {
  it('BTC overweight, ETH underweight, USDC exact -> correct buy/sell orders, no order for USDC', () => {
    const recipe = basketRecipe([
      recipeAsset({ symbol: 'BTC', address: BTC.address, weightBps: 4000 }),
      recipeAsset({ symbol: 'ETH', address: ETH.address, weightBps: 3000 }),
      recipeAsset({ symbol: 'USDC', address: USDC.address, weightBps: 3000 }),
    ]);
    // BTC 50 (over), ETH 20 (under), USDC 30 (exact)
    const result = navResult([component(BTC, 50000), component(ETH, 20000), component(USDC, 30000)], 100000);

    const plan = calculateRebalancePlan(recipe, result);

    expect(plan.requiresRebalance).toBe(true);
    expect(plan.orders).toHaveLength(2);

    const btcOrder = plan.orders.find((o) => o.asset.address === BTC.address);
    const ethOrder = plan.orders.find((o) => o.asset.address === ETH.address);
    const usdcOrder = plan.orders.find((o) => o.asset.address === USDC.address);

    expect(btcOrder?.side).toBe('SELL');
    expect(btcOrder?.value).toBe(nav(10000));
    expect(ethOrder?.side).toBe('BUY');
    expect(ethOrder?.value).toBe(nav(10000));
    expect(usdcOrder).toBeUndefined();
  });
});

describe('calculateRebalancePlan — exact arithmetic', () => {
  it('handles large NAV/price/quantity values with no floating point loss', () => {
    const recipe = basketRecipe([
      recipeAsset({ symbol: 'BTC', address: BTC.address, weightBps: 5000, decimals: 8 }),
      recipeAsset({ symbol: 'ETH', address: ETH.address, weightBps: 5000, decimals: 18 }),
    ]);
    // Large, precision-hostile NAV: $987,654,321,098.123456789 total.
    const grossNav = '987654321098.123456789012345678';
    const btcValue = '600000000000.100000000000000001';
    const ethValue = '387654321098.023456789012345677';

    const result: NavResult = {
      asOf: NOW,
      quoteCurrency: 'USD',
      grossNav,
      netNav: grossNav,
      components: [
        { asset: BTC, quantityRaw: '1', decimals: 8, price: price(BTC, '1'), value: btcValue },
        { asset: ETH, quantityRaw: '1', decimals: 18, price: price(ETH, '1'), value: ethValue },
      ],
    };

    const plan = calculateRebalancePlan(recipe, result, { ...DEFAULT_REBALANCE_RULE, driftThresholdBps: 1 });

    // BTC is overweight relative to a clean 50/50 split of this odd NAV;
    // exact target = floor(grossNavScaled * 5000 / 10000), i.e. exactly
    // half of the scaled NAV bigint (with remainder distribution making up
    // any last-digit rounding). Rather than hand-deriving that string, just
    // assert the algebraic invariant that must hold regardless: BUY total
    // === SELL total, exactly.
    const buyTotal = plan.orders
      .filter((o) => o.side === 'BUY')
      .reduce((sum, o) => sum + BigInt(o.value.replace('.', '')), BigInt(0));
    const sellTotal = plan.orders
      .filter((o) => o.side === 'SELL')
      .reduce((sum, o) => sum + BigInt(o.value.replace('.', '')), BigInt(0));
    expect(plan.orders.length).toBeGreaterThan(0);
    expect(buyTotal).toBe(sellTotal);
  });
});

describe('calculateRebalancePlan — recipe weights invariant', () => {
  it('throws InvalidTargetWeightsError rather than silently producing wrong orders when weights do not sum to 100%', () => {
    const recipe = basketRecipe([
      recipeAsset({ symbol: 'BTC', address: BTC.address, weightBps: 4000 }),
      recipeAsset({ symbol: 'ETH', address: ETH.address, weightBps: 4000 }), // sums to 8000, not 10000
    ]);
    const result = navResult([component(BTC, 40000), component(ETH, 40000)], 80000);

    expect(() => calculateRebalancePlan(recipe, result)).toThrow(InvalidTargetWeightsError);
  });
});

describe('calculateRebalancePlan — zero NAV', () => {
  it('produces no orders and requiresRebalance = false regardless of nominal drift', () => {
    const recipe = basketRecipe([
      recipeAsset({ symbol: 'BTC', address: BTC.address, weightBps: 4000 }),
      recipeAsset({ symbol: 'ETH', address: ETH.address, weightBps: 6000 }),
    ]);
    const result = navResult([], 0);

    const plan = calculateRebalancePlan(recipe, result);

    expect(plan.requiresRebalance).toBe(false);
    expect(plan.orders).toEqual([]);
    expect(plan.allocations.every((a) => a.currentWeightBps === 0)).toBe(true);
  });
});

describe('calculateRebalancePlan — consistency (buy total === sell total)', () => {
  it('sums balance exactly across several drifted assets, not just approximately', () => {
    const recipe = basketRecipe([
      recipeAsset({ symbol: 'BTC', address: BTC.address, weightBps: 3333 }),
      recipeAsset({ symbol: 'ETH', address: ETH.address, weightBps: 3333 }),
      recipeAsset({ symbol: 'USDC', address: USDC.address, weightBps: 3334 }),
    ]);
    // Deliberately awkward NAV that doesn't divide evenly by 3.
    const result = navResult(
      [component(BTC, 500000), component(ETH, 300000), component(USDC, 200003)],
      1000003
    );

    const plan = calculateRebalancePlan(recipe, result, { ...DEFAULT_REBALANCE_RULE, driftThresholdBps: 1 });

    expect(plan.requiresRebalance).toBe(true);
    const buyTotal = plan.orders
      .filter((o) => o.side === 'BUY')
      .reduce((sum, o) => sum + BigInt(o.value.replace('.', '')), BigInt(0));
    const sellTotal = plan.orders
      .filter((o) => o.side === 'SELL')
      .reduce((sum, o) => sum + BigInt(o.value.replace('.', '')), BigInt(0));
    expect(buyTotal).toBe(sellTotal);
  });
});

describe('calculateRebalancePlan — deterministic output order', () => {
  it('allocations and orders are sorted by asset identity (chain:address), independent of input order', () => {
    const recipe = basketRecipe([
      recipeAsset({ symbol: 'ETH', address: ETH.address, weightBps: 5000 }),
      recipeAsset({ symbol: 'BTC', address: BTC.address, weightBps: 5000 }),
    ]);
    const result = navResult([component(ETH, 30000), component(BTC, 70000)], 100000);

    const planA = calculateRebalancePlan(recipe, result, { ...DEFAULT_REBALANCE_RULE, driftThresholdBps: 1 });

    const recipeReordered = basketRecipe([
      recipeAsset({ symbol: 'BTC', address: BTC.address, weightBps: 5000 }),
      recipeAsset({ symbol: 'ETH', address: ETH.address, weightBps: 5000 }),
    ]);
    const resultReordered = navResult([component(BTC, 70000), component(ETH, 30000)], 100000);
    const planB = calculateRebalancePlan(recipeReordered, resultReordered, {
      ...DEFAULT_REBALANCE_RULE,
      driftThresholdBps: 1,
    });

    expect(planA.allocations.map((a) => a.asset.address)).toEqual(planB.allocations.map((a) => a.asset.address));
    expect(planA.orders.map((o) => o.asset.address)).toEqual(planB.orders.map((o) => o.asset.address));
    // Sorted lexicographically by address: BTC's 0x1... sorts before ETH's 0x2...
    expect(planA.allocations.map((a) => a.asset.address)).toEqual([BTC.address, ETH.address]);
  });
});

describe('calculateRebalancePlan — integration with NAV shape', () => {
  it('copies asOf/quoteCurrency/nav straight from the NavResult, unmodified', () => {
    const recipe = basketRecipe([recipeAsset({ symbol: 'BTC', address: BTC.address, weightBps: 10000 })]);
    const result = navResult([component(BTC, 100000)], 100000);

    const plan = calculateRebalancePlan(recipe, result);

    expect(plan.asOf).toBe(result.asOf);
    expect(plan.quoteCurrency).toBe(result.quoteCurrency);
    expect(plan.nav).toBe(result.grossNav);
  });
});
