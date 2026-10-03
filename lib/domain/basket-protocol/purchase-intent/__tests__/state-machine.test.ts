import { describe, expect, it } from 'vitest';
import {
  assertValidPurchaseIntentStepTransition,
  assertValidPurchaseIntentTransition,
  InvalidPurchaseIntentStepTransitionError,
  InvalidPurchaseIntentTransitionError,
  isTerminalPurchaseIntentStatus,
  isValidPurchaseIntentStepTransition,
  isValidPurchaseIntentTransition,
} from '../state-machine';
import { PURCHASE_INTENT_STATUSES, PURCHASE_INTENT_STEP_STATUSES } from '@/types/purchase-intent';

describe('isValidPurchaseIntentTransition', () => {
  it('allows the documented happy path end to end', () => {
    const happyPath: [string, string][] = [
      ['DRAFT', 'QUOTED'],
      ['QUOTED', 'READY'],
      ['READY', 'AWAITING_SIGNATURE'],
      ['AWAITING_SIGNATURE', 'SUBMITTED'],
      ['SUBMITTED', 'CONFIRMING'],
      ['CONFIRMING', 'COMPLETED'],
    ];
    for (const [from, to] of happyPath) {
      expect(isValidPurchaseIntentTransition(from as never, to as never)).toBe(true);
    }
  });

  it('allows a same-status no-op from every status (idempotent writes)', () => {
    for (const status of PURCHASE_INTENT_STATUSES) {
      expect(isValidPurchaseIntentTransition(status, status)).toBe(true);
    }
  });

  it('rejects skipping straight from DRAFT to COMPLETED', () => {
    expect(isValidPurchaseIntentTransition('DRAFT', 'COMPLETED')).toBe(false);
  });

  it('rejects any outgoing transition from a terminal status other than the no-op', () => {
    for (const status of ['COMPLETED', 'FAILED', 'EXPIRED', 'CANCELLED'] as const) {
      for (const target of PURCHASE_INTENT_STATUSES) {
        if (target === status) continue;
        expect(isValidPurchaseIntentTransition(status, target)).toBe(false);
      }
    }
  });

  it('rejects moving backwards once a transaction has been submitted (no re-signing after submit)', () => {
    expect(isValidPurchaseIntentTransition('SUBMITTED', 'AWAITING_SIGNATURE')).toBe(false);
    expect(isValidPurchaseIntentTransition('CONFIRMING', 'AWAITING_SIGNATURE')).toBe(false);
  });

  it('allows failure/cancellation/expiry from every non-terminal status', () => {
    const nonTerminal = ['DRAFT', 'QUOTED', 'READY', 'AWAITING_SIGNATURE'] as const;
    for (const status of nonTerminal) {
      expect(isValidPurchaseIntentTransition(status, 'FAILED')).toBe(true);
      expect(isValidPurchaseIntentTransition(status, 'CANCELLED')).toBe(true);
      expect(isValidPurchaseIntentTransition(status, 'EXPIRED')).toBe(true);
    }
    // Once broadcast, a purchase can no longer be silently cancelled/expired client-side.
    expect(isValidPurchaseIntentTransition('SUBMITTED', 'CANCELLED')).toBe(false);
    expect(isValidPurchaseIntentTransition('CONFIRMING', 'EXPIRED')).toBe(false);
  });
});

describe('assertValidPurchaseIntentTransition', () => {
  it('throws InvalidPurchaseIntentTransitionError for an invalid transition', () => {
    expect(() => assertValidPurchaseIntentTransition('DRAFT', 'COMPLETED')).toThrow(
      InvalidPurchaseIntentTransitionError
    );
  });

  it('does not throw for a valid transition', () => {
    expect(() => assertValidPurchaseIntentTransition('DRAFT', 'QUOTED')).not.toThrow();
  });
});

describe('isTerminalPurchaseIntentStatus', () => {
  // Phase 18: RECONCILIATION_REQUIRED joins the terminal set (a
  // PARTIAL_SUCCESS intent always resolves TO it — see
  // reconcilePartialExecution() — but nothing ever transitions OUT of it;
  // see PURCHASE_INTENT_STATUSES's doc comment in types/purchase-intent.ts
  // for why a correct partial-share-mint isn't invented here). This test
  // previously asserted "exactly four" terminal statuses — that assertion
  // is now obsolete, not this behavior; five is correct.
  it('flags exactly the five terminal statuses', () => {
    const terminal = PURCHASE_INTENT_STATUSES.filter(isTerminalPurchaseIntentStatus);
    expect(terminal.sort()).toEqual(['CANCELLED', 'COMPLETED', 'EXPIRED', 'FAILED', 'RECONCILIATION_REQUIRED'].sort());
  });

  it('does NOT flag PARTIAL_SUCCESS as terminal — it always advances to RECONCILIATION_REQUIRED', () => {
    expect(isTerminalPurchaseIntentStatus('PARTIAL_SUCCESS')).toBe(false);
  });
});

describe('isValidPurchaseIntentStepTransition', () => {
  it('allows the full approval + swap happy path', () => {
    const happyPath: [string, string][] = [
      ['PENDING', 'APPROVAL_REQUIRED'],
      ['APPROVAL_REQUIRED', 'APPROVAL_AWAITING_SIGNATURE'],
      ['APPROVAL_AWAITING_SIGNATURE', 'APPROVAL_SUBMITTED'],
      ['APPROVAL_SUBMITTED', 'APPROVAL_CONFIRMED'],
      ['APPROVAL_CONFIRMED', 'AWAITING_SIGNATURE'],
      ['AWAITING_SIGNATURE', 'SUBMITTED'],
      ['SUBMITTED', 'CONFIRMING'],
      ['CONFIRMING', 'COMPLETED'],
    ];
    for (const [from, to] of happyPath) {
      expect(isValidPurchaseIntentStepTransition(from as never, to as never)).toBe(true);
    }
  });

  it('allows skipping approval when the route needs none (PENDING -> AWAITING_SIGNATURE)', () => {
    expect(isValidPurchaseIntentStepTransition('PENDING', 'AWAITING_SIGNATURE')).toBe(true);
  });

  it('allows a same-status no-op from every step status', () => {
    for (const status of PURCHASE_INTENT_STEP_STATUSES) {
      expect(isValidPurchaseIntentStepTransition(status, status)).toBe(true);
    }
  });

  it('rejects a NOT_NEEDED (KEEP) step ever moving to any executing status', () => {
    for (const target of PURCHASE_INTENT_STEP_STATUSES) {
      if (target === 'NOT_NEEDED') continue;
      expect(isValidPurchaseIntentStepTransition('NOT_NEEDED', target)).toBe(false);
    }
  });

  it('rejects moving backwards once SUBMITTED', () => {
    expect(isValidPurchaseIntentStepTransition('SUBMITTED', 'AWAITING_SIGNATURE')).toBe(false);
    expect(isValidPurchaseIntentStepTransition('CONFIRMING', 'SUBMITTED')).toBe(false);
  });

  it('allows FAILED from every non-terminal step status', () => {
    const nonTerminal = PURCHASE_INTENT_STEP_STATUSES.filter((s) => !['NOT_NEEDED', 'COMPLETED', 'FAILED'].includes(s));
    for (const status of nonTerminal) {
      expect(isValidPurchaseIntentStepTransition(status, 'FAILED')).toBe(true);
    }
  });
});

describe('assertValidPurchaseIntentStepTransition', () => {
  it('throws InvalidPurchaseIntentStepTransitionError with the step index for an invalid transition', () => {
    try {
      assertValidPurchaseIntentStepTransition(2, 'SUBMITTED', 'AWAITING_SIGNATURE');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidPurchaseIntentStepTransitionError);
      expect((err as InvalidPurchaseIntentStepTransitionError).stepIndex).toBe(2);
    }
  });
});
