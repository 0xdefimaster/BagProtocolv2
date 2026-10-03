import crypto from 'crypto';
import { ExecutionStep } from '@/types/basket-protocol';

// -----------------------------------------------------------------------------
// Phase 21 — redeem-side counterpart to purchase-intent/fingerprint.ts's
// computeExecutionPlanFingerprint(). Same purpose (detect "the thing this
// intent was quoted against has changed since creation, refuse to execute
// a stale intent"), but over a redemption's own shape rather than
// `ExecutionPlan`: a redemption has no single `inputAsset`/`inputAmountRaw`
// (see redeem/allocation.ts's module doc — its steps span however many
// distinct source assets this depositor's own holdings contain), so
// reusing `ExecutionPlan`'s fields here would mean stuffing redeem-specific
// concepts (sharesToRedeemRaw, outputAsset) into fields named for a
// different thing. A small dedicated function keeps what's actually being
// fingerprinted legible.
// -----------------------------------------------------------------------------

export interface RedeemFingerprintInput {
  bagId: string;
  sharesToRedeemRaw: string;
  outputAsset: { chain: string; address: string };
  steps: ExecutionStep[];
}

export function computeRedeemFingerprint(input: RedeemFingerprintInput): string {
  // Canonical, order-preserving JSON — `input.steps` is deterministically
  // ordered by `buildRedeemExecutionSteps()` (one entry per non-zero
  // holding, in `bag_investor_holdings` read order), same rationale
  // computeExecutionPlanFingerprint() gives for not re-sorting: a genuine
  // reordering should count as a changed plan, not be hidden.
  const canonical = JSON.stringify({
    bagId: input.bagId,
    sharesToRedeemRaw: input.sharesToRedeemRaw,
    outputAsset: input.outputAsset,
    steps: input.steps.map((s) => ({
      action: s.action,
      targetSymbol: s.targetSymbol,
      inputAsset: s.route.inputAsset,
      inputAmountRaw: s.route.inputAmountRaw,
      outputAsset: s.route.outputAsset,
      targetValueRaw: s.route.targetValueRaw,
      sourceChain: s.route.sourceChain,
      destinationChain: s.route.destinationChain,
      slippageBps: s.route.slippageBps ?? null,
    })),
  });

  return crypto.createHash('sha256').update(canonical).digest('hex');
}
