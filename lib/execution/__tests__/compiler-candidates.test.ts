import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearCompileCache } from '../compile-cache';
import { compileBagExecution, compileBagExecutionCandidates } from '../compiler';
import { BagExecutionGraph, BagExecutionIntent, CompiledExecution } from '../types';
import { BagExecutionProvider, ProviderCapabilities } from '../providers/types';
import { BagExecutionError } from '../errors';

// compile() results are cached process-wide for a few seconds (compile-cache.ts); isolate each test.
beforeEach(() => clearCompileCache());

// -----------------------------------------------------------------------------
// Checkpoint 2 — compileBagExecutionCandidates(). Mirrors compiler.test.ts's
// own mock-provider style so both test files stay easy to compare; this one
// additionally proves the legacy compileBagExecution() path is BYTE FOR
// BYTE unaffected by the new function existing (spec item 21/22's central
// regression rule).
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
  delayMs?: number;
}): BagExecutionProvider {
  const capabilities: ProviderCapabilities = { ...BASE_CAPS, ...overrides.capabilities };
  return {
    identify: () => overrides.id,
    getCapabilities: () => capabilities,
    supports: () => overrides.supports ?? true,
    compile: async () => {
      if (overrides.delayMs) await new Promise((r) => setTimeout(r, overrides.delayMs));
      if (overrides.compileError) throw overrides.compileError;
      return {
        mode: 'MULTI_TX',
        chainId: 1,
        transactions: [],
        expectedOutputs: [{ legId: 'leg_0', asset: { chain: 'base', address: '0xTargetA' }, quotedOutputRaw: '990000', quotedOutputBasis: 'PROVIDER_QUOTE', minimumGuaranteedOutputRaw: '990000' }],
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

describe('compileBagExecutionCandidates', () => {
  it('returns ALL eligible providers as candidates, not just the first success', async () => {
    const a = makeProvider({ id: 'provider-a' });
    const b = makeProvider({ id: 'provider-b' });
    const result = await compileBagExecutionCandidates(makeIntent(), makeGraph(), [a, b]);
    expect(result.candidates.map((c) => c.providerId).sort()).toEqual(['provider-a', 'provider-b']);
    expect(result.candidates.every((c) => c.compile.status === 'COMPILED')).toBe(true);
  });

  it('runs providers independently — a slow provider does not block a fast one from resolving first (Promise.allSettled, not sequential)', async () => {
    const slow = makeProvider({ id: 'slow', delayMs: 30 });
    const fast = makeProvider({ id: 'fast' });
    const result = await compileBagExecutionCandidates(makeIntent(), makeGraph(), [slow, fast]);
    expect(result.candidates).toHaveLength(2);
  });

  it('stamps each candidate with its OWN completion time, not a single shared batch-start timestamp — a slow provider and a fast provider get different compiledAt values', async () => {
    const fast = makeProvider({ id: 'fast' });
    const slow = makeProvider({ id: 'slow', delayMs: 40 });
    const result = await compileBagExecutionCandidates(makeIntent(), makeGraph(), [fast, slow]);
    const fastCandidate = result.candidates.find((c) => c.providerId === 'fast')!;
    const slowCandidate = result.candidates.find((c) => c.providerId === 'slow')!;
    // The slow provider's own compiledAt must reflect that it genuinely
    // finished later — this is the exact behavior a single `Date.now()`
    // captured once before `Promise.allSettled` could never produce, since
    // that would stamp both candidates identically regardless of how long
    // either one actually took.
    expect(slowCandidate.compiledAt).toBeGreaterThan(fastCandidate.compiledAt);
    expect(slowCandidate.compiledAt - fastCandidate.compiledAt).toBeGreaterThanOrEqual(30);
  });

  it('a FAILED candidate (thrown error) still gets its own real completion time, not the batch start time', async () => {
    const instant = makeProvider({ id: 'instant', compileError: new Error('bad config') });
    const delayedFailure = makeProvider({ id: 'delayed-failure', compileError: new Error('quote timed out'), delayMs: 40 });
    const result = await compileBagExecutionCandidates(makeIntent(), makeGraph(), [instant, delayedFailure]);
    const instantCandidate = result.candidates.find((c) => c.providerId === 'instant')!;
    const delayedCandidate = result.candidates.find((c) => c.providerId === 'delayed-failure')!;
    expect(instantCandidate.compile.status).toBe('FAILED');
    expect(delayedCandidate.compile.status).toBe('FAILED');
    expect(delayedCandidate.compiledAt).toBeGreaterThan(instantCandidate.compiledAt);
  });

  it('ExecutionCandidateSet.compiledAt (the batch timestamp) is at or before every individual candidate.compiledAt — the batch starts before any candidate can finish', async () => {
    const a = makeProvider({ id: 'a', delayMs: 10 });
    const b = makeProvider({ id: 'b', delayMs: 20 });
    const result = await compileBagExecutionCandidates(makeIntent(), makeGraph(), [a, b]);
    for (const candidate of result.candidates) {
      expect(candidate.compiledAt).toBeGreaterThanOrEqual(result.compiledAt);
    }
  });

  it('one provider failure does not cancel/discard the others (Promise.allSettled behavior)', async () => {
    const ok = makeProvider({ id: 'ok' });
    const broken = makeProvider({ id: 'broken', compileError: new Error('network blew up') });
    const result = await compileBagExecutionCandidates(makeIntent(), makeGraph(), [ok, broken]);
    expect(result.candidates).toHaveLength(2);
    const okCandidate = result.candidates.find((c) => c.providerId === 'ok')!;
    const brokenCandidate = result.candidates.find((c) => c.providerId === 'broken')!;
    expect(okCandidate.compile.status).toBe('COMPILED');
    expect(brokenCandidate.compile.status).toBe('FAILED');
  });

  it('a thrown provider becomes a FAILED candidate with the failure message preserved, not a discarded result', async () => {
    const broken = makeProvider({ id: 'broken', compileError: new Error('quote expired') });
    const result = await compileBagExecutionCandidates(makeIntent(), makeGraph(), [broken]);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].compile.status).toBe('FAILED');
    expect(result.candidates[0].compile.failureReason?.kind).toBe('PROVIDER_ERROR');
    expect(result.candidates[0].compile.failureReason?.message).toBe('quote expired');
  });

  it('2 providers: Composer-like SUCCESS + Sequential-like FAILURE returns TWO candidates, one of each status (spec example)', async () => {
    const composerLike = makeProvider({ id: 'lifi-composer' });
    const sequentialLike = makeProvider({
      id: 'lifi-sequential',
      // Partial result: expectedOutputs shorter than the graph's one leg — see next test for the real multi-leg case.
      compileResult: { expectedOutputs: [] },
    });
    const result = await compileBagExecutionCandidates(makeIntent(), makeGraph(), [composerLike, sequentialLike]);
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.find((c) => c.providerId === 'lifi-composer')?.compile.status).toBe('COMPILED');
    expect(result.candidates.find((c) => c.providerId === 'lifi-sequential')?.compile.status).toBe('FAILED');
  });

  it('a partial/incomplete compiled execution (a missing leg) becomes FAILED via the completeness check, not COMPILED', async () => {
    const graph = makeGraph({
      inputAmountRaw: '2000000',
      legs: [
        { id: 'leg_0', sourceAsset: { chain: 'base', address: '0xInput' }, targetAsset: { chain: 'base', address: '0xA' }, amountRaw: '1000000', weightBps: 5000, minimumOutputRaw: null, slippageBps: 100, chain: 'base', dependsOn: [] },
        { id: 'leg_1', sourceAsset: { chain: 'base', address: '0xInput' }, targetAsset: { chain: 'base', address: '0xB' }, amountRaw: '1000000', weightBps: 5000, minimumOutputRaw: null, slippageBps: 100, chain: 'base', dependsOn: [] },
      ],
    });
    const partial = makeProvider({
      id: 'partial-provider',
      compileResult: { expectedOutputs: [{ legId: 'leg_0', asset: { chain: 'base', address: '0xA' }, quotedOutputRaw: '990000', quotedOutputBasis: 'PROVIDER_QUOTE', minimumGuaranteedOutputRaw: '990000' }] },
    });
    const result = await compileBagExecutionCandidates(makeIntent(), graph, [partial]);
    expect(result.candidates[0].compile.status).toBe('FAILED');
    expect(result.candidates[0].compile.failureReason?.kind).toBe('INCOMPLETE_RESULT');
    expect(result.candidates[0].compiled).toBeUndefined();
  });

  it('every graph leg must have exactly one expected output — a duplicate is also rejected', async () => {
    const provider = makeProvider({
      id: 'dup-provider',
      compileResult: {
        expectedOutputs: [
          { legId: 'leg_0', asset: { chain: 'base', address: '0xTargetA' }, quotedOutputRaw: '1', quotedOutputBasis: 'PROVIDER_QUOTE', minimumGuaranteedOutputRaw: '1' },
          { legId: 'leg_0', asset: { chain: 'base', address: '0xTargetA' }, quotedOutputRaw: '2', quotedOutputBasis: 'PROVIDER_QUOTE', minimumGuaranteedOutputRaw: '2' },
        ],
      },
    });
    const result = await compileBagExecutionCandidates(makeIntent(), makeGraph(), [provider]);
    expect(result.candidates[0].compile.status).toBe('FAILED');
  });

  it('allowedProviders filtering still works — an excluded provider never even runs and is absent from the result', async () => {
    const a = makeProvider({ id: 'provider-a' });
    const b = makeProvider({ id: 'provider-b' });
    const result = await compileBagExecutionCandidates(
      makeIntent({ constraints: { allowedProviders: ['provider-b'] } }),
      makeGraph(),
      [a, b]
    );
    expect(result.candidates.map((c) => c.providerId)).toEqual(['provider-b']);
  });

  it('atomic filtering still works — a non-atomic provider is excluded from the candidate set', async () => {
    const atomic = makeProvider({ id: 'atomic-provider', capabilities: { atomic: true } });
    const nonAtomic = makeProvider({ id: 'non-atomic-provider', capabilities: { atomic: false } });
    const result = await compileBagExecutionCandidates(
      makeIntent({ constraints: { atomic: true } }),
      makeGraph(),
      [atomic, nonAtomic]
    );
    expect(result.candidates.map((c) => c.providerId)).toEqual(['atomic-provider']);
  });

  it('throws UNSATISFIABLE_CONSTRAINTS (structural exception, not a candidate) when atomic is required and no eligible provider supports it', async () => {
    const nonAtomic = makeProvider({ id: 'non-atomic-provider', capabilities: { atomic: false } });
    await expect(
      compileBagExecutionCandidates(makeIntent({ constraints: { atomic: true } }), makeGraph(), [nonAtomic])
    ).rejects.toMatchObject({ code: 'UNSATISFIABLE_CONSTRAINTS' });
  });

  it('resolves to an EMPTY candidate list (not a throw) when no provider is eligible at all', async () => {
    const ineligible = makeProvider({ id: 'ineligible', supports: false });
    const result = await compileBagExecutionCandidates(makeIntent(), makeGraph(), [ineligible]);
    expect(result.candidates).toEqual([]);
  });

  it('an invalid graph still fails BEFORE any provider is even called', async () => {
    let called = false;
    const provider = makeProvider({ id: 'should-not-run' });
    const originalCompile = provider.compile.bind(provider);
    provider.compile = async (...args) => {
      called = true;
      return originalCompile(...args);
    };
    const invalidGraph = makeGraph({ legs: [] });
    await expect(compileBagExecutionCandidates(makeIntent(), invalidGraph, [provider])).rejects.toBeInstanceOf(BagExecutionError);
    expect(called).toBe(false);
  });

  it('the graph hash is IDENTICAL across every candidate in one call, and matches compileBagExecution()\'s own hash for the same graph', async () => {
    const a = makeProvider({ id: 'provider-a' });
    const b = makeProvider({ id: 'provider-b' });
    const graph = makeGraph();
    const candidateResult = await compileBagExecutionCandidates(makeIntent(), graph, [a, b]);
    const singleResult = await compileBagExecution(makeIntent(), graph, [a]);
    const hashes = new Set(candidateResult.candidates.map((c) => c.executionPlanHash));
    expect(hashes.size).toBe(1);
    expect(candidateResult.executionPlanHash).toBe(singleResult.executionPlanHash);
  });

  it('legacy compileBagExecution() behavior is completely unchanged by this function existing (still first-success, sequential)', async () => {
    const first = makeProvider({ id: 'provider-a', supports: false });
    const second = makeProvider({ id: 'provider-b', supports: true });
    const result = await compileBagExecution(makeIntent(), makeGraph(), [first, second]);
    expect(result.providerId).toBe('provider-b');
  });
});

// -----------------------------------------------------------------------------
// compileQuote() preference — the signing-boundary seam (providers/types.ts's
// `BagExecutionProvider.compileQuote` doc). `compileBagExecutionCandidates()`
// must call a provider's `compileQuote()` when it defines one, and fall back
// to `compile()` only when it doesn't — `compileBagExecution()` must never
// call `compileQuote()` at all, only ever `compile()`. These tests prove the
// SELECTION logic generically (a real provider-specific proof — that
// `BagRouterProvider.compile()`'s `signPlan()` specifically never runs during
// comparison — lives in providers/__tests__/bag-router-provider.test.ts,
// against the real provider rather than a mock).
// -----------------------------------------------------------------------------

function makeProviderWithQuote(overrides: {
  id: string;
  compile: ReturnType<typeof vi.fn>;
  compileQuote?: ReturnType<typeof vi.fn>;
}): BagExecutionProvider {
  return {
    identify: () => overrides.id,
    getCapabilities: () => BASE_CAPS,
    supports: () => true,
    // Fixtures return partial CompiledExecution shapes; the mocks are cast
    // rather than typed so each test only builds the fields it asserts on.
    compile: overrides.compile as unknown as BagExecutionProvider['compile'],
    ...(overrides.compileQuote
      ? { compileQuote: overrides.compileQuote as unknown as NonNullable<BagExecutionProvider['compileQuote']> }
      : {}),
  };
}

describe('compileBagExecutionCandidates — compileQuote() vs compile() selection', () => {
  it('calls compileQuote(), never compile(), for a provider that defines compileQuote', async () => {
    const compile = vi.fn();
    const compileQuote = vi.fn(async () => ({
      mode: 'SINGLE_TX' as const,
      chainId: 1,
      transactions: [],
      expectedOutputs: [{ legId: 'leg_0', asset: { chain: 'base', address: '0xTargetA' }, quotedOutputRaw: '990000', quotedOutputBasis: 'PROVIDER_QUOTE', minimumGuaranteedOutputRaw: '990000' }],
      providerId: 'quoting-provider',
      executionPlanHash: 'stale-should-be-overwritten',
    }));
    const provider = makeProviderWithQuote({ id: 'quoting-provider', compile, compileQuote });

    const result = await compileBagExecutionCandidates(makeIntent(), makeGraph(), [provider]);

    expect(compileQuote).toHaveBeenCalledTimes(1);
    expect(compile).not.toHaveBeenCalled();
    expect(result.candidates[0].compile.status).toBe('COMPILED');
  });

  it('falls back to compile() when a provider has no compileQuote — existing providers (LI.FI Composer/Sequential) are unaffected', async () => {
    const compile = vi.fn(async () => ({
      mode: 'MULTI_TX' as const,
      chainId: 1,
      transactions: [],
      expectedOutputs: [{ legId: 'leg_0', asset: { chain: 'base', address: '0xTargetA' }, quotedOutputRaw: '990000', quotedOutputBasis: 'PROVIDER_QUOTE', minimumGuaranteedOutputRaw: '990000' }],
      providerId: 'no-quote-provider',
      executionPlanHash: 'stale-should-be-overwritten',
    }));
    const provider = makeProviderWithQuote({ id: 'no-quote-provider', compile });

    const result = await compileBagExecutionCandidates(makeIntent(), makeGraph(), [provider]);

    expect(compile).toHaveBeenCalledTimes(1);
    expect(result.candidates[0].compile.status).toBe('COMPILED');
  });

  it('a compileQuote() that throws produces a FAILED candidate WITHOUT ever falling through to compile() — the fallback is compileQuote-vs-compile selection, not a retry chain', async () => {
    const compile = vi.fn();
    const compileQuote = vi.fn(async () => {
      throw new Error('quote unavailable');
    });
    const provider = makeProviderWithQuote({ id: 'broken-quote-provider', compile, compileQuote });

    const result = await compileBagExecutionCandidates(makeIntent(), makeGraph(), [provider]);

    expect(compileQuote).toHaveBeenCalledTimes(1);
    expect(compile).not.toHaveBeenCalled();
    expect(result.candidates[0].compile.status).toBe('FAILED');
    expect(result.candidates[0].compile.failureReason?.message).toBe('quote unavailable');
  });

  it('compileBagExecution() (the single-provider executable path) never calls compileQuote, even when a provider defines one', async () => {
    const compile = vi.fn(async () => ({
      mode: 'SINGLE_TX' as const,
      chainId: 1,
      transactions: [{ to: '0xRouter', data: '0x', value: '0', chainId: 1 }],
      expectedOutputs: [{ legId: 'leg_0', asset: { chain: 'base', address: '0xTargetA' }, quotedOutputRaw: '990000', quotedOutputBasis: 'PROVIDER_QUOTE', minimumGuaranteedOutputRaw: '990000' }],
      providerId: 'quoting-provider',
      executionPlanHash: 'stale-should-be-overwritten',
    }));
    const compileQuote = vi.fn();
    const provider = makeProviderWithQuote({ id: 'quoting-provider', compile, compileQuote });

    const result = await compileBagExecution(makeIntent(), makeGraph(), [provider]);

    expect(compile).toHaveBeenCalledTimes(1);
    expect(compileQuote).not.toHaveBeenCalled();
    expect(result.providerId).toBe('quoting-provider');
  });
});
