import crypto from 'crypto';
import { ExecutionPlan } from '@/types/basket-protocol';

// -----------------------------------------------------------------------------
// Phase 17 — spec Aşama 3/9: "Quote fingerprint değişmişse eski intent
// execute edilmesin." A `PurchaseIntent` is created from a specific
// `ExecutionPlan` (bag recipe + allocation math + amount, at that moment).
// If the Bag's recipe changes (or, in principle, the allocation math itself
// ever changed) between intent creation and execute, the OLD intent must
// not be treated as still describing the current Bag — this fingerprint is
// what `/api/purchase-intent/[id]/execute` recomputes-and-compares against
// the stored value to detect that drift, without needing to persist the
// entire plan twice or re-call LI.FI just to check for staleness.
//
// Deliberately built from `ExecutionPlan` ONLY (not the live LI.FI quote,
// which is expected to fluctuate run-to-run and is not what "stale" means
// here) — see lib/blockchain/lifi-purchase-quote.ts for where the real,
// wallet-bound LI.FI quote is fetched fresh, every time, independent of
// this fingerprint.
// -----------------------------------------------------------------------------

export function computeExecutionPlanFingerprint(plan: ExecutionPlan): string {
  // Canonical, order-preserving JSON — `plan.steps` is already deterministically
  // ordered by `buildExecutionPlan()` (one entry per recipe asset, recipe
  // order), so no extra sorting is needed here; sorting would just hide a
  // genuine reordering (e.g. recipe assets reordered) that SHOULD count as
  // a changed plan.
  const canonical = JSON.stringify({
    bagId: plan.bagId,
    inputAsset: plan.inputAsset,
    inputAmountRaw: plan.inputAmountRaw,
    unallocatedRaw: plan.unallocatedRaw,
    steps: plan.steps.map((s) => ({
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
