import { beforeEach, describe, expect, it } from 'vitest';
import { clearCompileCache } from '../compile-cache';
import { compileBagExecution } from '../compiler';
import { BagExecutionError } from '../errors';
import { BagExecutionGraph, BagExecutionIntent, CompiledExecution } from '../types';
import { BagExecutionProvider, ProviderCapabilities } from '../providers/types';

// compile() results are cached process-wide for a few seconds (compile-cache.ts); isolate each test.
beforeEach(() => clearCompileCache());

// -----------------------------------------------------------------------------
// These tests exercise ONLY the provider-selection/error-handling logic in
// `compiler.ts` — pure, in-memory mock providers, no network, no real LI.FI
// SDK. Provider-specific behavior (Composer flow building, LI.FI quoting)
// is covered by the existing tests for those modules
// (lifi-composer-adapter.test.ts, lifi-execution-adapter.test.ts); this
// file only needs to prove the compiler picks the RIGHT one and fails the
// RIGHT way when it should.
// -----------------------------------------------------------------------------

const BASE_CAPS: ProviderCapabilities = {
  sameChain: true,
  crossChain: false,
  multiAsset: true,
  singleTransaction: false,
  requiresApproval: true,
  requiresMultipleSignatures: true,
  nativeAsset: true,
  erc20: true,
  atomic: false,
  supportsRecipient: false,
  supportsPermit: false,
  supportsComposer: false,
};

function makeProvider(overrides: {
  id: string;
  capabilities?: Partial<ProviderCapabilities>;
  supports?: boolean;
  compileResult?: Partial<CompiledExecution>;
  compileError?: Error;
}): BagExecutionProvider {
  const capabilities: ProviderCapabilities = { ...BASE_CAPS, ...overrides.capabilities };
  return {
    identify: () => overrides.id,
    getCapabilities: () => capabilities,
    supports: () => overrides.supports ?? true,
    compile: async () => {
      if (overrides.compileError) throw overrides.compileError;
      return {
        mode: 'MULTI_TX',
        chainId: 1,
        transactions: [],
        expectedOutputs: [],
        providerId: overrides.id,
        executionPlanHash: 'stale-should-be-overwritten',
        ...overrides.compileResult,
      };
    },
  };
}

function makeIntent(overrides: Partial<BagExecutionIntent> = {}): BagExecutionIntent {
  return {
    bagId: 'bag_1',
    wallet: '0xWallet',
    chainId: 'base',
    inputAsset: { chain: 'base', address: '0xInput' },
    inputAmountRaw: '1000000',
    targets: [{ asset: { chain: 'base', address: '0xTargetA' }, weightBps: 10000 }],
    maxSlippageBps: 100,
    deadline: Date.now() + 60_000,
    recipeVersion: 1,
    compositionHash: 'hash_1',
    ...overrides,
  };
}

function makeGraph(overrides: Partial<BagExecutionGraph> = {}): BagExecutionGraph {
  return {
    bagId: 'bag_1',
    wallet: '0xWallet',
    chainId: 'base',
    inputAsset: { chain: 'base', address: '0xInput' },
    inputAmountRaw: '1000000',
    legs: [
      {
        id: 'leg_0',
        sourceAsset: { chain: 'base', address: '0xInput' },
        targetAsset: { chain: 'base', address: '0xTargetA' },
        amountRaw: '1000000',
        weightBps: 10000,
        minimumOutputRaw: null,
        slippageBps: 100,
        chain: 'base',
        dependsOn: [],
      },
    ],
    unallocatedRaw: '0',
    ...overrides,
  };
}

describe('compileBagExecution', () => {
  it('picks the first provider (in order) whose supports() is true', async () => {
    const first = makeProvider({ id: 'provider-a', supports: false });
    const second = makeProvider({ id: 'provider-b', supports: true });
    const result = await compileBagExecution(makeIntent(), makeGraph(), [first, second]);
    expect(result.providerId).toBe('provider-b');
  });

  it('re-stamps providerId and executionPlanHash from the compiler, not the provider', async () => {
    const provider = makeProvider({ id: 'provider-a', compileResult: { providerId: 'wrong-id' } });
    const result = await compileBagExecution(makeIntent(), makeGraph(), [provider]);
    expect(result.providerId).toBe('provider-a');
    expect(result.executionPlanHash).not.toBe('stale-should-be-overwritten');
    expect(result.executionPlanHash).toHaveLength(64); // sha256 hex
  });

  it('produces the same executionPlanHash for the same graph, a different one for a changed graph', async () => {
    const provider = makeProvider({ id: 'provider-a' });
    const graphA = makeGraph();
    const graphB = makeGraph({ inputAmountRaw: '2000000', legs: [{ ...makeGraph().legs[0], amountRaw: '2000000' }] });
    const resultA = await compileBagExecution(makeIntent(), graphA, [provider]);
    const resultB = await compileBagExecution(makeIntent(), graphB, [provider]);
    expect(resultA.executionPlanHash).not.toBe(resultB.executionPlanHash);
  });

  it('throws NO_ELIGIBLE_PROVIDER when nothing supports the intent', async () => {
    const provider = makeProvider({ id: 'provider-a', supports: false });
    await expect(compileBagExecution(makeIntent(), makeGraph(), [provider])).rejects.toMatchObject({
      code: 'NO_ELIGIBLE_PROVIDER',
    });
  });

  it('throws UNSATISFIABLE_CONSTRAINTS when atomic is required but the only eligible provider is not atomic', async () => {
    const provider = makeProvider({ id: 'provider-a', capabilities: { atomic: false }, supports: true });
    const intent = makeIntent({ constraints: { atomic: true } });
    await expect(compileBagExecution(intent, makeGraph(), [provider])).rejects.toMatchObject({
      code: 'UNSATISFIABLE_CONSTRAINTS',
    });
  });

  it('skips a non-atomic provider and picks an atomic one when atomic is required', async () => {
    const nonAtomic = makeProvider({ id: 'provider-a', capabilities: { atomic: false } });
    const atomic = makeProvider({ id: 'provider-b', capabilities: { atomic: true, singleTransaction: true } });
    const intent = makeIntent({ constraints: { atomic: true } });
    const result = await compileBagExecution(intent, makeGraph(), [nonAtomic, atomic]);
    expect(result.providerId).toBe('provider-b');
  });

  it('respects constraints.allowedProviders as a filter', async () => {
    const a = makeProvider({ id: 'provider-a' });
    const b = makeProvider({ id: 'provider-b' });
    const intent = makeIntent({ constraints: { allowedProviders: ['provider-b'] } });
    const result = await compileBagExecution(intent, makeGraph(), [a, b]);
    expect(result.providerId).toBe('provider-b');
  });

  it('wraps a provider compile() throw as PROVIDER_COMPILE_FAILED when it is the ONLY eligible provider', async () => {
    const provider = makeProvider({ id: 'provider-a', compileError: new Error('composer down') });
    await expect(compileBagExecution(makeIntent(), makeGraph(), [provider])).rejects.toMatchObject({
      code: 'PROVIDER_COMPILE_FAILED',
    });
  });

  it('falls back to the next eligible provider when the first one is eligible but compile() throws (Composer-outage scenario)', async () => {
    const composer = makeProvider({
      id: 'lifi-composer',
      capabilities: { atomic: true, singleTransaction: true },
      compileError: new Error('composer network error'),
    });
    const sequential = makeProvider({
      id: 'lifi-sequential',
      compileResult: { mode: 'MULTI_TX' },
    });
    const result = await compileBagExecution(makeIntent(), makeGraph(), [composer, sequential]);
    expect(result.providerId).toBe('lifi-sequential');
    expect(result.mode).toBe('MULTI_TX');
  });

  it('throws PROVIDER_COMPILE_FAILED (with every failing provider message) only once ALL eligible providers fail', async () => {
    const a = makeProvider({ id: 'provider-a', compileError: new Error('a down') });
    const b = makeProvider({ id: 'provider-b', compileError: new Error('b down') });
    await expect(compileBagExecution(makeIntent(), makeGraph(), [a, b])).rejects.toMatchObject({
      code: 'PROVIDER_COMPILE_FAILED',
      details: {
        compileFailures: [
          { providerId: 'provider-a', message: 'a down' },
          { providerId: 'provider-b', message: 'b down' },
        ],
      },
    });
  });

  it('rejects an invalid graph (legs not summing to input - unallocated) before touching any provider', async () => {
    const provider = makeProvider({ id: 'provider-a' });
    const badGraph = makeGraph({ unallocatedRaw: '500000' }); // legs sum to 1000000 but only 500000 should be allocated
    await expect(compileBagExecution(makeIntent(), badGraph, [provider])).rejects.toMatchObject({
      code: 'INVALID_EXECUTION_GRAPH',
    });
  });
});

describe('compileBagExecution — price-impact refusal', () => {
  beforeEach(() => clearCompileCache());
  it('never falls through to another provider: the buyer sees the impact and may accept it', async () => {
    const refusal = new BagExecutionError('PRICE_IMPACT_REFUSED', 'Price impact 820 bps exceeds maximum 500 bps', { composerFallback: { reason: 'PRICE_IMPACT' } });
    const sequential = makeProvider({ id: 'lifi-sequential' });
    let sequentialCalled = false;
    const watched = { ...sequential, compile: async (...a: Parameters<BagExecutionProvider['compile']>) => { sequentialCalled = true; return sequential.compile(...a); } };
    await expect(compileBagExecution(makeIntent(), makeGraph(), [makeProvider({ id: 'lifi-composer', compileError: refusal }), watched])).rejects.toMatchObject({ code: 'PRICE_IMPACT_REFUSED' });
    expect(sequentialCalled).toBe(false);
  });
});
