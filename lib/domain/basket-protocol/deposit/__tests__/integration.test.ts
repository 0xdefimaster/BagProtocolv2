import { describe, expect, it } from 'vitest';
import { AssetIdentity, BasketRecipe, DEFAULT_REBALANCE_RULE, RecipeAsset } from '@/types/basket-protocol';
import { calculateDepositAllocation } from '../allocation';
import { buildExecutionPlan } from '../execution-plan';
import { mockExecutionAdapter } from '@/lib/blockchain/mock-execution-adapter';

// -----------------------------------------------------------------------------
// Spec section 18 — the full pipeline this phase's Definition of Done
// requires:
//
//   Bag → Recipe → DepositRequest → calculateDepositAllocation()
//     → DepositPlan → buildExecutionPlan() → ExecutionPlan
//     → ExecutionAdapter.quoteExecutionPlan() → ExecutionResult (mock only)
//
// No blockchain call, no real swap, anywhere in this test — `mockExecutionAdapter`
// is the only adapter exercised (spec section 21).
// -----------------------------------------------------------------------------

const USDC: AssetIdentity = { chain: 'ethereum', address: '0x1000000000000000000000000000000000000c' };

function asset(symbol: string, address: string, weightBps: number, decimals = 18): RecipeAsset {
  return { chain: 'ethereum', address, symbol, decimals, weightBps };
}

function recipe(assets: RecipeAsset[]): BasketRecipe {
  return {
    id: 'recipe_ai_tech_v1',
    bagId: 'AI-TECH',
    name: 'AI Tech',
    symbol: 'AITECH',
    description: 'Integration test fixture.',
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
    createdAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
  };
}

describe('deposit pipeline integration', () => {
  it('AI-TECH example: 100 USDC → 4 execution steps, exact sum = 100 USDC', async () => {
    const aiTechRecipe = recipe([
      asset('xNVDA', '0x2000000000000000000000000000000000000a', 4000),
      asset('xMSFT', '0x2000000000000000000000000000000000000b', 3000),
      asset('xAAPL', '0x2000000000000000000000000000000000000c', 2000),
      asset('ETH', '0x0000000000000000000000000000000000000e', 1000),
    ]);

    const depositPlan = calculateDepositAllocation(
      { bagId: 'AI-TECH', inputAsset: USDC, amountRaw: '100000000' },
      aiTechRecipe
    );

    expect(depositPlan.allocations).toHaveLength(4);
    const sum = depositPlan.allocations.reduce((s, a) => s + BigInt(a.valueRaw), BigInt(0));
    expect(sum.toString()).toBe('100000000');
    expect(depositPlan.unallocatedRaw).toBe('0');

    const executionPlan = buildExecutionPlan(depositPlan);
    expect(executionPlan.steps).toHaveLength(4);
    expect(executionPlan.steps.every((s) => s.action === 'SWAP')).toBe(true);

    const result = await mockExecutionAdapter.quoteExecutionPlan(executionPlan);
    expect(result.steps).toHaveLength(4);
    expect(result.steps.every((s) => s.quote !== null)).toBe(true);
  });

  it('input-already-in-recipe example: 100 USDC deposit → 2 swap steps + 1 KEEP', async () => {
    const bagRecipe = recipe([
      asset('xNVDA', '0x2000000000000000000000000000000000000a', 4000),
      asset('ETH', '0x0000000000000000000000000000000000000e', 3000),
      asset('USDC', USDC.address, 3000, 6),
    ]);

    const depositPlan = calculateDepositAllocation(
      { bagId: 'bag_x', inputAsset: USDC, amountRaw: '100000000' },
      bagRecipe
    );
    const executionPlan = buildExecutionPlan(depositPlan);

    const swapSteps = executionPlan.steps.filter((s) => s.action === 'SWAP');
    const keepSteps = executionPlan.steps.filter((s) => s.action === 'KEEP');
    expect(swapSteps).toHaveLength(2);
    expect(keepSteps).toHaveLength(1);

    const result = await mockExecutionAdapter.quoteExecutionPlan(executionPlan);
    const keepResult = result.steps.find((s) => s.step.action === 'KEEP')!;
    expect(keepResult.quote).toBeNull(); // KEEP steps are never quoted/swapped
    const swapResults = result.steps.filter((s) => s.step.action === 'SWAP');
    expect(swapResults.every((s) => s.quote !== null)).toBe(true);
  });
});
