import { describe, expect, it } from 'vitest';
import { rankCandidates } from '../candidate-ranking';
import { ExecutionCandidate, CandidateMetrics } from '../candidate-types';
import { CompiledExecution } from '../types';

// -----------------------------------------------------------------------------
// Checkpoint 5 — candidate-ranking.ts. Spec section C's test list.
// -----------------------------------------------------------------------------

function metrics(overrides: Partial<CandidateMetrics> = {}): CandidateMetrics {
  return {
    quotedOutputUsd: null,
    quotedOutputBasis: 'PROVIDER_QUOTE',
    minimumGuaranteedOutputUsd: null,
    estimatedGasUsd: null,
    estimatedDurationSeconds: null,
    requestedSlippageBps: 100,
    ...overrides,
  };
}

function compiled(providerId: string): CompiledExecution {
  return {
    mode: 'MULTI_TX',
    chainId: 8453,
    transactions: [],
    expectedOutputs: [{ legId: 'leg_0', asset: { chain: 'base', address: '0xA' }, quotedOutputRaw: '1', quotedOutputBasis: 'PROVIDER_QUOTE', minimumGuaranteedOutputRaw: '1' }],
    providerId,
    executionPlanHash: 'hash-1',
  };
}

function executableCandidate(id: string, m: CandidateMetrics): ExecutionCandidate {
  return {
    id,
    providerId: id,
    compile: { status: 'COMPILED' },
    executionMode: 'MULTI_TX',
    compiled: compiled(id),
    metrics: m,
    executionPlanHash: 'hash-1',
    compiledAt: Date.now(),
  };
}

function failedCandidate(id: string): ExecutionCandidate {
  return {
    id,
    providerId: id,
    compile: { status: 'FAILED', failureReason: { kind: 'PROVIDER_ERROR', message: 'boom' } },
    executionMode: null,
    metrics: null,
    executionPlanHash: 'hash-1',
    compiledAt: Date.now(),
  };
}

describe('rankCandidates — executable/failed split', () => {
  it('separates COMPILED-with-metrics candidates from everything else, never dropping the failed ones', () => {
    const good = executableCandidate('a', metrics({ minimumGuaranteedOutputUsd: 100 }));
    const bad = failedCandidate('b');
    const result = rankCandidates([good, bad]);

    expect(result.executable.map((c) => c.id)).toEqual(['a']);
    expect(result.failed.map((c) => c.id)).toEqual(['b']);
  });

  it('a COMPILED candidate with metrics still null (annotation never ran) counts as not-executable for ranking purposes', () => {
    const notAnnotated: ExecutionCandidate = { ...executableCandidate('a', metrics()), metrics: null };
    const result = rankCandidates([notAnnotated]);
    expect(result.executable).toHaveLength(0);
    expect(result.failed).toHaveLength(1);
  });
});

describe('rankCandidates — bestGuaranteedOutput (enforced floors only)', () => {
  it('picks the candidate with the highest minimumGuaranteedOutputUsd', () => {
    const a = executableCandidate('a', metrics({ minimumGuaranteedOutputUsd: 990 }));
    const b = executableCandidate('b', metrics({ minimumGuaranteedOutputUsd: 998 }));
    const result = rankCandidates([a, b]);
    expect(result.winners.find((w) => w.category === 'bestGuaranteedOutput')?.candidateId).toBe('b');
  });

  it('NO winner when one candidate cannot guarantee a floor (e.g. a simulation-only provider) — it is never silently dropped so the other can "win"', () => {
    const composerLike = executableCandidate('a', metrics({ quotedOutputUsd: 1010, quotedOutputBasis: 'SIMULATION', minimumGuaranteedOutputUsd: null }));
    const b = executableCandidate('b', metrics({ minimumGuaranteedOutputUsd: 500 }));
    expect(rankCandidates([composerLike, b]).winners.find((w) => w.category === 'bestGuaranteedOutput')).toBeUndefined();
  });

  it('NO winner with a single executable candidate — one route is not "best" of anything', () => {
    const a = executableCandidate('a', metrics({ minimumGuaranteedOutputUsd: 100 }));
    expect(rankCandidates([a]).winners).toEqual([]);
  });

  it('NO winner on an exact tie — naming one of two equal routes "best" would claim a difference that does not exist', () => {
    const a = executableCandidate('a', metrics({ minimumGuaranteedOutputUsd: 500 }));
    const b = executableCandidate('b', metrics({ minimumGuaranteedOutputUsd: 500 }));
    expect(rankCandidates([a, b]).winners.find((w) => w.category === 'bestGuaranteedOutput')).toBeUndefined();
    expect(rankCandidates([b, a]).winners.find((w) => w.category === 'bestGuaranteedOutput')).toBeUndefined();
  });

  it('a tie for SECOND place does not block a strict leader', () => {
    const a = executableCandidate('a', metrics({ minimumGuaranteedOutputUsd: 400 }));
    const b = executableCandidate('b', metrics({ minimumGuaranteedOutputUsd: 400 }));
    const c = executableCandidate('c', metrics({ minimumGuaranteedOutputUsd: 401 }));
    expect(rankCandidates([a, b, c]).winners.find((w) => w.category === 'bestGuaranteedOutput')?.candidateId).toBe('c');
  });
});

describe('rankCandidates — bestQuotedOutput (same-basis quotes only)', () => {
  it('ranks expected outputs when every candidate\'s quote has the SAME basis', () => {
    const a = executableCandidate('a', metrics({ quotedOutputUsd: 1000, quotedOutputBasis: 'PROVIDER_QUOTE' }));
    const b = executableCandidate('b', metrics({ quotedOutputUsd: 1005, quotedOutputBasis: 'PROVIDER_QUOTE' }));
    expect(rankCandidates([a, b]).winners.find((w) => w.category === 'bestQuotedOutput')?.candidateId).toBe('b');
  });

  it('NEVER races a provider quote against a simulation — no winner even though the simulation is numerically higher', () => {
    const quote = executableCandidate('lifi-sequential', metrics({ quotedOutputUsd: 1000, quotedOutputBasis: 'PROVIDER_QUOTE', minimumGuaranteedOutputUsd: 990 }));
    const sim = executableCandidate('lifi-composer', metrics({ quotedOutputUsd: 1010, quotedOutputBasis: 'SIMULATION', minimumGuaranteedOutputUsd: null }));
    const result = rankCandidates([quote, sim]);
    expect(result.winners.find((w) => w.category === 'bestQuotedOutput')).toBeUndefined();
    expect(result.winners.find((w) => w.category === 'bestGuaranteedOutput')).toBeUndefined();
  });

  it('a MIXED-basis candidate is never ranked on quoted output', () => {
    const a = executableCandidate('a', metrics({ quotedOutputUsd: 1000, quotedOutputBasis: 'MIXED' }));
    const b = executableCandidate('b', metrics({ quotedOutputUsd: 900, quotedOutputBasis: 'MIXED' }));
    expect(rankCandidates([a, b]).winners.find((w) => w.category === 'bestQuotedOutput')).toBeUndefined();
  });

  it('the generic, semantics-blind "bestOutput" category no longer exists', () => {
    const a = executableCandidate('a', metrics({ quotedOutputUsd: 1, minimumGuaranteedOutputUsd: 1, estimatedGasUsd: 1, estimatedDurationSeconds: 1 }));
    const b = executableCandidate('b', metrics({ quotedOutputUsd: 2, minimumGuaranteedOutputUsd: 2, estimatedGasUsd: 2, estimatedDurationSeconds: 2 }));
    expect(rankCandidates([a, b]).winners.map((w) => w.category)).not.toContain('bestOutput');
  });
});

describe('rankCandidates — lowestGas', () => {
  it('is never aliased/labeled as "Cheapest" — the category key itself is lowestGas', () => {
    const a = executableCandidate('a', metrics({ estimatedGasUsd: 5 }));
    const b = executableCandidate('b', metrics({ estimatedGasUsd: 6 }));
    const result = rankCandidates([a, b]);
    expect(result.winners.map((w) => w.category)).toContain('lowestGas');
    expect(result.winners.map((w) => w.category)).not.toContain('cheapest');
  });

  it('produces NO lowestGas winner when one candidate has a null estimatedGasUsd (bug fix: previously the null candidate was silently dropped and the other was crowned "Lowest Gas", falsely implying a real comparison happened)', () => {
    const bagRouter = executableCandidate('bag-router', metrics({ estimatedGasUsd: null }));
    const sequential = executableCandidate('lifi-sequential', metrics({ estimatedGasUsd: 2.5 }));
    const result = rankCandidates([bagRouter, sequential]);
    expect(result.winners.find((w) => w.category === 'lowestGas')).toBeUndefined();
  });

  it('is absent when no candidate reports a real gas figure', () => {
    const a = executableCandidate('a', metrics({ estimatedGasUsd: null }));
    const b = executableCandidate('b', metrics({ estimatedGasUsd: null }));
    const result = rankCandidates([a, b]);
    expect(result.winners.find((w) => w.category === 'lowestGas')).toBeUndefined();
  });

  it('picks the lowest, not the highest', () => {
    const cheap = executableCandidate('cheap', metrics({ estimatedGasUsd: 0.5 }));
    const expensive = executableCandidate('expensive', metrics({ estimatedGasUsd: 5 }));
    const result = rankCandidates([expensive, cheap]);
    expect(result.winners.find((w) => w.category === 'lowestGas')?.candidateId).toBe('cheap');
  });
});

describe('rankCandidates — fastest', () => {
  it('produces NO fastest winner when one candidate has a null duration (bug fix: previously the null candidate was silently dropped and the other was crowned "Fastest", falsely implying a real comparison happened)', () => {
    const composer = executableCandidate('lifi-composer', metrics({ estimatedDurationSeconds: null }));
    const sequential = executableCandidate('lifi-sequential', metrics({ estimatedDurationSeconds: 45 }));
    const result = rankCandidates([composer, sequential]);
    expect(result.winners.find((w) => w.category === 'fastest')).toBeUndefined();
  });

  it('is absent when no candidate reports a duration', () => {
    const a = executableCandidate('a', metrics({ estimatedDurationSeconds: null }));
    const result = rankCandidates([a]);
    expect(result.winners.find((w) => w.category === 'fastest')).toBeUndefined();
  });

  it('picks the lowest duration', () => {
    const slow = executableCandidate('slow', metrics({ estimatedDurationSeconds: 90 }));
    const fast = executableCandidate('fast', metrics({ estimatedDurationSeconds: 12 }));
    const result = rankCandidates([slow, fast]);
    expect(result.winners.find((w) => w.category === 'fastest')?.candidateId).toBe('fast');
  });
});

describe('rankCandidates — no "balanced" category in Phase 1', () => {
  it('never produces a balanced/weighted category, however much data is available', () => {
    const a = executableCandidate('a', metrics({ minimumGuaranteedOutputUsd: 100, estimatedGasUsd: 1, estimatedDurationSeconds: 10 }));
    const b = executableCandidate('b', metrics({ minimumGuaranteedOutputUsd: 99, estimatedGasUsd: 2, estimatedDurationSeconds: 5 }));
    const result = rankCandidates([a, b]);
    expect(result.winners.map((w) => w.category)).not.toContain('balanced');
  });
});

describe('rankCandidates — unknown-metric candidates never produce a misleading winner', () => {
  // Ranking bug fix: a category must only name a winner when EVERY
  // executable candidate has real data for that metric. Silently excluding
  // the unknown candidate and crowning the other one implies a comparison
  // took place when it didn't.

  it('1. lowestGas: A gas=null, B gas=1 → no winner (B is not incorrectly crowned)', () => {
    const a = executableCandidate('a', metrics({ estimatedGasUsd: null }));
    const b = executableCandidate('b', metrics({ estimatedGasUsd: 1 }));
    const result = rankCandidates([a, b]);
    expect(result.winners.find((w) => w.category === 'lowestGas')).toBeUndefined();
  });

  it('2. fastest: A duration=null, B duration=5 → no winner (B is not incorrectly crowned)', () => {
    const a = executableCandidate('a', metrics({ estimatedDurationSeconds: null }));
    const b = executableCandidate('b', metrics({ estimatedDurationSeconds: 5 }));
    const result = rankCandidates([a, b]);
    expect(result.winners.find((w) => w.category === 'fastest')).toBeUndefined();
  });

  it('3. lowestGas: when both candidates report real gas, the correct (lower) one wins', () => {
    const a = executableCandidate('a', metrics({ estimatedGasUsd: 3 }));
    const b = executableCandidate('b', metrics({ estimatedGasUsd: 1 }));
    const result = rankCandidates([a, b]);
    expect(result.winners.find((w) => w.category === 'lowestGas')?.candidateId).toBe('b');
  });

  it('4. fastest: when both candidates report real duration, the correct (lower) one wins', () => {
    const a = executableCandidate('a', metrics({ estimatedDurationSeconds: 30 }));
    const b = executableCandidate('b', metrics({ estimatedDurationSeconds: 5 }));
    const result = rankCandidates([a, b]);
    expect(result.winners.find((w) => w.category === 'fastest')?.candidateId).toBe('b');
  });

  it('5. bestGuaranteedOutput: same missing-metric semantics apply — A=null, B=100 → no winner, but with both present the higher one wins', () => {
    const a = executableCandidate('a', metrics({ minimumGuaranteedOutputUsd: null }));
    const b = executableCandidate('b', metrics({ minimumGuaranteedOutputUsd: 100 }));
    const missing = rankCandidates([a, b]);
    expect(missing.winners.find((w) => w.category === 'bestGuaranteedOutput')).toBeUndefined();

    const c = executableCandidate('c', metrics({ minimumGuaranteedOutputUsd: 90 }));
    const d = executableCandidate('d', metrics({ minimumGuaranteedOutputUsd: 100 }));
    const both = rankCandidates([c, d]);
    expect(both.winners.find((w) => w.category === 'bestGuaranteedOutput')?.candidateId).toBe('d');
  });

  it('a category with a THIRD candidate missing the metric is also absent, not just 2-candidate sets', () => {
    const a = executableCandidate('a', metrics({ estimatedGasUsd: 1 }));
    const b = executableCandidate('b', metrics({ estimatedGasUsd: 2 }));
    const c = executableCandidate('c', metrics({ estimatedGasUsd: null }));
    const result = rankCandidates([a, b, c]);
    expect(result.winners.find((w) => w.category === 'lowestGas')).toBeUndefined();
  });
});

describe('rankCandidates — failed candidates never win a category', () => {
  it('a FAILED candidate is excluded from every category regardless of any stray metrics data', () => {
    const failed = failedCandidate('a');
    const good = executableCandidate('b', metrics({ minimumGuaranteedOutputUsd: 1, estimatedGasUsd: 1, estimatedDurationSeconds: 1 }));
    const other = executableCandidate('c', metrics({ minimumGuaranteedOutputUsd: 0.5, estimatedGasUsd: 2, estimatedDurationSeconds: 2 }));
    const result = rankCandidates([failed, good, other]);
    expect(result.winners.length).toBeGreaterThan(0);
    for (const winner of result.winners) {
      expect(winner.candidateId).toBe('b');
    }
    // One failed + ONE valid candidate: the valid one is executable, but with nothing to compare against it wins nothing.
    expect(rankCandidates([failed, good]).winners).toEqual([]);
  });
});
