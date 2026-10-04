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

// ----------------------------- A4: sell a fraction of what is really there ---
//
// Accounting V2 / A4 (docs/ACCOUNTING_V2_DESIGN.md §7): a redemption no longer
// asks "how many shares"; it asks "what fraction of my position" (basis points,
// 1..10000) and sells that fraction of each asset's EFFECTIVE quantity — the
// part of the wallet's observed balance attributable to this strategy
// (accounting/position-value.ts). A wallet that holds less than BAG tracks
// (the user moved tokens out) is never asked to sell the difference: with
// tracked 100 and a wallet of 60, a full exit sells 60.
//
// Shares are no longer an economic quantity (D1). They are still burned in
// the same proportion (sharesToBurnForFraction) only so the legacy
// share columns keep their existing invariants; nothing reads them for value.
// -----------------------------------------------------------------------------

export interface RedeemHoldingInput {
  chain: ChainId;
  address: string;
  decimals: number;
  /** What BAG tracks for this depositor and Bag (`bag_investor_holdings.quantity_raw`) — the most a sale may ever remove. */
  quantityRaw: string;
  /** What can really be sold now: the effective quantity (observed wallet balance attributed to this strategy). Never above `quantityRaw`. */
  sellableRaw: string;
}

export interface RedeemAllocationRequest {
  bagId: string;
  /** Fraction of the position to exit, in basis points: 10000 = everything sellable, 5000 = half. */
  fractionBps: number;
  outputAsset: AssetIdentity;
  outputDecimals: number;
  /** This depositor's own per-asset holdings for this Bag — see this file's module doc for why these, not the recipe, are the source. */
  holdings: RedeemHoldingInput[];
}

export const FULL_EXIT_BPS = 10_000;

/** `fractionBps` is not an integer in 1..10000. */
export class InvalidRedeemFractionError extends Error {
  constructor(public readonly fractionBps: unknown) {
    super(`Redeem fraction must be an integer number of basis points between 1 and 10000, got ${String(fractionBps)}.`);
    this.name = 'InvalidRedeemFractionError';
  }
}

/** Kept for callers that still map it; A4 never throws it (a fraction cannot exceed the position). */
export class InsufficientPositionError extends Error {
  constructor(
    public readonly requestedRaw: string,
    public readonly ownedRaw: string
  ) {
    super(`Cannot redeem ${requestedRaw} — this position only holds ${ownedRaw}.`);
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

export function assertValidFractionBps(fractionBps: unknown): asserts fractionBps is number {
  if (typeof fractionBps !== 'number' || !Number.isInteger(fractionBps) || fractionBps < 1 || fractionBps > FULL_EXIT_BPS) {
    throw new InvalidRedeemFractionError(fractionBps);
  }
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
 * Pure, synchronous redeem-allocation engine. Sells `floor(sellable × bps / 10000)` of each holding (all of it
 * at 10000), capped at what BAG tracks, so a sale can never remove more than the wallet really holds for this
 * strategy nor more than the books hold. Truncation only ever sells less, never more.
 *
 * Throws `InvalidRedeemFractionError` for a fraction outside 1..10000 and `ZeroRedeemAmountError` when nothing
 * would be sold (empty wallet, or a fraction too small to move a single raw unit).
 */
export function calculateRedeemAllocation(request: RedeemAllocationRequest): RedeemAllocation[] {
  assertValidFractionBps(request.fractionBps);
  const bps = BigInt(request.fractionBps);

  const allocations: RedeemAllocation[] = [];
  for (const holding of request.holdings) {
    const tracked = parseRaw(holding.quantityRaw, 'holding.quantityRaw');
    const sellable = parseRaw(holding.sellableRaw, 'holding.sellableRaw');
    const base = sellable < tracked ? sellable : tracked;
    const sellQty = request.fractionBps === FULL_EXIT_BPS ? base : (base * bps) / BigInt(FULL_EXIT_BPS);
    if (sellQty === BigInt(0)) continue;

    allocations.push({
      sourceAsset: normalizeAssetIdentity({ chain: holding.chain, address: holding.address }),
      sourceDecimals: holding.decimals,
      sellQuantityRaw: sellQty.toString(),
    });
  }

  if (allocations.length === 0) throw new ZeroRedeemAmountError();
  return allocations;
}

/**
 * Legacy share bookkeeping for a fraction exit (non-authoritative, D1): the same proportion of the share
 * balance, all of it on a full exit, and at least one raw share whenever any are held so a sale always moves
 * the legacy columns with it. Zero only when no shares are held at all.
 */
export function sharesToBurnForFraction(sharesRaw: string, fractionBps: number): string {
  assertValidFractionBps(fractionBps);
  const shares = parseRaw(sharesRaw, 'sharesRaw');
  if (shares === BigInt(0)) return '0';
  if (fractionBps === FULL_EXIT_BPS) return shares.toString();
  const burn = (shares * BigInt(fractionBps)) / BigInt(FULL_EXIT_BPS);
  return (burn === BigInt(0) ? BigInt(1) : burn).toString();
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
