import { PurchaseIntent, PurchaseIntentStepRecord } from '@/types/purchase-intent';
import { ExecutionMode } from './types';

// -----------------------------------------------------------------------------
// lib/execution/signing-expectation.ts
//
// Item 8. `ExecutionMode`'s own doc states the rule this module enforces:
// "never let the UI say '1 signature' when the compiled result is actually
// MULTI_TX". Before this, `CompiledExecution.mode` was computed and then
// dropped, and `PurchasePreviewModal` told every user the same singular
// sentence ("signs and sends a real transaction") regardless of whether the
// purchase was one Composer transaction or a sequential LI.FI plan needing
// an approval plus a swap per leg.
//
// Deliberately a PURE function over data the intent already carries — no
// React, no fetch, no provider knowledge. The UI renders what this returns;
// it does not do its own arithmetic over steps, so there is exactly one
// place where "how many wallet confirmations is this?" is decided.
//
// The honesty rule, applied in both directions:
//   - Never under-report. A MULTI_TX plan says so, with its real count.
//   - Never over-claim precision. When the mode is unknown (a legacy,
//     flag-off intent that never had a compiler-determined mode), this
//     returns `exact: false` and a range-free description derived from the
//     steps themselves, rather than asserting a number it cannot know.
// -----------------------------------------------------------------------------

export interface SigningExpectation {
  /**
   * Wallet confirmations the user should expect, counting approvals AND
   * sends. `null` when the mode is unknown and the step data isn't enough
   * to commit to a number — the UI must then describe rather than count.
   */
  walletConfirmations: number | null;
  /** True only when `walletConfirmations` is a figure the compiler actually determined, not an estimate. */
  exact: boolean;
  /** Short label for the primary line, e.g. "1 wallet confirmation". */
  summary: string;
  /** One sentence of detail, safe to show verbatim. */
  detail: string;
  /** True when at least one ERC-20 approval is expected before the swap(s). */
  includesApproval: boolean;
  /** Passed through so a caller can branch on the raw mode without re-reading the intent. */
  mode: ExecutionMode | null;
}

/** SWAP steps are the only ones that cost a wallet interaction; KEEP steps move nothing. */
function countSwapSteps(steps: PurchaseIntentStepRecord[]): number {
  return steps.filter((s) => s.action === 'SWAP').length;
}

/**
 * Derives the wallet expectation for `intent`.
 *
 * `assumeApprovalNeeded` exists because whether an ERC-20 approval is
 * actually required depends on the wallet's CURRENT on-chain allowance,
 * which the server cannot know at quote time. Callers that have checked
 * an allowance can pass `false`; the default is `true` because
 * over-preparing a user for one extra confirmation is a far smaller harm
 * than surprising them with one — and both LI.FI paths and the BAG router
 * pull funds via `transferFrom`, so an approval is the common case.
 */
export function deriveSigningExpectation(
  intent: Pick<PurchaseIntent, 'executionMode' | 'steps'> & Partial<Pick<PurchaseIntent, 'composerTransaction'>>,
  assumeApprovalNeeded = true
): SigningExpectation {
  const swapCount = countSwapSteps(intent.steps);
  // A legacy (flag-off) intent has no compiler mode, but one carrying a
  // Composer transaction is still exactly one transaction for every leg.
  const mode = intent.executionMode ?? (intent.composerTransaction ? 'SINGLE_TX' : null);

  if (mode === 'SINGLE_TX') {
    // One transaction covering every leg. An approval may still precede it
    // — `ProviderCapabilities.requiresApproval` is true for both the
    // Composer provider and the BAG router, and Permit2 is explicitly a
    // later phase — so "single transaction" is NOT the same claim as
    // "single confirmation", and this function never conflates them.
    const confirmations = assumeApprovalNeeded ? 2 : 1;
    return {
      walletConfirmations: confirmations,
      exact: true,
      mode,
      includesApproval: assumeApprovalNeeded,
      summary: confirmations === 1 ? '1 wallet confirmation' : '2 wallet confirmations',
      detail: assumeApprovalNeeded
        ? 'One token approval, then a single transaction that performs the whole purchase.'
        : 'A single transaction performs the whole purchase.',
    };
  }

  if (mode === 'MULTI_TX') {
    // One swap per leg, each its own confirmation, plus one approval.
    const confirmations = swapCount + (assumeApprovalNeeded ? 1 : 0);
    return {
      walletConfirmations: confirmations,
      exact: true,
      mode,
      includesApproval: assumeApprovalNeeded,
      summary: `${confirmations} wallet confirmations`,
      detail: assumeApprovalNeeded
        ? `One token approval, then ${swapCount} separate swap ${swapCount === 1 ? 'transaction' : 'transactions'} — one per asset in this bag.`
        : `${swapCount} separate swap ${swapCount === 1 ? 'transaction' : 'transactions'} — one per asset in this bag.`,
    };
  }

  if (mode === 'CROSS_CHAIN') {
    // Deliberately NOT given a precise count: a cross-chain execution adds
    // a bridge wait whose confirmation count depends on the route the
    // provider picked, and `ExecutionMode`'s own doc is explicit that this
    // is its own mode precisely because of that extra step.
    return {
      walletConfirmations: null,
      exact: false,
      mode,
      includesApproval: assumeApprovalNeeded,
      summary: 'Multiple wallet confirmations',
      detail:
        'This purchase bridges between chains. It needs several confirmations and a waiting period between them; the exact number depends on the route.',
    };
  }

  if (mode === 'UNSUPPORTED') {
    return {
      walletConfirmations: null,
      exact: false,
      mode,
      includesApproval: false,
      summary: 'Not executable',
      detail: 'No execution route is currently available for this purchase.',
    };
  }

  // mode === null — a legacy (flag-off) intent. The steps are still real,
  // so describe from them, but flag the count as an estimate rather than
  // claiming the compiler determined it.
  return {
    walletConfirmations: null,
    exact: false,
    mode: null,
    includesApproval: assumeApprovalNeeded,
    summary: swapCount > 1 ? 'Multiple wallet confirmations' : 'Wallet confirmation required',
    detail:
      swapCount > 1
        ? `This purchase swaps into ${swapCount} assets. Expect a token approval followed by one transaction per asset.`
        : 'Expect a token approval followed by the purchase transaction.',
  };
}
