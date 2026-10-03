import { describe, expect, it } from 'vitest';
import { ExecutionPlan } from '@/types/basket-protocol';
import { mockExecutionAdapter } from '../mock-execution-adapter';

// -----------------------------------------------------------------------------
// Phase 14 — MockExecutionAdapter grew several new ExecutionStepQuote fields
// (minOutputRaw, route, priceImpact, gasCostRaw/gasCostAsset, timestamp) and
// ExecutionStepResult grew `error`. This only re-asserts the NEW shape and
// the "never fabricate" fields — the pre-existing behavior (deterministic
// output, KEEP -> null quote) is already covered by execution-plan.test.ts's
// companion suite and unchanged here.
// -----------------------------------------------------------------------------

const USDC = { chain: 'ethereum' as const, address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' };
const NVDA = { chain: 'ethereum' as const, address: '0x1111111111111111111111111111111111111111' };

function plan(): ExecutionPlan {
  return {
    bagId: 'bag_1',
    inputAsset: USDC,
    inputAmountRaw: '100000000',
    steps: [
      {
        action: 'SWAP',
        targetSymbol: 'xNVDA',
        route: {
          inputAsset: USDC,
          inputAmountRaw: '40000000',
          outputAsset: NVDA,
          targetValueRaw: '40000000',
          sourceChain: 'ethereum',
          destinationChain: 'ethereum',
        },
      },
      {
        action: 'KEEP',
        targetSymbol: 'USDC',
        route: {
          inputAsset: USDC,
          inputAmountRaw: '30000000',
          outputAsset: USDC,
          targetValueRaw: '30000000',
          sourceChain: 'ethereum',
          destinationChain: 'ethereum',
        },
      },
    ],
    unallocatedRaw: '0',
  };
}

describe('mockExecutionAdapter — Phase 14 shape', () => {
  it('SWAP step: minOutputRaw equals outputAmountRaw (0 slippage), priceImpact/gas fields stay null, never fabricated', async () => {
    const result = await mockExecutionAdapter.quoteExecutionPlan(plan());
    const swap = result.steps.find((s) => s.step.action === 'SWAP');

    expect(swap?.error).toBeNull();
    expect(swap?.quote?.minOutputRaw).toBe(swap?.quote?.outputAmountRaw);
    expect(swap?.quote?.priceImpact).toBeNull();
    expect(swap?.quote?.gasCostRaw).toBeNull();
    expect(swap?.quote?.gasCostAsset).toBeNull();
    expect(swap?.quote?.route).toBe('mock');
    expect(typeof swap?.quote?.timestamp).toBe('string');
  });

  it('KEEP step: quote and error both null (nothing attempted, not a failure)', async () => {
    const result = await mockExecutionAdapter.quoteExecutionPlan(plan());
    const keep = result.steps.find((s) => s.step.action === 'KEEP');

    expect(keep?.quote).toBeNull();
    expect(keep?.error).toBeNull();
  });
});
