import { describe, expect, it } from 'vitest';
import { toExecutionCandidateView, ExecutionCandidate } from '../candidate-types';

// -----------------------------------------------------------------------------
// Checkpoint 8, item 8 — "No raw failureReason is exposed to the user."
// `toExecutionCandidateView()` is the ONLY place a raw `ExecutionCandidate`
// (server-internal, carries the full `CandidateFailureReason.message` —
// e.g. a literal provider/network error string) turns into what
// `/api/bags/[id]/purchase-options` actually sends to the browser. This
// file locks in that the sanitization holds: `.message` must never survive
// into the view, only the coarse `.kind` category.
// -----------------------------------------------------------------------------

function makeFailedCandidate(message: string): ExecutionCandidate {
  return {
    id: 'lifi-sequential',
    providerId: 'lifi-sequential',
    compile: { status: 'FAILED', failureReason: { kind: 'PROVIDER_ERROR', message } },
    executionMode: null,
    metrics: null,
    executionPlanHash: 'hash_1',
    compiledAt: Date.now(),
  };
}

describe('toExecutionCandidateView', () => {
  it('never includes the raw failureReason.message, even when the internal candidate carries a sensitive/internal error string', () => {
    const internal = makeFailedCandidate('Internal LI.FI upstream 502 at https://internal-lifi-proxy.example/v2/quote?key=SECRET');
    const view = toExecutionCandidateView(internal);
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain('SECRET');
    expect(serialized).not.toContain('internal-lifi-proxy');
    expect(serialized).not.toContain('Internal LI.FI upstream 502');
  });

  it('preserves only the coarse failure category (failureReasonKind), not a free-text message field at all', () => {
    const internal = makeFailedCandidate('quote expired');
    const view = toExecutionCandidateView(internal);
    expect(view.compile.status).toBe('FAILED');
    expect(view.compile.failureReasonKind).toBe('PROVIDER_ERROR');
    expect('message' in view.compile).toBe(false);
    expect('failureReason' in view.compile).toBe(false);
  });

  it('a COMPILED candidate carries no failureReasonKind at all', () => {
    const compiled: ExecutionCandidate = {
      id: 'bag-router',
      providerId: 'bag-router',
      compile: { status: 'COMPILED' },
      executionMode: 'SINGLE_TX',
      compiled: { mode: 'SINGLE_TX', chainId: 1, transactions: [], expectedOutputs: [], providerId: 'bag-router', executionPlanHash: 'hash_1' },
      metrics: null,
      executionPlanHash: 'hash_1',
      compiledAt: Date.now(),
    };
    const view = toExecutionCandidateView(compiled);
    expect(view.compile.failureReasonKind).toBeUndefined();
  });

  it('still carries swapLegCount and every other display field unchanged', () => {
    const compiled: ExecutionCandidate = {
      id: 'bag-router',
      providerId: 'bag-router',
      compile: { status: 'COMPILED' },
      executionMode: 'SINGLE_TX',
      compiled: {
        mode: 'SINGLE_TX',
        chainId: 1,
        transactions: [],
        expectedOutputs: [
          { legId: 'leg_0', asset: { chain: 'base', address: '0xA' }, quotedOutputRaw: '1', quotedOutputBasis: 'PROVIDER_QUOTE', minimumGuaranteedOutputRaw: '1' },
          { legId: 'leg_1', asset: { chain: 'base', address: '0xB' }, quotedOutputRaw: '1', quotedOutputBasis: 'PROVIDER_QUOTE', minimumGuaranteedOutputRaw: '1' },
        ],
        providerId: 'bag-router',
        executionPlanHash: 'hash_1',
      },
      metrics: null,
      executionPlanHash: 'hash_1',
      compiledAt: 12345,
    };
    const view = toExecutionCandidateView(compiled);
    expect(view.swapLegCount).toBe(2);
    expect(view.compiledAt).toBe(12345);
    expect(view.providerId).toBe('bag-router');
  });
});
