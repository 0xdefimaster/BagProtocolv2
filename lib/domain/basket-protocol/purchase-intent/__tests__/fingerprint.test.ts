import { describe, expect, it } from 'vitest';
import { computeExecutionPlanFingerprint } from '../fingerprint';
import { ExecutionPlan } from '@/types/basket-protocol';

const USDC = { chain: 'ethereum' as const, address: '0xusdc' };
const NVDA = { chain: 'ethereum' as const, address: '0xnvda' };

function plan(overrides: Partial<ExecutionPlan> = {}): ExecutionPlan {
  return {
    bagId: 'bag-1',
    inputAsset: USDC,
    inputAmountRaw: '100000000',
    unallocatedRaw: '0',
    steps: [
      {
        action: 'SWAP',
        targetSymbol: 'xNVDA',
        route: {
          inputAsset: USDC,
          inputAmountRaw: '100000000',
          outputAsset: NVDA,
          targetValueRaw: '100000000',
          sourceChain: 'ethereum',
          destinationChain: 'ethereum',
        },
      },
    ],
    ...overrides,
  };
}

describe('computeExecutionPlanFingerprint', () => {
  it('is deterministic for the same plan', () => {
    expect(computeExecutionPlanFingerprint(plan())).toBe(computeExecutionPlanFingerprint(plan()));
  });

  it('changes when the input amount changes', () => {
    const a = computeExecutionPlanFingerprint(plan());
    const b = computeExecutionPlanFingerprint(plan({ inputAmountRaw: '200000000' }));
    expect(a).not.toBe(b);
  });

  it('changes when a step is added (recipe changed)', () => {
    const a = computeExecutionPlanFingerprint(plan());
    const withExtraStep = plan({
      steps: [
        ...plan().steps,
        {
          action: 'KEEP',
          targetSymbol: 'USDC',
          route: {
            inputAsset: USDC,
            inputAmountRaw: '0',
            outputAsset: USDC,
            targetValueRaw: '0',
            sourceChain: 'ethereum',
            destinationChain: 'ethereum',
          },
        },
      ],
    });
    const b = computeExecutionPlanFingerprint(withExtraStep);
    expect(a).not.toBe(b);
  });

  it('changes when the output asset address changes', () => {
    const a = computeExecutionPlanFingerprint(plan());
    const b = computeExecutionPlanFingerprint(
      plan({
        steps: [
          {
            action: 'SWAP',
            targetSymbol: 'xNVDA',
            route: {
              inputAsset: USDC,
              inputAmountRaw: '100000000',
              outputAsset: { chain: 'ethereum', address: '0xdifferent' },
              targetValueRaw: '100000000',
              sourceChain: 'ethereum',
              destinationChain: 'ethereum',
            },
          },
        ],
      })
    );
    expect(a).not.toBe(b);
  });

  it('is a hex sha256 digest', () => {
    expect(computeExecutionPlanFingerprint(plan())).toMatch(/^[0-9a-f]{64}$/);
  });
});
