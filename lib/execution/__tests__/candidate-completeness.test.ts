import { describe, expect, it } from 'vitest';
import { validateCandidateCompleteness } from '../candidate-completeness';
import { BagExecutionGraph, CompiledExecution } from '../types';

// -----------------------------------------------------------------------------
// Checkpoint 0 — proves a PARTIAL `CompiledExecution` (spec item 1's
// BTC ✓ / ETH ✓ / SOL ✗ / LINK ✓ example) can never satisfy the candidate
// completeness invariant, before any of `compileBagExecutionCandidates()`,
// metrics, or ranking exist. Pure — no providers, no network.
// -----------------------------------------------------------------------------

function makeGraph(legOverrides: Partial<BagExecutionGraph['legs'][number]>[] = [{}]): BagExecutionGraph {
  return {
    bagId: 'bag_1',
    wallet: '0xWallet',
    chainId: 'base',
    inputAsset: { chain: 'base', address: '0xInput' },
    inputAmountRaw: '4000000',
    legs: legOverrides.map((overrides, i) => ({
      id: `leg_${i}`,
      sourceAsset: { chain: 'base', address: '0xInput' },
      targetAsset: { chain: 'base', address: `0xTarget${i}` },
      amountRaw: '1000000',
      weightBps: 2500,
      minimumOutputRaw: null,
      slippageBps: 100,
      chain: 'base',
      dependsOn: [],
      ...overrides,
    })),
    unallocatedRaw: '0',
  };
}

function makeCompiled(overrides: Partial<CompiledExecution> = {}): CompiledExecution {
  return {
    mode: 'MULTI_TX',
    chainId: 8453,
    transactions: [],
    expectedOutputs: [],
    providerId: 'test-provider',
    executionPlanHash: 'hash',
    ...overrides,
  };
}

/** An expected output with a genuine QUOTE and no guarantee claimed (the guarantee rules have their own tests below). */
const quoted = (raw: string) => ({ quotedOutputRaw: raw, quotedOutputBasis: 'PROVIDER_QUOTE' as const, minimumGuaranteedOutputRaw: null });

describe('validateCandidateCompleteness', () => {
  it('accepts a fully complete result: every leg has exactly one genuine expected output', () => {
    const graph = makeGraph([{}, {}]);
    const compiled = makeCompiled({
      expectedOutputs: [
        { legId: 'leg_0', asset: graph.legs[0].targetAsset, ...quoted('990000') },
        { legId: 'leg_1', asset: graph.legs[1].targetAsset, ...quoted('985000') },
      ],
    });
    expect(validateCandidateCompleteness(graph, compiled)).toEqual({ ok: true });
  });

  it('THE spec-item-1 example: BTC ✓ / ETH ✓ / SOL ✗ / LINK ✓ — a missing leg fails the whole candidate', () => {
    const graph = makeGraph([{ id: 'leg_btc' }, { id: 'leg_eth' }, { id: 'leg_sol' }, { id: 'leg_link' }]);
    const compiled = makeCompiled({
      expectedOutputs: [
        { legId: 'leg_btc', asset: graph.legs[0].targetAsset, ...quoted('100') },
        { legId: 'leg_eth', asset: graph.legs[1].targetAsset, ...quoted('200') },
        // leg_sol deliberately omitted — this is the failed leg.
        { legId: 'leg_link', asset: graph.legs[3].targetAsset, ...quoted('400') },
      ],
    });
    const result = validateCandidateCompleteness(graph, compiled);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason.kind).toBe('INCOMPLETE_RESULT');
      // 3 outputs for 4 legs trips the length-mismatch check first (cheapest
      // check, checked first per this module's own doc) — it reports every
      // leg id rather than singling out which one, which is still a correct
      // "not executable" verdict; the per-leg pinpointing case (same length,
      // wrong key) is covered by the dedicated "duplicated leg id" test below.
      expect(result.reason.legIds).toContain('leg_sol');
    }
  });

  it('rejects when expectedOutputs is shorter than graph.legs (length mismatch caught first)', () => {
    const graph = makeGraph([{}, {}, {}]);
    const compiled = makeCompiled({
      expectedOutputs: [{ legId: 'leg_0', asset: graph.legs[0].targetAsset, ...quoted('1') }],
    });
    const result = validateCandidateCompleteness(graph, compiled);
    expect(result.ok).toBe(false);
  });

  it('rejects a duplicated leg id (two outputs claiming the same leg)', () => {
    const graph = makeGraph([{}, {}]);
    const compiled = makeCompiled({
      expectedOutputs: [
        { legId: 'leg_0', asset: graph.legs[0].targetAsset, ...quoted('1') },
        { legId: 'leg_0', asset: graph.legs[0].targetAsset, ...quoted('2') },
      ],
    });
    const result = validateCandidateCompleteness(graph, compiled);
    expect(result.ok).toBe(false);
  });

  it('rejects an output whose asset does not match its leg\'s targetAsset (wrong keying)', () => {
    const graph = makeGraph([{}]);
    const compiled = makeCompiled({
      expectedOutputs: [{ legId: 'leg_0', asset: { chain: 'base', address: '0xSomethingElse' }, ...quoted('1') }],
    });
    const result = validateCandidateCompleteness(graph, compiled);
    expect(result.ok).toBe(false);
  });

  it('rejects a fabricated "0" fallback (Composer\'s degenerate simulated-amount-missing case) — a real swap never genuinely expects zero output', () => {
    const graph = makeGraph([{}]);
    const compiled = makeCompiled({
      expectedOutputs: [{ legId: 'leg_0', asset: graph.legs[0].targetAsset, ...quoted('0') }],
    });
    const result = validateCandidateCompleteness(graph, compiled);
    expect(result.ok).toBe(false);
  });

  it('rejects a non-numeric or negative quotedOutputRaw', () => {
    const graph = makeGraph([{}]);
    for (const bad of ['-5', 'NaN', '', '1.5']) {
      const compiled = makeCompiled({
        expectedOutputs: [{ legId: 'leg_0', asset: graph.legs[0].targetAsset, ...quoted(bad) }],
      });
      expect(validateCandidateCompleteness(graph, compiled).ok).toBe(false);
    }
  });

  it('accepts a single-digit positive output (e.g. "1") — the rule is "genuine", not "large"', () => {
    const graph = makeGraph([{}]);
    const compiled = makeCompiled({
      expectedOutputs: [{ legId: 'leg_0', asset: graph.legs[0].targetAsset, ...quoted('1') }],
    });
    expect(validateCandidateCompleteness(graph, compiled)).toEqual({ ok: true });
  });

  it('a missing quote (null) is rejected just like a fabricated "0"', () => {
    const graph = makeGraph([{}]);
    const compiled = makeCompiled({
      expectedOutputs: [{ legId: 'leg_0', asset: graph.legs[0].targetAsset, quotedOutputRaw: null, quotedOutputBasis: 'SIMULATION', minimumGuaranteedOutputRaw: null }],
    });
    expect(validateCandidateCompleteness(graph, compiled).ok).toBe(false);
  });

  describe('expected vs guaranteed are distinct fields with distinct rules', () => {
    const withGuarantee = (quotedRaw: string, guaranteed: string | null) => {
      const graph = makeGraph([{}]);
      return validateCandidateCompleteness(
        graph,
        makeCompiled({
          expectedOutputs: [{ legId: 'leg_0', asset: graph.legs[0].targetAsset, quotedOutputRaw: quotedRaw, quotedOutputBasis: 'PROVIDER_QUOTE', minimumGuaranteedOutputRaw: guaranteed }],
        })
      );
    };

    it('no guarantee (null) is legitimate — e.g. a simulation-only provider', () => {
      expect(withGuarantee('1000', null)).toEqual({ ok: true });
    });
    it('a guarantee below (or equal to) the quote is accepted', () => {
      expect(withGuarantee('1000', '990')).toEqual({ ok: true });
      expect(withGuarantee('1000', '1000')).toEqual({ ok: true });
    });
    it('a "guaranteed floor" ABOVE the provider\'s own quote is a malformed result and is rejected', () => {
      expect(withGuarantee('1000', '1001').ok).toBe(false);
    });
    it('a fabricated "0" or non-numeric guarantee is rejected (null is the only way to say "no guarantee")', () => {
      for (const bad of ['0', '-1', 'abc', '']) expect(withGuarantee('1000', bad).ok).toBe(false);
    });
  });
});
