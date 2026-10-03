import { BasketRecipe, DepositAllocation, DepositPlan, DepositRequest } from '@/types/basket-protocol';
import { assetIdentitiesEqual, assetIdentityKey, normalizeAssetIdentity } from '../asset-identity';
import { distributeExactByWeight, InvalidWeightSumError } from '../exact-allocation';

// -----------------------------------------------------------------------------
// Phase 10 — One-Click Multi-Asset BAG Purchase: Deposit → Allocation.
//
//   DepositRequest (one input asset, one raw amount)
//   + BasketRecipe  (target composition, RecipeAsset[].weightBps)
//     ↓
//   DepositPlan (target VALUE per recipe asset, in the input asset's own
//                raw units)
//
// `calculateDepositAllocation()` is the single entry point, and is PURE —
// same convention as `validateBasketRecipe()`, `calculateNavFromPrices()`,
// and `calculateRebalancePlan()`: same (request, recipe) in, same
// `DepositPlan` out, every time. No Supabase, no RPC, no wallet, no
// blockchain, no PriceProvider, no LI.FI — this function has no business
// knowing any of those exist (spec sections 3/15).
//
// ----------------------------- Price vs Route (spec section 14/15) --------
//
// This is an ALLOCATION, not a swap quote. "40 USDC → xNVDA" here means
// "40 USDC of this deposit's VALUE is earmarked for xNVDA" — it does NOT
// mean "0.1234 xNVDA". Converting a `DepositAllocation.valueRaw` into an
// actual quantity of `targetAsset` is `ExecutionAdapter`'s job
// (lib/blockchain/execution-adapter.ts), once a real route/quote exists.
// Nothing in this file ever imports a `PriceProvider` or does anything
// price-related — recipe weights are the only input this engine needs.
//
// ----------------------------- No float (spec section 7) ------------------
//
// Every amount is a `bigint` internally; `DepositRequest.amountRaw` and
// every `DepositAllocation.valueRaw` are exact base-10 integer strings.
// The distribution itself is `distributeExactByWeight()`'s largest-
// remainder method (see exact-allocation.ts for the exactness proof) — the
// same guarantee Phase 8's rebalance planner relies on, applied here to a
// deposit instead of a NAV.
// -----------------------------------------------------------------------------

/** Mirrors rebalance.ts's private constant of the same name/value — basis points always sum to 100%. */
const TOTAL_WEIGHT_BPS = 10_000;

/** A recipe's weights don't sum to exactly 100% — same failure mode `calculateRebalancePlan()` guards against, surfaced under this phase's own name so callers can distinguish "bad recipe at deposit time" from "bad recipe at rebalance time" if they need to. */
export class InvalidRecipeWeightsError extends Error {
  constructor(totalBps: number) {
    super(
      `calculateDepositAllocation: recipe target weights sum to ${totalBps} bps, not ${TOTAL_WEIGHT_BPS}. ` +
        `Refusing to split a deposit against an unnormalized recipe.`
    );
    this.name = 'InvalidRecipeWeightsError';
  }
}

/** `DepositRequest.amountRaw` must be a non-negative base-10 integer string — the same raw-unit convention `AssetHolding.quantityRaw`/`BagHolding.quantityRaw` use elsewhere in this codebase. */
export class InvalidDepositAmountRawError extends Error {
  constructor(amountRaw: string) {
    super(`"${amountRaw}" is not a valid non-negative integer raw deposit amount.`);
    this.name = 'InvalidDepositAmountRawError';
  }
}

const NON_NEGATIVE_INTEGER_RE = /^\d+$/;

function parseAmountRaw(amountRaw: string): bigint {
  if (!NON_NEGATIVE_INTEGER_RE.test(amountRaw.trim())) {
    throw new InvalidDepositAmountRawError(amountRaw);
  }
  return BigInt(amountRaw);
}

/**
 * Pure, synchronous deposit-allocation engine.
 *
 * Produces one `DepositAllocation` per `recipe.assets` entry — including
 * 0%-weight ones (spec section 17's "Zero weight" test expects a
 * `valueRaw: "0"` line to exist, just to produce no downstream execution
 * step; see `buildExecutionPlan()`). A target asset that IS the deposit's
 * `inputAsset` (by `chain` + `address`, never by `symbol` — spec section
 * 5) gets `action: 'KEEP'` and is never marked for a swap.
 *
 * Throws `InvalidRecipeWeightsError` if `recipe.assets[].weightBps`
 * doesn't sum to exactly 100%, and `InvalidDepositAmountRawError` if
 * `request.amountRaw` isn't a valid non-negative integer string.
 */
export function calculateDepositAllocation(request: DepositRequest, recipe: BasketRecipe): DepositPlan {
  const inputAmountRaw = parseAmountRaw(request.amountRaw);
  const inputIdentity = normalizeAssetIdentity(request.inputAsset);

  const totalWeightBps = recipe.assets.reduce((sum, a) => sum + a.weightBps, 0);
  if (totalWeightBps !== TOTAL_WEIGHT_BPS) {
    throw new InvalidRecipeWeightsError(totalWeightBps);
  }

  let distributed: Map<string, bigint>;
  try {
    distributed = distributeExactByWeight(
      inputAmountRaw,
      recipe.assets.map((a) => ({ key: assetIdentityKey({ chain: a.chain, address: a.address }), weightBps: a.weightBps })),
      TOTAL_WEIGHT_BPS
    );
  } catch (err) {
    // Same invariant, different name at this layer (see InvalidRecipeWeightsError doc) —
    // distributeExactByWeight() already checked the sum above, so this only fires if the
    // two checks ever disagree, which should be unreachable; re-thrown as this file's own
    // error type for a consistent surface to callers.
    if (err instanceof InvalidWeightSumError) throw new InvalidRecipeWeightsError(err.actualTotalBps);
    throw err;
  }

  const allocations: DepositAllocation[] = recipe.assets.map((a) => {
    const identity = normalizeAssetIdentity({ chain: a.chain, address: a.address });
    const key = assetIdentityKey(identity);
    const valueRaw = distributed.get(key) ?? BigInt(0);
    const isInputAsset = assetIdentitiesEqual(identity, inputIdentity);
    return {
      targetAsset: identity,
      targetSymbol: a.symbol,
      targetDecimals: a.decimals,
      targetWeightBps: a.weightBps,
      valueRaw: valueRaw.toString(),
      action: isInputAsset ? 'KEEP' : 'SWAP',
    };
  });

  const totalAllocatedRaw = allocations.reduce((sum, x) => sum + BigInt(x.valueRaw), BigInt(0));
  // Always exactly `inputAmountRaw - totalAllocatedRaw` (see exact-allocation.ts's proof —
  // this is provably "0" whenever recipe weights sum to TOTAL_WEIGHT_BPS, which is enforced
  // above). Computed here, not hardcoded to "0", so a caller can assert the invariant rather
  // than assume it — the documented residual policy from spec section 16.
  const unallocatedRaw = inputAmountRaw - totalAllocatedRaw;

  return {
    bagId: request.bagId,
    inputAsset: inputIdentity,
    inputAmountRaw: inputAmountRaw.toString(),
    allocations,
    totalAllocatedRaw: totalAllocatedRaw.toString(),
    unallocatedRaw: unallocatedRaw.toString(),
  };
}
