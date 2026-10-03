import { ExecutionPlan } from '@/types/basket-protocol';
import { ExecutionAdapter, ExecutionResult, ExecutionStepQuote, ExecutionStepResult } from './execution-adapter';

// -----------------------------------------------------------------------------
// Mock execution adapter — Phase 10's only `ExecutionAdapter`
// implementation. Simulates latency and returns a DETERMINISTIC quote per
// step; never touches an RPC, never builds/signs/sends a transaction,
// never requests a wallet approval, never bridges (spec section 9/21).
//
// `outputAmountRaw` here is intentionally NOT a real swap-rate conversion
// — it deliberately does not import `PriceProvider` or anything price-
// related (spec section 15: NAV/swap-quote price feeds and this mock must
// never be conflated, so this mock doesn't reach for either). It exists so
// `ExecutionAdapter`'s shape can be exercised end-to-end — by tests, and
// by a future UI preview — before a real router is wired in. A future
// `LiFiExecutionAdapter` implementing the same interface is what supplies
// an actual, price-aware quantity (spec section 10).
// -----------------------------------------------------------------------------

function quoteStep(inputAmountRaw: string): ExecutionStepQuote {
  const outputAmountRaw = inputAmountRaw;
  return {
    provider: 'mock',
    // Deliberately the same raw integer as the input value — see this
    // file's module doc for why this is NOT meant to represent a real
    // exchange rate.
    outputAmountRaw,
    outputDecimals: 18,
    slippageBps: 0,
    protocolFeeRaw: '0',
    executionFeeRaw: '0',
    // slippageBps is 0, so minOutputRaw === outputAmountRaw exactly — not a
    // fabricated figure, just what 0 slippage means.
    minOutputRaw: outputAmountRaw,
    route: 'mock',
    // Never populated by this adapter — see execution-adapter.ts's module
    // doc on why this stays null even for a live provider today.
    priceImpact: null,
    // This mock never estimates gas — null, not a made-up number.
    gasCostRaw: null,
    gasCostAsset: null,
    timestamp: new Date().toISOString(),
  };
}

export const mockExecutionAdapter: ExecutionAdapter = {
  name: 'mock',
  isLive: false,

  async quoteExecutionPlan(plan: ExecutionPlan): Promise<ExecutionResult> {
    await new Promise((r) => setTimeout(r, 250));

    const steps: ExecutionStepResult[] = plan.steps.map((step) => ({
      step,
      // KEEP steps are never swapped — nothing to quote (see
      // execution-plan.ts's module doc for why a KEEP step still exists
      // in `plan.steps` at all).
      quote: step.action === 'KEEP' ? null : quoteStep(step.route.inputAmountRaw),
      // This mock never fails a quote — `error` only ever fires for a real
      // provider (see lifi-execution-adapter.ts).
      error: null,
    }));

    return {
      bagId: plan.bagId,
      inputAsset: plan.inputAsset,
      inputAmountRaw: plan.inputAmountRaw,
      steps,
      unallocatedRaw: plan.unallocatedRaw,
    };
  },
};

// Swap this export for a real adapter (e.g. LiFiExecutionAdapter) once
// route integration begins — nothing else in the codebase needs to
// change. Mirrors mock-adapter.ts's own `blockchainAdapter` export
// convention.
export const executionAdapter: ExecutionAdapter = mockExecutionAdapter;
