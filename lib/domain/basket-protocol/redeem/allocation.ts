import { AssetIdentity, ChainId, ExecutionStep } from '@/types/basket-protocol';
import { assetIdentitiesEqual, normalizeAssetIdentity } from '../asset-identity';
import { ZeroRedeemAmountError } from '../shares/shares';

// -----------------------------------------------------------------------------
// Phase 21 — Redeem → Allocation. The exit-side counterpart to
// lib/domain/basket-protocol/deposit/allocation.ts, but structurally
// simpler: a deposit splits ONE input amount across a recipe's TARGET
// weights (needs distributeExactByWeight's largest-remainder method so the
// split sums back exactly). A redemption instead sells a proportional
// slice of whatever this SPECIFIC depositor's OWN `bag_investor_holdings`
// rows actually contain right now — there is no weight redistribution step
// and no "must sum to a total" constraint, because each asset's sell
// quantity is computed independently of every other asset's.
//
// ----------------------------- Why per-user holdings, not the recipe ------
//
// This protocol has NO pooled custody (see lib/blockchain/
// lifi-purchase-quote.ts's module doc: every swap's `toAddress` is the
// depositor's OWN wallet, not a bag-owned vault). A Bag's `bag_holdings` is
// an aggregate SUM across every depositor's own, separately-held tokens —
// there is no shared pot a redemption could draw from. The only assets a
// redemption can honestly sell are the ones THIS depositor's own past
// deposits actually put in THEIR OWN wallet, i.e. their own
// `bag_investor_holdings` rows (Phase 20/21) — not the bag's current
// recipe weights, which may have drifted (rebalanced) since this
// depositor's deposit(s) and describe a TARGET composition, not what is
// verifiably sitting in any specific wallet.
// -----------------------------------------------------------------------------

export interface RedeemHoldingInput {
  chain: ChainId;
  address: string;
  decimals: number;
  /** This depositor's OWN current quantity of this asset for this Bag (`bag_investor_holdings.quantity_raw`) — never the bag-level aggregate. */
  quantityRaw: string;
}

export interface RedeemAllocationRequest {
  bagId: string;
  /** This depositor's TOTAL shares in the Bag right now (`bag_investor_positions.sharesRaw`) — the denominator every holding's sell fraction is computed against. */
  sharesRaw: string;
  /** How many of those shares this redemption burns — must be `> 0` and `<= sharesRaw`. */
  sharesToRedeemRaw: string;
  outputAsset: AssetIdentity;
  outputDecimals: number;
  /** This depositor's own per-asset holdings for this Bag — see this file's module doc for why these, not the recipe, are the source. */
  holdings: RedeemHoldingInput[];
}

/** `sharesToRedeemRaw` exceeds `sharesRaw` — always this depositor's OWN position, never the bag-wide total (contrast `shares.ts`'s `InsufficientSharesError`, which is about the bag's total outstanding supply and is the wrong message here — this is "you don't have that many", not "the Bag doesn't have that many"). */
export class InsufficientPositionError extends Error {
  constructor(
    public readonly requestedRaw: string,
    public readonly ownedRaw: string
  ) {
    super(`Cannot redeem ${requestedRaw} raw shares — this position only holds ${ownedRaw}.`);
    this.name = 'InsufficientPositionError';
  }
}

const NON_NEGATIVE_INTEGER_RE = /^\d+$/;

function parseRaw(value: string, label: string): bigint {
  if (!NON_NEGATIVE_INTEGER_RE.test(value.trim())) {
    throw new Error(`"${value}" is not a valid non-negative integer ${label}.`);
  }
  return BigInt(value);
}

/**
 * One `RedeemAllocation` per non-zero-sell holding — deliberately omits a
 * holding whose computed sell quantity floors to `0` (same "no step for
 * nothing to do" convention `buildExecutionPlan()` uses for a 0%-weight
 * deposit allocation), rather than emitting a step with `inputAmountRaw:
 * "0"` that would need to be specially skipped by every downstream
 * consumer instead.
 */
export interface RedeemAllocation {
  sourceAsset: AssetIdentity;
  sourceDecimals: number;
  /** Exact quantity of `sourceAsset`, in ITS OWN raw units, being sold — never a value expressed in some other asset's terms (contrast `DepositAllocation.valueRaw`, which IS a cross-asset value; here there is nothing to convert, since we already know the exact source quantity). */
  sellQuantityRaw: string;
}

/**
 * `floor(holdingQty × sharesToRedeem / sharesOwned)` — proportional,
 * exact bigint arithmetic, truncated (never rounded) toward the
 * depositor's benefit-neutral side, same "truncate beyond exactness"
 * policy the deposit/NAV code uses elsewhere. Truncating can only ever
 * produce a sell quantity `<=` the true proportional share (never more),
 * so this can never overdraw a holding even under repeated roundoff.
 */
function proportionalSellQuantity(holdingQtyRaw: bigint, sharesToRedeemRaw: bigint, sharesOwnedRaw: bigint): bigint {
  return (holdingQtyRaw * sharesToRedeemRaw) / sharesOwnedRaw;
}

/**
 * Pure, synchronous redeem-allocation engine — the Phase 21 counterpart to
 * `calculateDepositAllocation()`. Produces one `RedeemAllocation` per
 * holding with a non-zero computed sell quantity.
 *
 * Throws `ZeroRedeemAmountError` for `sharesToRedeemRaw === "0"` (same
 * policy `getRedeemQuote()` already enforces — see shares.ts) and
 * `InsufficientPositionError` if `sharesToRedeemRaw > sharesRaw` for THIS
 * depositor specifically.
 */
export function calculateRedeemAllocation(request: RedeemAllocationRequest): RedeemAllocation[] {
  const sharesOwned = parseRaw(request.sharesRaw, 'sharesRaw');
  const sharesToRedeem = parseRaw(request.sharesToRedeemRaw, 'sharesToRedeemRaw');

  if (sharesToRedeem === BigInt(0)) throw new ZeroRedeemAmountError();
  if (sharesToRedeem > sharesOwned) throw new InsufficientPositionError(request.sharesToRedeemRaw, request.sharesRaw);

  const allocations: RedeemAllocation[] = [];
  for (const holding of request.holdings) {
    const holdingQty = parseRaw(holding.quantityRaw, 'holding.quantityRaw');
    const sellQty = proportionalSellQuantity(holdingQty, sharesToRedeem, sharesOwned);
    if (sellQty === BigInt(0)) continue;

    allocations.push({
      sourceAsset: normalizeAssetIdentity({ chain: holding.chain, address: holding.address }),
      sourceDecimals: holding.decimals,
      sellQuantityRaw: sellQty.toString(),
    });
  }

  return allocations;
}

/**
 * Turns `RedeemAllocation[]` into `ExecutionStep[]` — the same
 * router-agnostic shape `buildExecutionPlan()` produces for a deposit,
 * reused as-is by `buildPurchaseIntentSteps()` (lib/blockchain/
 * lifi-purchase-quote.ts, refactored in this phase to take `ExecutionStep[]`
 * directly rather than a whole `ExecutionPlan` — that function never read
 * any OTHER field off the plan, so this is a pure simplification, not a
 * behavior change for the deposit path that already called it).
 *
 * A holding that already IS `outputAsset` (by chain+address — never
 * symbol, same invariant as everywhere else in this codebase) needs no
 * swap: `action: 'KEEP'`, exactly like an input asset that's also a
 * deposit's target in `calculateDepositAllocation()`.
 */
export function buildRedeemExecutionSteps(
  allocations: RedeemAllocation[],
  outputAsset: AssetIdentity,
  /** Registry display symbol for a given asset identity — this pure layer only knows chain+address, so the caller (which already loaded the registry) supplies this. */
  symbolFor: (asset: AssetIdentity) => string
): ExecutionStep[] {
  const normalizedOutput = normalizeAssetIdentity(outputAsset);

  return allocations.map((allocation): ExecutionStep => {
    const isKeep = assetIdentitiesEqual(allocation.sourceAsset, normalizedOutput);
    return {
      action: isKeep ? 'KEEP' : 'SWAP',
      targetSymbol: symbolFor(allocation.sourceAsset),
      route: {
        inputAsset: allocation.sourceAsset,
        inputAmountRaw: allocation.sellQuantityRaw,
        outputAsset: normalizedOutput,
        targetValueRaw: allocation.sellQuantityRaw,
        sourceChain: allocation.sourceAsset.chain,
        destinationChain: normalizedOutput.chain,
      },
    };
  });
}
