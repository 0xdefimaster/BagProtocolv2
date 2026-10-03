import { DepositPlan, ExecutionPlan, ExecutionStep } from '@/types/basket-protocol';

// -----------------------------------------------------------------------------
// Phase 10 — Deposit → Allocation → EXECUTION PLAN.
//
// `buildExecutionPlan()` is the seam spec section 7 asks for: it turns a
// `DepositPlan` (pure value split, no notion of "route" or "swap" yet)
// into a router-agnostic `ExecutionPlan` — one `ExecutionRouteRequest` per
// allocation that actually needs a trade. Nothing here calls LI.FI,
// Robinhood Chain, ATLAS, or any other router (spec section 10/11) — that
// is `ExecutionAdapter`'s job (lib/blockchain/execution-adapter.ts), which
// consumes this file's OUTPUT and is the only later layer allowed to
// reach out to a real quote/route API.
//
// Pure and synchronous, same convention as every other planner in this
// domain (`calculateDepositAllocation()`, `calculateRebalancePlan()`).
// -----------------------------------------------------------------------------

/**
 * Builds an `ExecutionPlan` from a `DepositPlan`. Skips every allocation
 * with `valueRaw === "0"` — covers both the `KEEP`-but-nothing-to-do case
 * (an input asset that also happens to be a 0%-weight target — degenerate
 * but not invalid) and the 0%-weight `SWAP` case spec section 17's "Zero
 * weight" test asks for: a target asset with 0% weight produces NO
 * execution step, even though it still appears in
 * `DepositPlan.allocations` for transparency.
 *
 * A `KEEP` allocation with a nonzero value DOES produce a step — the UI
 * and any future execution layer need to know "this much of the deposit
 * stays as-is", even though no route/quote is ever requested for it (see
 * `lib/blockchain/execution-adapter.ts`'s `MockExecutionAdapter`, which
 * returns a `null` quote for `KEEP` steps rather than skipping them).
 */
export function buildExecutionPlan(depositPlan: DepositPlan): ExecutionPlan {
  const steps: ExecutionStep[] = [];

  for (const allocation of depositPlan.allocations) {
    if (BigInt(allocation.valueRaw) === BigInt(0)) continue;

    steps.push({
      action: allocation.action,
      targetSymbol: allocation.targetSymbol,
      route: {
        inputAsset: depositPlan.inputAsset,
        inputAmountRaw: allocation.valueRaw,
        outputAsset: allocation.targetAsset,
        targetValueRaw: allocation.valueRaw,
        sourceChain: depositPlan.inputAsset.chain,
        destinationChain: allocation.targetAsset.chain,
      },
    });
  }

  return {
    bagId: depositPlan.bagId,
    inputAsset: depositPlan.inputAsset,
    inputAmountRaw: depositPlan.inputAmountRaw,
    steps,
    unallocatedRaw: depositPlan.unallocatedRaw,
  };
}
