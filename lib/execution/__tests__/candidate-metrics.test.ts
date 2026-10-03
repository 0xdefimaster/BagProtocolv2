import { describe, expect, it } from 'vitest';
import { AssetIdentity, AssetPrice } from '@/types/basket-protocol';
import { PriceProvider, PriceUnavailableError } from '@/lib/domain/basket-protocol/pricing/provider';
import { MockPriceProvider } from '@/lib/domain/basket-protocol/pricing/mock-provider';
import { annotateCandidateMetrics } from '../candidate-metrics';
import { ExecutionCandidate, ExecutionCandidateSet } from '../candidate-types';
import { CompiledExecution } from '../types';
import { BAG_ROUTER_PROVIDER_ID } from '../providers/bag-router-provider';

// -----------------------------------------------------------------------------
// Checkpoint 3/4/4b — candidate-metrics.ts. Section B of the spec's test
// list: quotedOutputUsd calculation, decimals handling, price-provider
// failure behavior, gas/duration staying null when genuinely unavailable,
// no fabricated zero values.
// -----------------------------------------------------------------------------

const ASSET_A: AssetIdentity = { chain: 'base', address: '0xTargetA' };
const ASSET_B: AssetIdentity = { chain: 'base', address: '0xTargetB' };

/** A provider quote whose guaranteed floor equals the quote (keeps these pricing tests about pricing; semantics have their own file). */
const quoteWithFloor = (raw: string) => ({ quotedOutputRaw: raw, quotedOutputBasis: 'PROVIDER_QUOTE' as const, minimumGuaranteedOutputRaw: raw });
const simulated = (raw: string) => ({ quotedOutputRaw: raw, quotedOutputBasis: 'SIMULATION' as const, minimumGuaranteedOutputRaw: null });

function decimalsFor(map: Record<string, number>) {
  return (asset: AssetIdentity): number | null => map[asset.address] ?? null;
}

function makeCompiled(overrides: Partial<CompiledExecution> = {}): CompiledExecution {
  return {
    mode: 'MULTI_TX',
    chainId: 8453,
    transactions: [],
    expectedOutputs: [{ legId: 'leg_0', asset: ASSET_A, ...quoteWithFloor('1000000') }],
    providerId: 'lifi-sequential',
    executionPlanHash: 'hash-1',
    ...overrides,
  };
}

function makeCandidateSet(candidates: ExecutionCandidate[]): ExecutionCandidateSet {
  return { candidates, executionPlanHash: 'hash-1', compiledAt: Date.now() };
}

function compiledCandidate(providerId: string, compiled: CompiledExecution): ExecutionCandidate {
  return {
    id: providerId,
    providerId,
    compile: { status: 'COMPILED' },
    executionMode: compiled.mode,
    compiled,
    metrics: null,
    executionPlanHash: compiled.executionPlanHash,
    compiledAt: Date.now(),
  };
}

function failedCandidate(providerId: string): ExecutionCandidate {
  return {
    id: providerId,
    providerId,
    compile: { status: 'FAILED', failureReason: { kind: 'PROVIDER_ERROR', message: 'boom' } },
    executionMode: null,
    metrics: null,
    executionPlanHash: 'hash-1',
    compiledAt: Date.now(),
  };
}

describe('annotateCandidateMetrics — quotedOutputUsd', () => {
  it('computes the USD value from quotedOutputRaw × price, honoring decimals', async () => {
    const priceProvider = new MockPriceProvider();
    priceProvider.setPrice(ASSET_A, '2.00'); // $2.00 per whole unit
    const compiled = makeCompiled({ expectedOutputs: [{ legId: 'leg_0', asset: ASSET_A, ...quoteWithFloor('1000000') }] }); // 1,000,000 raw / 10^6 decimals = 1.0 units
    const set = makeCandidateSet([compiledCandidate('lifi-sequential', compiled)]);

    const result = await annotateCandidateMetrics(set, {
      requestedSlippageBps: 100,
      priceProvider,
      resolveAssetDecimals: decimalsFor({ '0xTargetA': 6 }),
    });

    expect(result.candidates[0].metrics?.quotedOutputUsd).toBe(2);
  });

  it('sums across every leg for a multi-leg candidate', async () => {
    const priceProvider = new MockPriceProvider();
    priceProvider.setPrice(ASSET_A, '2.00');
    priceProvider.setPrice(ASSET_B, '5.00');
    const compiled = makeCompiled({
      expectedOutputs: [
        { legId: 'leg_0', asset: ASSET_A, ...quoteWithFloor('1000000') }, // 1.0 * $2 = $2
        { legId: 'leg_1', asset: ASSET_B, ...quoteWithFloor('2000000') }, // 2.0 * $5 = $10
      ],
    });
    const set = makeCandidateSet([compiledCandidate('lifi-sequential', compiled)]);

    const result = await annotateCandidateMetrics(set, {
      requestedSlippageBps: 100,
      priceProvider,
      resolveAssetDecimals: decimalsFor({ '0xTargetA': 6, '0xTargetB': 6 }),
    });

    expect(result.candidates[0].metrics?.quotedOutputUsd).toBe(12);
  });

  it('handles a non-6 decimals asset correctly (e.g. 18-decimal ERC-20)', async () => {
    const priceProvider = new MockPriceProvider();
    priceProvider.setPrice(ASSET_A, '3000.00');
    const compiled = makeCompiled({ expectedOutputs: [{ legId: 'leg_0', asset: ASSET_A, ...quoteWithFloor('500000000000000000') }] }); // 0.5 * 10^18
    const set = makeCandidateSet([compiledCandidate('lifi-sequential', compiled)]);

    const result = await annotateCandidateMetrics(set, {
      requestedSlippageBps: 100,
      priceProvider,
      resolveAssetDecimals: decimalsFor({ '0xTargetA': 18 }),
    });

    expect(result.candidates[0].metrics?.quotedOutputUsd).toBe(1500);
  });

  it('is null (never a partial sum) when one leg\'s asset has no resolvable decimals', async () => {
    const priceProvider = new MockPriceProvider();
    const compiled = makeCompiled({
      expectedOutputs: [
        { legId: 'leg_0', asset: ASSET_A, ...quoteWithFloor('1000000') },
        { legId: 'leg_1', asset: ASSET_B, ...quoteWithFloor('1000000') },
      ],
    });
    const set = makeCandidateSet([compiledCandidate('lifi-sequential', compiled)]);

    const result = await annotateCandidateMetrics(set, {
      requestedSlippageBps: 100,
      priceProvider,
      resolveAssetDecimals: decimalsFor({ '0xTargetA': 6 }), // ASSET_B unresolvable
    });

    expect(result.candidates[0].metrics?.quotedOutputUsd).toBeNull();
  });

  it('is null (never a partial sum, never a fabricated 0) when the price provider cannot price one leg', async () => {
    const flaky: PriceProvider = {
      async getPrice(asset: AssetIdentity): Promise<AssetPrice> {
        if (asset.address === '0xTargetB') throw new PriceUnavailableError(asset);
        return { asset, price: '2.00', quoteCurrency: 'USD', timestamp: new Date().toISOString(), source: 'test' };
      },
    };
    const compiled = makeCompiled({
      expectedOutputs: [
        { legId: 'leg_0', asset: ASSET_A, ...quoteWithFloor('1000000') },
        { legId: 'leg_1', asset: ASSET_B, ...quoteWithFloor('1000000') },
      ],
    });
    const set = makeCandidateSet([compiledCandidate('lifi-sequential', compiled)]);

    const result = await annotateCandidateMetrics(set, {
      requestedSlippageBps: 100,
      priceProvider: flaky,
      resolveAssetDecimals: decimalsFor({ '0xTargetA': 6, '0xTargetB': 6 }),
    });

    expect(result.candidates[0].metrics?.quotedOutputUsd).toBeNull();
  });

  it('propagates a genuine (non-PriceUnavailableError) price-provider error rather than swallowing it into null', async () => {
    const broken: PriceProvider = {
      async getPrice(): Promise<AssetPrice> {
        throw new Error('network down');
      },
    };
    const compiled = makeCompiled();
    const set = makeCandidateSet([compiledCandidate('lifi-sequential', compiled)]);

    await expect(
      annotateCandidateMetrics(set, {
        requestedSlippageBps: 100,
        priceProvider: broken,
        resolveAssetDecimals: decimalsFor({ '0xTargetA': 6 }),
      })
    ).rejects.toThrow('network down');
  });

  it('dedupes getPrice() calls across candidates/legs sharing the same asset', async () => {
    let callCount = 0;
    const counting: PriceProvider = {
      async getPrice(asset: AssetIdentity): Promise<AssetPrice> {
        callCount++;
        return { asset, price: '2.00', quoteCurrency: 'USD', timestamp: new Date().toISOString(), source: 'test' };
      },
    };
    const compiledA = makeCompiled({ providerId: 'lifi-sequential', expectedOutputs: [{ legId: 'leg_0', asset: ASSET_A, ...quoteWithFloor('1000000') }] });
    const compiledB = makeCompiled({ providerId: 'lifi-composer', expectedOutputs: [{ legId: 'leg_0', asset: ASSET_A, ...simulated('2000000') }] });
    const set = makeCandidateSet([compiledCandidate('lifi-sequential', compiledA), compiledCandidate('lifi-composer', compiledB)]);

    await annotateCandidateMetrics(set, {
      requestedSlippageBps: 100,
      priceProvider: counting,
      resolveAssetDecimals: decimalsFor({ '0xTargetA': 6 }),
    });

    expect(callCount).toBe(1);
  });

  it('leaves metrics null for a FAILED candidate — no metrics annotation runs on it', async () => {
    const set = makeCandidateSet([failedCandidate('lifi-sequential')]);
    const result = await annotateCandidateMetrics(set, {
      requestedSlippageBps: 100,
      priceProvider: new MockPriceProvider(),
      resolveAssetDecimals: decimalsFor({ '0xTargetA': 6 }),
    });
    expect(result.candidates[0].metrics).toBeNull();
  });

  it('passes requestedSlippageBps straight through, unchanged, for display only', async () => {
    const set = makeCandidateSet([compiledCandidate('lifi-sequential', makeCompiled())]);
    const result = await annotateCandidateMetrics(set, {
      requestedSlippageBps: 250,
      priceProvider: new MockPriceProvider(),
      resolveAssetDecimals: decimalsFor({ '0xTargetA': 6 }),
    });
    expect(result.candidates[0].metrics?.requestedSlippageBps).toBe(250);
  });
});

describe('annotateCandidateMetrics — LI.FI Sequential gas/fee/duration extraction', () => {
  function sequentialCompiled(legResults: Record<string, unknown>): CompiledExecution {
    return makeCompiled({
      providerId: 'lifi-sequential',
      expectedOutputs: [
        { legId: 'leg_0', asset: ASSET_A, ...quoteWithFloor('1000000') },
        { legId: 'leg_1', asset: ASSET_B, ...quoteWithFloor('1000000') },
      ],
      providerMetadata: { legResults },
    });
  }

  it('sums gasCosts[].amountUSD and feeCosts[].amountUSD across every leg, and SUMS (never maxes) executionDuration', async () => {
    const legResults = {
      leg_0: {
        ok: true,
        outputAmountRaw: '1000000',
        outputDecimals: 6,
        minOutputRaw: '1000000',
        route: 'uniswap',
        lifiStep: { estimate: { gasCosts: [{ amountUSD: '1.20' }], feeCosts: [{ amountUSD: '0.50' }], executionDuration: 15 } },
      },
      leg_1: {
        ok: true,
        outputAmountRaw: '1000000',
        outputDecimals: 6,
        minOutputRaw: '1000000',
        route: 'uniswap',
        lifiStep: { estimate: { gasCosts: [{ amountUSD: '0.80' }], feeCosts: [{ amountUSD: '0.25' }], executionDuration: 20 } },
      },
    };
    const compiled = sequentialCompiled(legResults);
    const set = makeCandidateSet([compiledCandidate('lifi-sequential', compiled)]);
    const priceProvider = new MockPriceProvider();
    priceProvider.setPrice(ASSET_A, '1.00');
    priceProvider.setPrice(ASSET_B, '1.00');

    const result = await annotateCandidateMetrics(set, {
      requestedSlippageBps: 100,
      priceProvider,
      resolveAssetDecimals: decimalsFor({ '0xTargetA': 6, '0xTargetB': 6 }),
    });

    const metrics = result.candidates[0].metrics!;
    expect(metrics.estimatedGasUsd).toBe(2.0); // 1.20 + 0.80
    expect(metrics.estimatedDurationSeconds).toBe(35); // 15 + 20, SUMMED (sequential wallet signing — never max())
    expect(metrics.providerMetadata).toEqual({ estimatedFeeUsd: 0.75 });
  });

  it('stays null (not zero) when no leg carries a gas/fee/duration figure at all', async () => {
    const legResults = {
      leg_0: { ok: true, outputAmountRaw: '1000000', outputDecimals: 6, minOutputRaw: '1000000', route: 'uniswap', lifiStep: null },
      leg_1: { ok: true, outputAmountRaw: '1000000', outputDecimals: 6, minOutputRaw: '1000000', route: 'uniswap', lifiStep: null },
    };
    const compiled = sequentialCompiled(legResults);
    const set = makeCandidateSet([compiledCandidate('lifi-sequential', compiled)]);

    const result = await annotateCandidateMetrics(set, {
      requestedSlippageBps: 100,
      priceProvider: new MockPriceProvider(),
      resolveAssetDecimals: decimalsFor({ '0xTargetA': 6, '0xTargetB': 6 }),
    });

    const metrics = result.candidates[0].metrics!;
    expect(metrics.estimatedGasUsd).toBeNull();
    expect(metrics.estimatedDurationSeconds).toBeNull();
    expect(metrics.providerMetadata).toBeUndefined();
  });

  it('does NOT double-count gas when a leg\'s gasCosts contains a SUM entry alongside its components (SUM + APPROVE + SEND) — uses ONLY the SUM entry, per @lifi/types\' own "SUM is an aggregate of the other entries" semantics', async () => {
    const legResults = {
      leg_0: {
        ok: true,
        outputAmountRaw: '1000000',
        outputDecimals: 6,
        minOutputRaw: '1000000',
        route: 'uniswap',
        lifiStep: {
          estimate: {
            gasCosts: [
              { type: 'SUM', amountUSD: '0.50' },
              { type: 'APPROVE', amountUSD: '0.10' },
              { type: 'SEND', amountUSD: '0.05' },
            ],
            executionDuration: 12,
          },
        },
      },
      leg_1: {
        ok: true,
        outputAmountRaw: '1000000',
        outputDecimals: 6,
        minOutputRaw: '1000000',
        route: 'uniswap',
        // No SUM here — today's actual (only-SEND) shape — must still sum normally for THIS leg.
        lifiStep: { estimate: { gasCosts: [{ type: 'SEND', amountUSD: '0.30' }], executionDuration: 8 } },
      },
    };
    const compiled = sequentialCompiled(legResults);
    const set = makeCandidateSet([compiledCandidate('lifi-sequential', compiled)]);

    const result = await annotateCandidateMetrics(set, {
      requestedSlippageBps: 100,
      priceProvider: new MockPriceProvider(),
      resolveAssetDecimals: decimalsFor({ '0xTargetA': 6, '0xTargetB': 6 }),
    });

    const metrics = result.candidates[0].metrics!;
    // leg_0 contributes ONLY its SUM ($0.50, not 0.50+0.10+0.05=0.65); leg_1 has no SUM so its one entry ($0.30) is used as-is. Total: 0.80, never 0.95.
    expect(metrics.estimatedGasUsd).toBe(0.8);
    expect(metrics.estimatedDurationSeconds).toBe(20);
  });

  it('sums entries normally when none of them is type SUM (today\'s actual LI.FI response shape, multiple non-SUM entries in one leg)', async () => {
    const legResults = {
      leg_0: {
        ok: true,
        outputAmountRaw: '1000000',
        outputDecimals: 6,
        minOutputRaw: '1000000',
        route: 'uniswap',
        lifiStep: { estimate: { gasCosts: [{ type: 'SEND', amountUSD: '0.40' }, { type: 'APPROVE', amountUSD: '0.10' }], executionDuration: 10 } },
      },
    };
    const compiled = sequentialCompiled(legResults);
    const set = makeCandidateSet([compiledCandidate('lifi-sequential', compiled)]);

    const result = await annotateCandidateMetrics(set, {
      requestedSlippageBps: 100,
      priceProvider: new MockPriceProvider(),
      resolveAssetDecimals: decimalsFor({ '0xTargetA': 6, '0xTargetB': 6 }),
    });

    expect(result.candidates[0].metrics!.estimatedGasUsd).toBe(0.5); // 0.40 + 0.10 — no SUM entry present, so both are genuinely additive.
  });
});

describe('annotateCandidateMetrics — LI.FI Composer metadata passthrough', () => {
  it('surfaces gasLimitRaw/priceImpact/fees in providerMetadata, and never fills estimatedGasUsd/estimatedDurationSeconds from them', async () => {
    const compiled = makeCompiled({
      providerId: 'lifi-composer',
      mode: 'SINGLE_TX',
      providerMetadata: {
        gasLimitRaw: '210000',
        priceImpact: { inputValueUsd: 1000, outputValueUsd: 998, impactBps: 20 },
        fees: [{ token: '0xInputToken', recipient: 'lifi', bps: 10, amount: '1000' }],
      },
    });
    const set = makeCandidateSet([compiledCandidate('lifi-composer', compiled)]);

    const result = await annotateCandidateMetrics(set, {
      requestedSlippageBps: 100,
      priceProvider: new MockPriceProvider(),
      resolveAssetDecimals: decimalsFor({ '0xTargetA': 6 }),
    });

    const metrics = result.candidates[0].metrics!;
    expect(metrics.estimatedGasUsd).toBeNull(); // gasLimit is a UNIT count, never coerced into USD.
    expect(metrics.estimatedDurationSeconds).toBeNull();
    expect(metrics.providerMetadata).toEqual({
      gasLimitRaw: '210000',
      priceImpact: { inputValueUsd: 1000, outputValueUsd: 998, impactBps: 20 },
      fees: [{ token: '0xInputToken', recipient: 'lifi', bps: 10, amount: '1000' }],
    });
  });

  it('omits providerMetadata entirely when the compile response had none of these fields', async () => {
    const compiled = makeCompiled({ providerId: 'lifi-composer', mode: 'SINGLE_TX', providerMetadata: { userProxy: '0xProxy', legQuotes: {} } });
    const set = makeCandidateSet([compiledCandidate('lifi-composer', compiled)]);

    const result = await annotateCandidateMetrics(set, {
      requestedSlippageBps: 100,
      priceProvider: new MockPriceProvider(),
      resolveAssetDecimals: decimalsFor({ '0xTargetA': 6 }),
    });

    expect(result.candidates[0].metrics?.providerMetadata).toBeUndefined();
  });
});

describe('annotateCandidateMetrics — BAG Router (no compile-time gas/duration data)', () => {
  it('estimatedGasUsd and estimatedDurationSeconds stay null for bag-router — never fabricated from the simulation return value', async () => {
    const compiled = makeCompiled({ providerId: BAG_ROUTER_PROVIDER_ID, mode: 'SINGLE_TX', providerMetadata: { routerAddress: '0xRouter' } });
    const set = makeCandidateSet([compiledCandidate(BAG_ROUTER_PROVIDER_ID, compiled)]);

    const result = await annotateCandidateMetrics(set, {
      requestedSlippageBps: 100,
      priceProvider: new MockPriceProvider(),
      resolveAssetDecimals: decimalsFor({ '0xTargetA': 6 }),
    });

    const metrics = result.candidates[0].metrics!;
    expect(metrics.estimatedGasUsd).toBeNull();
    expect(metrics.estimatedDurationSeconds).toBeNull();
  });

  it('still computes quotedOutputUsd for bag-router — the universal metric is provider-independent', async () => {
    const priceProvider = new MockPriceProvider();
    priceProvider.setPrice(ASSET_A, '4.00');
    const compiled = makeCompiled({
      providerId: BAG_ROUTER_PROVIDER_ID,
      mode: 'SINGLE_TX',
      expectedOutputs: [{ legId: 'leg_0', asset: ASSET_A, ...quoteWithFloor('1000000') }],
    });
    const set = makeCandidateSet([compiledCandidate(BAG_ROUTER_PROVIDER_ID, compiled)]);

    const result = await annotateCandidateMetrics(set, {
      requestedSlippageBps: 100,
      priceProvider,
      resolveAssetDecimals: decimalsFor({ '0xTargetA': 6 }),
    });

    expect(result.candidates[0].metrics?.quotedOutputUsd).toBe(4);
  });
});
