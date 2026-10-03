import { describe, expect, it } from 'vitest';
import { deriveSigningExpectation } from '../signing-expectation';
import { PurchaseIntentStepRecord } from '@/types/purchase-intent';

// -----------------------------------------------------------------------------
// Item 8 — the rule under test is `ExecutionMode`'s own: the UI must never
// say "1 signature" when the compiled result is actually MULTI_TX. These
// tests pin BOTH directions of that honesty: never under-report a
// multi-transaction plan, and never assert a precise count for a mode the
// compiler didn't determine.
// -----------------------------------------------------------------------------

// Only `action` is read by the function under test; the rest of a real
// step record is irrelevant here, so these fixtures stay minimal rather
// than carrying fifteen fields no assertion depends on.
function swapStep(i: number): PurchaseIntentStepRecord {
  return { stepIndex: i, action: 'SWAP', status: 'QUOTED' } as unknown as PurchaseIntentStepRecord;
}
function keepStep(i: number): PurchaseIntentStepRecord {
  return { stepIndex: i, action: 'KEEP', status: 'NOT_NEEDED' } as unknown as PurchaseIntentStepRecord;
}

describe('deriveSigningExpectation — SINGLE_TX', () => {
  it('reports approval + one transaction, and does NOT conflate "one transaction" with "one confirmation"', () => {
    const e = deriveSigningExpectation({ executionMode: 'SINGLE_TX', steps: [swapStep(0), swapStep(1)] });
    expect(e.walletConfirmations).toBe(2);
    expect(e.exact).toBe(true);
    expect(e.includesApproval).toBe(true);
    expect(e.detail).toMatch(/single transaction/);
  });

  it('reports exactly one confirmation only when the caller has established no approval is needed', () => {
    const e = deriveSigningExpectation({ executionMode: 'SINGLE_TX', steps: [swapStep(0)] }, false);
    expect(e.walletConfirmations).toBe(1);
    expect(e.summary).toBe('1 wallet confirmation');
    expect(e.includesApproval).toBe(false);
  });

  it('does not grow the count with the number of legs — that is the whole point of SINGLE_TX', () => {
    const many = Array.from({ length: 8 }, (_, i) => swapStep(i));
    const e = deriveSigningExpectation({ executionMode: 'SINGLE_TX', steps: many });
    expect(e.walletConfirmations).toBe(2);
  });
});

describe('deriveSigningExpectation — MULTI_TX', () => {
  it('reports one confirmation per swap plus the approval, never a single signature', () => {
    const e = deriveSigningExpectation({
      executionMode: 'MULTI_TX',
      steps: [swapStep(0), swapStep(1), swapStep(2)],
    });
    expect(e.walletConfirmations).toBe(4);
    expect(e.exact).toBe(true);
    expect(e.summary).toBe('4 wallet confirmations');
    expect(e.detail).toMatch(/3 separate swap transactions/);
  });

  it('ignores KEEP steps, which cost no wallet interaction', () => {
    const e = deriveSigningExpectation({
      executionMode: 'MULTI_TX',
      steps: [swapStep(0), keepStep(1), swapStep(2), keepStep(3)],
    });
    expect(e.walletConfirmations).toBe(3); // 2 swaps + 1 approval
  });

  it('uses singular wording for a one-leg multi-tx plan', () => {
    const e = deriveSigningExpectation({ executionMode: 'MULTI_TX', steps: [swapStep(0)] });
    expect(e.detail).toMatch(/1 separate swap transaction\b/);
  });
});

describe('deriveSigningExpectation — modes without a knowable count', () => {
  it('refuses to state a precise count for CROSS_CHAIN, and says why', () => {
    const e = deriveSigningExpectation({ executionMode: 'CROSS_CHAIN', steps: [swapStep(0)] });
    expect(e.walletConfirmations).toBeNull();
    expect(e.exact).toBe(false);
    expect(e.detail).toMatch(/bridges between chains/);
  });

  it('reports UNSUPPORTED as not executable rather than as some number of signatures', () => {
    const e = deriveSigningExpectation({ executionMode: 'UNSUPPORTED', steps: [] });
    expect(e.walletConfirmations).toBeNull();
    expect(e.summary).toBe('Not executable');
  });

  it('treats a legacy (null-mode) intent as an estimate, never claiming compiler-determined precision', () => {
    const e = deriveSigningExpectation({ executionMode: null, steps: [swapStep(0), swapStep(1)] });
    expect(e.exact).toBe(false);
    expect(e.walletConfirmations).toBeNull();
    expect(e.detail).toMatch(/swaps into 2 assets/);
  });

  it('still describes a single-swap legacy intent usefully', () => {
    const e = deriveSigningExpectation({ executionMode: null, steps: [swapStep(0)] });
    expect(e.exact).toBe(false);
    expect(e.summary).toBe('Wallet confirmation required');
  });

  it('a legacy intent carrying a Composer transaction is one transaction, never "one per asset"', () => {
    const e = deriveSigningExpectation({
      executionMode: null,
      steps: [swapStep(0), swapStep(1), swapStep(2)],
      composerTransaction: { to: '0x0000000000000000000000000000000000000001', data: '0x', value: '0', chainId: 4663 } as never,
    });
    expect(e.mode).toBe('SINGLE_TX');
    expect(e.detail).not.toMatch(/one transaction per asset/);
    expect(e.detail).toMatch(/single transaction/);
  });
});
