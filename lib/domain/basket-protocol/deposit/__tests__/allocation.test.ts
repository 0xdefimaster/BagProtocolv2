import { describe, expect, it } from 'vitest';
import { AssetIdentity, BasketRecipe, DEFAULT_REBALANCE_RULE, RecipeAsset } from '@/types/basket-protocol';
import { calculateDepositAllocation, InvalidDepositAmountRawError, InvalidRecipeWeightsError } from '../allocation';

// -----------------------------------------------------------------------------
// calculateDepositAllocation() is pure and synchronous — every test hand-
// builds a DepositRequest and a BasketRecipe, same convention as
// rebalance.test.ts.
// -----------------------------------------------------------------------------

const USDC: AssetIdentity = { chain: 'ethereum', address: '0x1000000000000000000000000000000000000c' };
const XNVDA: AssetIdentity = { chain: 'ethereum', address: '0x20000000000000000000000000000000000001' };
const XMSFT: AssetIdentity = { chain: 'ethereum', address: '0x20000000000000000000000000000000000002' };
const XAAPL: AssetIdentity = { chain: 'ethereum', address: '0x20000000000000000000000000000000000003' };
const ETH: AssetIdentity = { chain: 'ethereum', address: '0x0000000000000000000000000000000000000e' };
const BTC: AssetIdentity = { chain: 'ethereum', address: '0x20000000000000000000000000000000000004' };
const SOL_ETH_SAME_SYMBOL: AssetIdentity = { chain: 'solana', address: 'So11111111111111111111111111111111111112' };

const NOW = new Date('2026-01-01T12:00:00.000Z').toISOString();

function recipeAsset(overrides: Partial<RecipeAsset> & { symbol: string; address: string; weightBps: number }): RecipeAsset {
  return { chain: 'ethereum', decimals: 18, ...overrides };
}

function basketRecipe(assets: RecipeAsset[]): BasketRecipe {
  return {
    id: 'recipe_deposit_v1',
    bagId: 'bag_ai_tech',
    name: 'AI Tech',
    symbol: 'AITECH',
    description: 'Deposit allocation test fixture.',
    chain: 'ethereum',
    strategyType: 'STATIC_BASKET',
    assets,
    rebalanceRule: DEFAULT_REBALANCE_RULE,
    minInvestment: 0,
    maxAssets: 10,
    minWeightBps: 0,
    maxWeightBps: 10000,
    mutability: 'MUTABLE',
    version: 1,
    createdAt: NOW,
  };
}

describe('calculateDepositAllocation', () => {
  it('splits a basic 4-asset deposit exactly, matching the spec example', () => {
    const recipe = basketRecipe([
      recipeAsset({ symbol: 'xNVDA', address: XNVDA.address, weightBps: 4000 }),
      recipeAsset({ symbol: 'xMSFT', address: XMSFT.address, weightBps: 3000 }),
      recipeAsset({ symbol: 'xAAPL', address: XAAPL.address, weightBps: 2000 }),
      recipeAsset({ symbol: 'ETH', address: ETH.address, weightBps: 1000, decimals: 18 }),
    ]);

    const plan = calculateDepositAllocation(
      { bagId: 'bag_ai_tech', inputAsset: USDC, amountRaw: '100000000' }, // 100 USDC @ 6 decimals
      recipe
    );

    expect(plan.inputAmountRaw).toBe('100000000');
    expect(plan.allocations).toHaveLength(4);

    const bySymbol = Object.fromEntries(plan.allocations.map((a) => [a.targetSymbol, a]));
    expect(bySymbolValue(bySymbol, 'xNVDA')).toBe('40000000');
    expect(bySymbolValue(bySymbol, 'xMSFT')).toBe('30000000');
    expect(bySymbolValue(bySymbol, 'xAAPL')).toBe('20000000');
    expect(bySymbolValue(bySymbol, 'ETH')).toBe('10000000');

    expect(plan.allocations.every((a) => a.action === 'SWAP')).toBe(true);
    expect(plan.totalAllocatedRaw).toBe('100000000');
    expect(plan.unallocatedRaw).toBe('0');
  });

  it('marks the input asset itself as KEEP, never SWAP, when the target composition includes it', () => {
    const recipe = basketRecipe([
      recipeAsset({ symbol: 'BTC', address: BTC.address, weightBps: 4000 }),
      recipeAsset({ symbol: 'ETH', address: ETH.address, weightBps: 3000 }),
      recipeAsset({ symbol: 'USDC', address: USDC.address, weightBps: 3000, decimals: 6 }),
    ]);

    const plan = calculateDepositAllocation({ bagId: 'bag_x', inputAsset: USDC, amountRaw: '100000000' }, recipe);

    const usdcLine = plan.allocations.find((a) => a.targetSymbol === 'USDC')!;
    const btcLine = plan.allocations.find((a) => a.targetSymbol === 'BTC')!;
    const ethLine = plan.allocations.find((a) => a.targetSymbol === 'ETH')!;

    expect(usdcLine.action).toBe('KEEP');
    expect(usdcLine.valueRaw).toBe('30000000');
    expect(btcLine.action).toBe('SWAP');
    expect(btcLine.valueRaw).toBe('40000000');
    expect(ethLine.action).toBe('SWAP');
    expect(ethLine.valueRaw).toBe('30000000');

    expect(plan.unallocatedRaw).toBe('0');
  });

  it('allocates 100% to a single target', () => {
    const recipe = basketRecipe([recipeAsset({ symbol: 'ETH', address: ETH.address, weightBps: 10000 })]);
    const plan = calculateDepositAllocation({ bagId: 'bag_x', inputAsset: USDC, amountRaw: '100000000' }, recipe);

    expect(plan.allocations).toHaveLength(1);
    expect(plan.allocations[0].valueRaw).toBe('100000000');
    expect(plan.allocations[0].action).toBe('SWAP');
    expect(plan.unallocatedRaw).toBe('0');
  });

  it('produces a zero-value line (not an error, not an omission) for a 0%-weight target', () => {
    const recipe = basketRecipe([
      recipeAsset({ symbol: 'ETH', address: ETH.address, weightBps: 10000 }),
      recipeAsset({ symbol: 'BTC', address: BTC.address, weightBps: 0 }),
    ]);
    const plan = calculateDepositAllocation({ bagId: 'bag_x', inputAsset: USDC, amountRaw: '100000000' }, recipe);

    const btcLine = plan.allocations.find((a) => a.targetSymbol === 'BTC')!;
    expect(btcLine.valueRaw).toBe('0');
    expect(plan.allocations).toHaveLength(2);
  });

  it('distributes rounding residue via largest-remainder so the sum is always EXACT', () => {
    // 100000001 split 3-ways (33.33...%) forces a non-exact floor division.
    const recipe = basketRecipe([
      recipeAsset({ symbol: 'A', address: XNVDA.address, weightBps: 3334 }),
      recipeAsset({ symbol: 'B', address: XMSFT.address, weightBps: 3333 }),
      recipeAsset({ symbol: 'C', address: XAAPL.address, weightBps: 3333 }),
    ]);
    const plan = calculateDepositAllocation({ bagId: 'bag_x', inputAsset: USDC, amountRaw: '100000001' }, recipe);

    const sum = plan.allocations.reduce((s, a) => s + BigInt(a.valueRaw), BigInt(0));
    expect(sum.toString()).toBe('100000001');
    expect(plan.totalAllocatedRaw).toBe('100000001');
    expect(plan.unallocatedRaw).toBe('0');
  });

  it('holds exact under a large bigint amount', () => {
    const recipe = basketRecipe([
      recipeAsset({ symbol: 'A', address: XNVDA.address, weightBps: 6667 }),
      recipeAsset({ symbol: 'B', address: XMSFT.address, weightBps: 3333 }),
    ]);
    const huge = '123456789012345678901234567890';
    const plan = calculateDepositAllocation({ bagId: 'bag_x', inputAsset: USDC, amountRaw: huge }, recipe);

    const sum = plan.allocations.reduce((s, a) => s + BigInt(a.valueRaw), BigInt(0));
    expect(sum.toString()).toBe(huge);
    expect(plan.unallocatedRaw).toBe('0');
  });

  it('treats the same symbol on a different chain as a different asset (never matched to KEEP by symbol)', () => {
    const recipe = basketRecipe([
      recipeAsset({ symbol: 'USDC', address: SOL_ETH_SAME_SYMBOL.address, chain: 'solana', weightBps: 5000, decimals: 6 }),
      recipeAsset({ symbol: 'ETH', address: ETH.address, weightBps: 5000 }),
    ]);
    // Deposit is Ethereum USDC — the recipe's "USDC" is a Solana asset with the same symbol, a different identity.
    const plan = calculateDepositAllocation({ bagId: 'bag_x', inputAsset: USDC, amountRaw: '100000000' }, recipe);

    const solUsdcLine = plan.allocations.find((a) => a.targetSymbol === 'USDC')!;
    expect(solUsdcLine.action).toBe('SWAP'); // not KEEP — different chain, different identity
  });

  it('rejects a recipe whose weights do not sum to 100%', () => {
    const recipe = basketRecipe([
      recipeAsset({ symbol: 'ETH', address: ETH.address, weightBps: 4000 }),
      recipeAsset({ symbol: 'BTC', address: BTC.address, weightBps: 4000 }),
    ]);
    expect(() => calculateDepositAllocation({ bagId: 'bag_x', inputAsset: USDC, amountRaw: '100000000' }, recipe)).toThrow(
      InvalidRecipeWeightsError
    );
  });

  it('rejects a non-integer / negative / malformed amountRaw', () => {
    const recipe = basketRecipe([recipeAsset({ symbol: 'ETH', address: ETH.address, weightBps: 10000 })]);
    for (const bad of ['100.5', '-100', 'abc', '', ' ', '1e5']) {
      expect(() => calculateDepositAllocation({ bagId: 'bag_x', inputAsset: USDC, amountRaw: bad }, recipe)).toThrow(
        InvalidDepositAmountRawError
      );
    }
  });

  it('handles a zero deposit amount deterministically (every line zero, no throw)', () => {
    const recipe = basketRecipe([
      recipeAsset({ symbol: 'ETH', address: ETH.address, weightBps: 6000 }),
      recipeAsset({ symbol: 'BTC', address: BTC.address, weightBps: 4000 }),
    ]);
    const plan = calculateDepositAllocation({ bagId: 'bag_x', inputAsset: USDC, amountRaw: '0' }, recipe);
    expect(plan.allocations.every((a) => a.valueRaw === '0')).toBe(true);
    expect(plan.unallocatedRaw).toBe('0');
  });
});

function bySymbolValue(byLine: Record<string, { valueRaw: string }>, symbol: string): string {
  return byLine[symbol].valueRaw;
}
