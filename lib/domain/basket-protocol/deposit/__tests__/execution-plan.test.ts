import { describe, expect, it } from 'vitest';
import { DepositPlan } from '@/types/basket-protocol';
import { buildExecutionPlan } from '../execution-plan';

function depositPlan(overrides: Partial<DepositPlan> = {}): DepositPlan {
  return {
    bagId: 'bag_x',
    inputAsset: { chain: 'ethereum', address: '0x1000000000000000000000000000000000000c' },
    inputAmountRaw: '100000000',
    allocations: [
      {
        targetAsset: { chain: 'ethereum', address: '0x2000000000000000000000000000000000000n' },
        targetSymbol: 'xNVDA',
        targetDecimals: 18,
        targetWeightBps: 4000,
        valueRaw: '40000000',
        action: 'SWAP',
      },
      {
        targetAsset: { chain: 'ethereum', address: '0x1000000000000000000000000000000000000c' },
        targetSymbol: 'USDC',
        targetDecimals: 6,
        targetWeightBps: 3000,
        valueRaw: '30000000',
        action: 'KEEP',
      },
      {
        targetAsset: { chain: 'ethereum', address: '0x2000000000000000000000000000000000000z' },
        targetSymbol: 'ZERO',
        targetDecimals: 18,
        targetWeightBps: 0,
        valueRaw: '0',
        action: 'SWAP',
      },
    ],
    totalAllocatedRaw: '70000000',
    unallocatedRaw: '0',
    ...overrides,
  };
}

describe('buildExecutionPlan', () => {
  it('produces one step per nonzero allocation, in both SWAP and KEEP flavors', () => {
    const plan = buildExecutionPlan(depositPlan());
    expect(plan.steps).toHaveLength(2); // xNVDA (SWAP) + USDC (KEEP) — ZERO's 0-value line is skipped

    const swapStep = plan.steps.find((s) => s.action === 'SWAP')!;
    const keepStep = plan.steps.find((s) => s.action === 'KEEP')!;

    expect(swapStep.targetSymbol).toBe('xNVDA');
    expect(swapStep.route.inputAmountRaw).toBe('40000000');
    expect(swapStep.route.targetValueRaw).toBe('40000000');
    expect(swapStep.route.outputAsset.address).toBe('0x2000000000000000000000000000000000000n');
    expect(swapStep.route.sourceChain).toBe('ethereum');
    expect(swapStep.route.destinationChain).toBe('ethereum');

    expect(keepStep.targetSymbol).toBe('USDC');
    expect(keepStep.route.inputAmountRaw).toBe('30000000');
  });

  it('skips a 0%-weight target entirely — no execution step is produced', () => {
    const plan = buildExecutionPlan(depositPlan());
    expect(plan.steps.some((s) => s.targetSymbol === 'ZERO')).toBe(false);
  });

  it('carries bagId/inputAsset/inputAmountRaw/unallocatedRaw through unchanged', () => {
    const dp = depositPlan();
    const plan = buildExecutionPlan(dp);
    expect(plan.bagId).toBe(dp.bagId);
    expect(plan.inputAsset).toEqual(dp.inputAsset);
    expect(plan.inputAmountRaw).toBe(dp.inputAmountRaw);
    expect(plan.unallocatedRaw).toBe(dp.unallocatedRaw);
  });

  it('supports a different destination chain per target (multi-chain)', () => {
    const dp = depositPlan({
      allocations: [
        {
          targetAsset: { chain: 'base', address: '0x2000000000000000000000000000000000000b' },
          targetSymbol: 'BASE_ASSET',
          targetDecimals: 18,
          targetWeightBps: 10000,
          valueRaw: '100000000',
          action: 'SWAP',
        },
      ],
    });
    const plan = buildExecutionPlan(dp);
    expect(plan.steps[0].route.sourceChain).toBe('ethereum');
    expect(plan.steps[0].route.destinationChain).toBe('base');
  });

  it('produces zero steps when every allocation is zero-value', () => {
    const dp = depositPlan({
      allocations: [
        {
          targetAsset: { chain: 'ethereum', address: '0x2000000000000000000000000000000000000n' },
          targetSymbol: 'xNVDA',
          targetDecimals: 18,
          targetWeightBps: 0,
          valueRaw: '0',
          action: 'SWAP',
        },
      ],
      inputAmountRaw: '0',
    });
    const plan = buildExecutionPlan(dp);
    expect(plan.steps).toHaveLength(0);
  });
});
