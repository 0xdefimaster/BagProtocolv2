import { describe, expect, it } from 'vitest';
import { ExecutionPlan } from '@/types/basket-protocol';
import { CompiledExecution } from '../types';
import { compiledExecutionToPurchaseIntentSteps } from '../purchase-intent-bridge';

// -----------------------------------------------------------------------------
// Bag Router execution hardening, checkpoint 1 — provider identity.
//
// The bug this file exists to pin down: `compiled.mode === 'SINGLE_TX'` is
// true for BOTH `lifi-composer` and `bag-router` (both compile to one
// shared transaction), so using `mode` as the ONLY discriminator silently
// mapped a BAG Router result into the Composer branch. That's wrong on
// every axis a BAG Router step actually needs: Composer's branch treats a
// leg's output as a non-enforced SIMULATION (`outputDecimals: null`,
// `minOutputRaw: null`), while the BAG Router contract enforces a REAL
// on-chain minimum for every leg — and a `null` `outputDecimals` step is
// silently excluded from accounting (purchase-execution.ts). These tests
// assert the fix: branching on `compiled.providerId`, never `mode`.
// -----------------------------------------------------------------------------

const USDC = { chain: 'ethereum' as const, address: '0xusdc' };
const NVDA = { chain: 'ethereum' as const, address: '0xnvda' };
const AAPL = { chain: 'ethereum' as const, address: '0xaapl' };

function plan(): ExecutionPlan {
  return {
    bagId: 'bag_1',
    inputAsset: USDC,
    inputAmountRaw: '100000000',
    unallocatedRaw: '0',
    steps: [
      {
        action: 'SWAP',
        targetSymbol: 'NVDA',
        route: {
          inputAsset: USDC,
          inputAmountRaw: '60000000',
          outputAsset: NVDA,
          targetValueRaw: '60000000',
          sourceChain: 'ethereum',
          destinationChain: 'ethereum',
        },
      },
      {
        action: 'SWAP',
        targetSymbol: 'AAPL',
        route: {
          inputAsset: USDC,
          inputAmountRaw: '40000000',
          outputAsset: AAPL,
          targetValueRaw: '40000000',
          sourceChain: 'ethereum',
          destinationChain: 'ethereum',
        },
      },
    ],
  };
}

const alwaysResolveDecimalsTo18 = () => 18;

describe('compiledExecutionToPurchaseIntentSteps — explicit provider identity', () => {
  it('a bag-router SINGLE_TX result never maps into composerTransaction, even though mode === SINGLE_TX', () => {
    const compiled: CompiledExecution = {
      mode: 'SINGLE_TX',
      chainId: 4663,
      transactions: [{ to: '0xRouter', data: '0xexecutecalldata', value: '0', chainId: 4663 }],
      expectedOutputs: [
        { legId: 'leg_0', asset: NVDA, quotedOutputRaw: '9950000000000000000', quotedOutputBasis: 'PROVIDER_QUOTE', minimumGuaranteedOutputRaw: '9950000000000000000' },
        { legId: 'leg_1', asset: AAPL, quotedOutputRaw: '3950000000000000000', quotedOutputBasis: 'PROVIDER_QUOTE', minimumGuaranteedOutputRaw: '3950000000000000000' },
      ],
      providerId: 'bag-router',
      executionPlanHash: 'hash-bag-router',
      providerMetadata: {
        routerAddress: '0xRouter',
        signedPlan: { bagId: '0xOnChainBagId' },
      },
    };

    const result = compiledExecutionToPurchaseIntentSteps(plan(), compiled, 6, alwaysResolveDecimalsTo18);

    expect(result.composerTransaction).toBeNull();
    expect(result.bagRouterTransaction).toEqual({
      to: '0xRouter',
      data: '0xexecutecalldata',
      value: '0',
      chainId: 4663,
      inputToken: USDC.address,
      inputAmountRaw: '100000000',
      bagOnChainId: '0xOnChainBagId',
    });
  });

  it('a lifi-composer SINGLE_TX result never maps into bagRouterTransaction', () => {
    const compiled: CompiledExecution = {
      mode: 'SINGLE_TX',
      chainId: 1,
      transactions: [{ to: '0xComposerRouter', data: '0xdeadbeef', value: '0', chainId: 1 }],
      expectedOutputs: [
        { legId: 'leg_0', asset: NVDA, quotedOutputRaw: '10000000000000000000', quotedOutputBasis: 'SIMULATION', minimumGuaranteedOutputRaw: null },
        { legId: 'leg_1', asset: AAPL, quotedOutputRaw: '4000000000000000000', quotedOutputBasis: 'SIMULATION', minimumGuaranteedOutputRaw: null },
      ],
      providerId: 'lifi-composer',
      executionPlanHash: 'hash-composer',
      providerMetadata: { userProxy: '0xProxy' },
    };

    const result = compiledExecutionToPurchaseIntentSteps(plan(), compiled, 6, alwaysResolveDecimalsTo18);

    expect(result.bagRouterTransaction).toBeNull();
    expect(result.composerTransaction).toEqual({
      to: '0xComposerRouter',
      data: '0xdeadbeef',
      value: '0',
      chainId: 1,
      userProxy: '0xProxy',
      approvals: [],
    });
  });

  it('a lifi-composer step carries real outputDecimals so accounting credits its holdings', () => {
    const compiled: CompiledExecution = {
      mode: 'SINGLE_TX',
      chainId: 1,
      transactions: [{ to: '0xComposerRouter', data: '0xdeadbeef', value: '0', chainId: 1 }],
      expectedOutputs: [
        { legId: 'leg_0', asset: NVDA, quotedOutputRaw: '10000000000000000000', quotedOutputBasis: 'SIMULATION', minimumGuaranteedOutputRaw: null },
        { legId: 'leg_1', asset: AAPL, quotedOutputRaw: '4000000000000000000', quotedOutputBasis: 'SIMULATION', minimumGuaranteedOutputRaw: null },
      ],
      providerId: 'lifi-composer',
      executionPlanHash: 'hash-composer',
      providerMetadata: { userProxy: '0xProxy' },
    };

    const result = compiledExecutionToPurchaseIntentSteps(plan(), compiled, 6, alwaysResolveDecimalsTo18);

    const swaps = result.steps.filter((s) => s.action === 'SWAP');
    expect(swaps.length).toBeGreaterThan(0);
    expect(swaps.every((s) => s.outputDecimals === 18 && s.status === 'PENDING')).toBe(true);
    expect(result.allSwapsQuoted).toBe(true);
  });

  it('never persists a null outputDecimals for a lifi-composer step — an unresolvable asset fails the leg', () => {
    const compiled: CompiledExecution = {
      mode: 'SINGLE_TX',
      chainId: 1,
      transactions: [{ to: '0xComposerRouter', data: '0xdeadbeef', value: '0', chainId: 1 }],
      expectedOutputs: [
        { legId: 'leg_0', asset: NVDA, quotedOutputRaw: '10000000000000000000', quotedOutputBasis: 'SIMULATION', minimumGuaranteedOutputRaw: null },
        { legId: 'leg_1', asset: AAPL, quotedOutputRaw: '4000000000000000000', quotedOutputBasis: 'SIMULATION', minimumGuaranteedOutputRaw: null },
      ],
      providerId: 'lifi-composer',
      executionPlanHash: 'hash-composer',
      providerMetadata: { userProxy: '0xProxy' },
    };

    const result = compiledExecutionToPurchaseIntentSteps(plan(), compiled, 6, () => null);

    expect(result.allSwapsQuoted).toBe(false);
    expect(result.steps.every((s) => s.action !== 'SWAP' || s.status === 'FAILED')).toBe(true);
    expect(result.firstFailure?.failureCode).toBe('PROVIDER_ERROR');
  });

  it('a bag-router step carries a REAL, non-null outputDecimals/minOutputRaw — unlike Composer, whose figure is a non-enforced simulation', () => {
    const compiled: CompiledExecution = {
      mode: 'SINGLE_TX',
      chainId: 4663,
      transactions: [{ to: '0xRouter', data: '0xexecutecalldata', value: '0', chainId: 4663 }],
      expectedOutputs: [
        { legId: 'leg_0', asset: NVDA, quotedOutputRaw: '9950000000000000000', quotedOutputBasis: 'PROVIDER_QUOTE', minimumGuaranteedOutputRaw: '9950000000000000000' },
        { legId: 'leg_1', asset: AAPL, quotedOutputRaw: '3950000000000000000', quotedOutputBasis: 'PROVIDER_QUOTE', minimumGuaranteedOutputRaw: '3950000000000000000' },
      ],
      providerId: 'bag-router',
      executionPlanHash: 'hash-bag-router',
      providerMetadata: { routerAddress: '0xRouter', signedPlan: { bagId: '0xOnChainBagId' } },
    };

    const result = compiledExecutionToPurchaseIntentSteps(plan(), compiled, 6, alwaysResolveDecimalsTo18);

    expect(result.steps[0]).toMatchObject({
      action: 'SWAP',
      status: 'PENDING',
      outputAmountRaw: '9950000000000000000',
      outputDecimals: 18,
      minOutputRaw: '9950000000000000000',
      route: null,
      lifiStep: null,
    });
    expect(result.steps[1]).toMatchObject({ outputDecimals: 18, minOutputRaw: '3950000000000000000' });
    expect(result.allSwapsQuoted).toBe(true);
  });

  it('never persists a null outputDecimals for a bag-router step — a resolver failure is treated as a genuine leg failure, not silently defaulted', () => {
    const compiled: CompiledExecution = {
      mode: 'SINGLE_TX',
      chainId: 4663,
      transactions: [{ to: '0xRouter', data: '0xexecutecalldata', value: '0', chainId: 4663 }],
      expectedOutputs: [
        { legId: 'leg_0', asset: NVDA, quotedOutputRaw: '9950000000000000000', quotedOutputBasis: 'PROVIDER_QUOTE', minimumGuaranteedOutputRaw: '9950000000000000000' },
        { legId: 'leg_1', asset: AAPL, quotedOutputRaw: '3950000000000000000', quotedOutputBasis: 'PROVIDER_QUOTE', minimumGuaranteedOutputRaw: '3950000000000000000' },
      ],
      providerId: 'bag-router',
      executionPlanHash: 'hash-bag-router',
      providerMetadata: { routerAddress: '0xRouter', signedPlan: { bagId: '0xOnChainBagId' } },
    };

    const result = compiledExecutionToPurchaseIntentSteps(plan(), compiled, 6, () => null);

    expect(result.allSwapsQuoted).toBe(false);
    expect(result.steps.every((s) => s.action !== 'SWAP' || (s.status === 'FAILED' && s.outputDecimals === null))).toBe(true);
    expect(result.firstFailure?.failureCode).toBe('PROVIDER_ERROR');
  });

  it('a lifi-sequential (MULTI_TX) result is unaffected — still maps providerMetadata.legResults, both transaction summaries stay null', () => {
    const compiled: CompiledExecution = {
      mode: 'MULTI_TX',
      chainId: 1,
      transactions: [],
      expectedOutputs: [
        { legId: 'leg_0', asset: NVDA, quotedOutputRaw: '9900000000000000000', quotedOutputBasis: 'PROVIDER_QUOTE', minimumGuaranteedOutputRaw: '9900000000000000000' },
        { legId: 'leg_1', asset: AAPL, quotedOutputRaw: '3900000000000000000', quotedOutputBasis: 'PROVIDER_QUOTE', minimumGuaranteedOutputRaw: '3900000000000000000' },
      ],
      providerId: 'lifi-sequential',
      executionPlanHash: 'hash-sequential',
      providerMetadata: {
        legResults: {
          leg_0: { ok: true, outputAmountRaw: '10000000000000000000', outputDecimals: 18, minOutputRaw: '9900000000000000000', route: 'uniswap', lifiStep: { a: 1 } },
          leg_1: { ok: true, outputAmountRaw: '4000000000000000000', outputDecimals: 18, minOutputRaw: '3900000000000000000', route: 'uniswap', lifiStep: { a: 2 } },
        },
      },
    };

    const result = compiledExecutionToPurchaseIntentSteps(plan(), compiled, 6, alwaysResolveDecimalsTo18);

    expect(result.composerTransaction).toBeNull();
    expect(result.bagRouterTransaction).toBeNull();
    expect(result.steps[0]).toMatchObject({ outputAmountRaw: '10000000000000000000', outputDecimals: 18, route: 'uniswap' });
  });
});

describe('compiledExecutionToPurchaseIntentSteps — providerEnforcedMinOutputRaw', () => {
  it('a Composer step carries the provider-enforced minimum of ITS OWN leg, and BAG\'s minOutputRaw stays null', () => {
    const compiled: CompiledExecution = {
      mode: 'SINGLE_TX',
      chainId: 4663,
      transactions: [{ to: '0xComposerRouter', data: '0xdeadbeef', value: '0', chainId: 4663 }],
      expectedOutputs: [
        // Deliberately listed out of order: mapping must follow legId, not array position.
        { legId: 'leg_1', asset: AAPL, quotedOutputRaw: '400', quotedOutputBasis: 'SIMULATION', minimumGuaranteedOutputRaw: null, providerEnforcedMinOutputRaw: '396' },
        { legId: 'leg_0', asset: NVDA, quotedOutputRaw: '1000', quotedOutputBasis: 'SIMULATION', minimumGuaranteedOutputRaw: null, providerEnforcedMinOutputRaw: '990' },
      ],
      providerId: 'lifi-composer',
      executionPlanHash: 'hash-composer',
      providerMetadata: { userProxy: '0xProxy' },
    };

    const result = compiledExecutionToPurchaseIntentSteps(plan(), compiled, 6, alwaysResolveDecimalsTo18);

    expect(result.steps.map((st) => [st.targetSymbol, st.providerEnforcedMinOutputRaw, st.minOutputRaw])).toEqual([
      ['NVDA', '990', null],
      ['AAPL', '396', null],
    ]);
  });

  it('a Composer leg whose compile response carried no minimum records null, never a guess', () => {
    const compiled: CompiledExecution = {
      mode: 'SINGLE_TX',
      chainId: 4663,
      transactions: [{ to: '0xComposerRouter', data: '0xdeadbeef', value: '0', chainId: 4663 }],
      expectedOutputs: [
        { legId: 'leg_0', asset: NVDA, quotedOutputRaw: '1000', quotedOutputBasis: 'SIMULATION', minimumGuaranteedOutputRaw: null },
        { legId: 'leg_1', asset: AAPL, quotedOutputRaw: '400', quotedOutputBasis: 'SIMULATION', minimumGuaranteedOutputRaw: null, providerEnforcedMinOutputRaw: null },
      ],
      providerId: 'lifi-composer',
      executionPlanHash: 'hash-composer',
      providerMetadata: { userProxy: '0xProxy' },
    };
    const result = compiledExecutionToPurchaseIntentSteps(plan(), compiled, 6, alwaysResolveDecimalsTo18);
    expect(result.steps.map((st) => st.providerEnforcedMinOutputRaw)).toEqual([null, null]);
  });

  it('BAG Router and sequential LI.FI steps always leave it null (their floor is BAG\'s own minOutputRaw)', () => {
    const router: CompiledExecution = {
      mode: 'SINGLE_TX',
      chainId: 4663,
      transactions: [{ to: '0xRouter', data: '0xexecutecalldata', value: '0', chainId: 4663 }],
      expectedOutputs: [
        // Even if a provider reported one, only Composer steps record it.
        { legId: 'leg_0', asset: NVDA, quotedOutputRaw: '995', quotedOutputBasis: 'PROVIDER_QUOTE', minimumGuaranteedOutputRaw: '995', providerEnforcedMinOutputRaw: '1' },
        { legId: 'leg_1', asset: AAPL, quotedOutputRaw: '395', quotedOutputBasis: 'PROVIDER_QUOTE', minimumGuaranteedOutputRaw: '395' },
      ],
      providerId: 'bag-router',
      executionPlanHash: 'hash-bag-router',
      providerMetadata: { routerAddress: '0xRouter', signedPlan: { bagId: '0xOnChainBagId' } },
    };
    const sequential: CompiledExecution = {
      mode: 'MULTI_TX',
      chainId: 1,
      transactions: [],
      expectedOutputs: [
        { legId: 'leg_0', asset: NVDA, quotedOutputRaw: '10', quotedOutputBasis: 'PROVIDER_QUOTE', minimumGuaranteedOutputRaw: '9' },
        { legId: 'leg_1', asset: AAPL, quotedOutputRaw: '4', quotedOutputBasis: 'PROVIDER_QUOTE', minimumGuaranteedOutputRaw: '3' },
      ],
      providerId: 'lifi-sequential',
      executionPlanHash: 'hash-sequential',
      providerMetadata: {
        legResults: {
          leg_0: { ok: true, outputAmountRaw: '10', outputDecimals: 18, minOutputRaw: '9', route: 'uniswap', lifiStep: {} },
          leg_1: { ok: true, outputAmountRaw: '4', outputDecimals: 18, minOutputRaw: '3', route: 'uniswap', lifiStep: {} },
        },
      },
    };

    for (const [compiled, bagMins] of [
      [router, ['995', '395']],
      [sequential, ['9', '3']],
    ] as const) {
      const result = compiledExecutionToPurchaseIntentSteps(plan(), compiled, 6, alwaysResolveDecimalsTo18);
      expect(result.steps.map((st) => st.providerEnforcedMinOutputRaw)).toEqual([null, null]);
      expect(result.steps.map((st) => st.minOutputRaw)).toEqual(bagMins);
    }
  });
});

