import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearCompileCache, COMPILE_CACHE_TTL_MS, compileWithCache } from '../compile-cache';
import { BagExecutionGraph, BagExecutionIntent, CompiledExecution } from '../types';
import { BagExecutionProvider } from '../providers/types';

beforeEach(() => clearCompileCache());

const intent = (overrides: Partial<BagExecutionIntent> = {}): BagExecutionIntent =>
  ({
    bagId: 'bag-1',
    wallet: '0xabc',
    chainId: 'robinhood',
    inputAsset: { chain: 'robinhood', address: '0xin' },
    inputAmountRaw: '1000000',
    targets: [],
    maxSlippageBps: 100,
    deadline: Date.now() + 60_000,
    recipeVersion: 1,
    compositionHash: '0xhash',
    ...overrides,
  }) as BagExecutionIntent;
const graph = { legs: [] } as unknown as BagExecutionGraph;
const compiled = { mode: 'SINGLE_TX', transactions: [] } as unknown as CompiledExecution;

function provider(extra: Partial<BagExecutionProvider> = {}) {
  const compile = vi.fn(async () => compiled);
  return { compile, p: { identify: () => 'lifi-composer', compile, ...extra } as unknown as BagExecutionProvider };
}

describe('compileWithCache', () => {
  it('reuses a result for the same wallet/amount/graph, ignoring deadline and constraints', async () => {
    const { p, compile } = provider();
    await compileWithCache(p, intent(), graph, 1000);
    await compileWithCache(p, intent({ deadline: 1, constraints: { allowedProviders: ['lifi-composer'] } }), graph, 2000);
    expect(compile).toHaveBeenCalledTimes(1);
  });

  it('compiles again for a different amount or wallet, and after the TTL', async () => {
    const { p, compile } = provider();
    await compileWithCache(p, intent(), graph, 1000);
    await compileWithCache(p, intent({ inputAmountRaw: '2000000' }), graph, 1000);
    await compileWithCache(p, intent({ wallet: '0xdef' }), graph, 1000);
    await compileWithCache(p, intent(), graph, 1000 + COMPILE_CACHE_TTL_MS);
    expect(compile).toHaveBeenCalledTimes(4);
  });

  it('never caches a failed compile', async () => {
    const compile = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(compiled);
    const p = { identify: () => 'lifi-composer', compile } as unknown as BagExecutionProvider;
    await expect(compileWithCache(p, intent(), graph, 1000)).rejects.toThrow('boom');
    await expect(compileWithCache(p, intent(), graph, 1000)).resolves.toBe(compiled);
    expect(compile).toHaveBeenCalledTimes(2);
  });

  it('never caches a provider with compileQuote (its compile() signs a plan)', async () => {
    const { p, compile } = provider({ compileQuote: vi.fn() });
    await compileWithCache(p, intent(), graph, 1000);
    await compileWithCache(p, intent(), graph, 1000);
    expect(compile).toHaveBeenCalledTimes(2);
  });
});
