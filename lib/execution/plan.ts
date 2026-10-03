import crypto from 'crypto';
import { ExecutionPlan } from '@/types/basket-protocol';
import { PurchaseIntent } from '@/types/purchase-intent';
import { BagExecutionGraph, BagExecutionIntent, BagExecutionLeg, BagExecutionTarget } from './types';
import { BagExecutionError } from './errors';

// -----------------------------------------------------------------------------
// lib/execution/plan.ts
//
// Bridges the EXISTING `ExecutionPlan` (lib/domain/basket-protocol/deposit/
// execution-plan.ts, unchanged — spec item 2 says "gerekirse genişlet", not
// "replace") into the new provider-independent `BagExecutionGraph`. Also
// bridges `PurchaseIntent` → `BagExecutionIntent` for callers that already
// hold one.
//
// `buildExecutionPlan()` itself is NOT touched here or anywhere else in
// this pass — it keeps producing exactly the same `ExecutionPlan` it always
// has; this module only translates that output into the new shape.
// -----------------------------------------------------------------------------

/** One-way, near-direct field mapping from an `ExecutionStep` to a `BagExecutionLeg` — `KEEP` steps are skipped (nothing to route, same as today's callers already assume) and each remaining `SWAP` step becomes exactly one flat leg (`dependsOn: []`) since today's basket purchase has no cross-leg ordering requirement. */
export function buildBagExecutionGraph(
  plan: ExecutionPlan,
  opts: { wallet: string; chainId: import('@/types/basket-protocol').ChainId; defaultSlippageBps: number }
): BagExecutionGraph {
  const legs: BagExecutionLeg[] = plan.steps
    .filter((step) => step.action === 'SWAP')
    .map((step, index) => ({
      id: `leg_${index}`,
      sourceAsset: step.route.inputAsset,
      targetAsset: step.route.outputAsset,
      amountRaw: step.route.inputAmountRaw,
      weightBps: computeLegWeightBps(step.route.targetValueRaw, plan.inputAmountRaw),
      minimumOutputRaw: null,
      slippageBps: step.route.slippageBps ?? opts.defaultSlippageBps,
      chain: step.route.destinationChain,
      dependsOn: [],
    }));

  return {
    bagId: plan.bagId,
    wallet: opts.wallet,
    chainId: opts.chainId,
    inputAsset: plan.inputAsset,
    inputAmountRaw: plan.inputAmountRaw,
    legs,
    unallocatedRaw: plan.unallocatedRaw,
  };
}

/** `targetValueRaw` is a VALUE in the input asset (see `ExecutionRouteRequest`'s own doc — never a quantity), so a weight is just its share of the total input. Guards against a zero total rather than dividing by zero — a plan with `inputAmountRaw === "0"` has no meaningful weights and every leg reports `0`. */
function computeLegWeightBps(targetValueRaw: string, totalInputRaw: string): number {
  const total = BigInt(totalInputRaw);
  if (total === BigInt(0)) return 0;
  return Number((BigInt(targetValueRaw) * BigInt(10000)) / total);
}

/**
 * Translates an existing `PurchaseIntent` into a `BagExecutionIntent` for a
 * caller that already has one (e.g. a future integration inside
 * `lib/server/purchase-execution.ts`). Deliberately lossy in ONE direction
 * only: fields with no equivalent in the new, provider-independent model
 * (per-step status, tx hashes, accounting flags) are simply absent from the
 * result — this function never invents a value for them, and it is not
 * meant to be inverted (`BagExecutionIntent` never round-trips back into a
 * full `PurchaseIntent`; that remains the job of whatever code persists a
 * `CompiledExecution`'s result).
 */
export function purchaseIntentToBagExecutionIntent(
  intent: PurchaseIntent,
  chainId: import('@/types/basket-protocol').ChainId,
  maxSlippageBps: number,
  deadlineMs: number
): BagExecutionIntent {
  const targets: BagExecutionTarget[] = intent.steps
    .filter((step) => step.action === 'SWAP')
    .map((step) => ({
      asset: step.outputAsset,
      weightBps: computeLegWeightBps(step.targetValueRaw, intent.inputAmountRaw),
      symbol: step.targetSymbol,
    }));

  return {
    bagId: intent.bagId,
    wallet: intent.walletAddress,
    chainId,
    inputAsset: intent.inputAsset,
    inputAmountRaw: intent.inputAmountRaw,
    targets,
    maxSlippageBps,
    deadline: deadlineMs,
    recipeVersion: intent.recipeVersion,
    compositionHash: intent.compositionHash,
  };
}

/**
 * Validates that `graph`'s legs are internally consistent BEFORE handing it
 * to the compiler (spec item 11's spirit applied one layer earlier — an
 * invalid graph should never even reach provider selection). Throws
 * `BagExecutionError('INVALID_EXECUTION_GRAPH', ...)` rather than returning
 * a boolean — an invalid graph is always a caller bug (a hand-built graph
 * that skipped `buildBagExecutionGraph()`, or one mutated after the fact),
 * never an expected runtime outcome a caller should branch on silently.
 */
export function assertValidExecutionGraph(graph: BagExecutionGraph): void {
  if (graph.legs.length === 0) {
    throw new BagExecutionError('INVALID_EXECUTION_GRAPH', 'Execution graph has no legs to execute.');
  }
  let allocated = BigInt(0);
  for (const leg of graph.legs) {
    if (BigInt(leg.amountRaw) <= BigInt(0)) {
      throw new BagExecutionError('INVALID_EXECUTION_GRAPH', `Leg "${leg.id}" has a non-positive amountRaw.`, { legId: leg.id });
    }
    allocated += BigInt(leg.amountRaw);
  }
  const total = BigInt(graph.inputAmountRaw) - BigInt(graph.unallocatedRaw);
  if (allocated !== total) {
    throw new BagExecutionError(
      'INVALID_EXECUTION_GRAPH',
      `Graph legs sum to ${allocated.toString()} but expected ${total.toString()} (inputAmountRaw - unallocatedRaw).`
    );
  }
}

/**
 * sha256 fingerprint of a `BagExecutionGraph` — same role, at this layer,
 * as `computeExecutionPlanFingerprint()`
 * (lib/domain/basket-protocol/purchase-intent/fingerprint.ts) plays for a
 * `PurchaseIntent`'s `routeFingerprint`. Used as `CompiledExecution
 * .executionPlanHash` (spec item 10) — a persisted/signed execution is
 * verified against a freshly recomputed hash of the graph it claims to
 * have been compiled from, not trusted at face value.
 */
export function computeBagExecutionGraphHash(graph: BagExecutionGraph): string {
  const canonical = JSON.stringify({
    bagId: graph.bagId,
    chainId: graph.chainId,
    inputAsset: graph.inputAsset,
    inputAmountRaw: graph.inputAmountRaw,
    unallocatedRaw: graph.unallocatedRaw,
    legs: graph.legs.map((leg) => ({
      id: leg.id,
      sourceAsset: leg.sourceAsset,
      targetAsset: leg.targetAsset,
      amountRaw: leg.amountRaw,
      weightBps: leg.weightBps,
      slippageBps: leg.slippageBps,
      chain: leg.chain,
      dependsOn: leg.dependsOn,
    })),
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}
