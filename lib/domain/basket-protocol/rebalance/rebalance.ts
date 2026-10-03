import {
  Allocation,
  AssetIdentity,
  BasketRecipe,
  NavComponent,
  NavResult,
  RebalanceOrder,
  RebalancePlan,
  RebalanceRule,
} from '@/types/basket-protocol';
import { assetIdentityKey, normalizeAssetIdentity } from '../asset-identity';
import { formatNavValue, NAV_VALUE_DECIMALS } from '../nav/nav';
import { toProtocolPrice } from '../pricing/price-precision';

// -----------------------------------------------------------------------------
// Phase 8 — Drift & Rebalance Planning Engine.
//
//   Target Composition (BasketRecipe.assets[].weightBps)
//   + Current Holdings (via NavResult.components)
//   + Prices           (via NavResult.components[].price)
//   + NAV              (NavResult.grossNav)
//     ↓
//   Current Allocation → Drift → Rebalance Plan
//
// `calculateRebalancePlan()` is the single entry point. It is pure and
// dependency-free, same convention as `validateBasketRecipe()` and
// `calculateNavFromPrices()`: same (recipe, navResult, rebalanceRule) in,
// same `RebalancePlan` out, every time. No Supabase, no RPC, no wallet, no
// blockchain, no `PriceProvider` — every price this file ever uses comes
// from `NavResult.components`, which already carries the price each
// currently-held asset was valued at (spec section 11 — NAV already
// contains the prices; this engine has no business re-deriving them).
//
// This phase produces a PLAN ONLY. No swap, no order placement, no DEX, no
// smart-contract call, no wallet signing, no mint/redeem/transfer happens
// anywhere in this file or anything it calls (spec section 13).
//
// ----------------------------- Design decisions --------------------------
//
// 1. GLOBAL threshold, not per-asset. `RebalanceRule.driftThresholdBps` is
//    a single number, not one per asset — so it is read as a single
//    trigger for the whole plan: if ANY asset's `|driftBps|` exceeds it,
//    the entire Bag is considered out of tolerance and every asset with a
//    nonzero delta gets an order back to its exact target, not only the
//    asset(s) that individually tripped the threshold. A Bag that is
//    "close enough" on every asset produces zero orders even if a couple
//    of them are individually nonzero but under threshold.
//
// 2. Strictly-greater-than at the boundary. Spec section 5's own examples
//    (+2% under a 5% threshold → no rebalance; +6% over → rebalance) never
//    exercise drift exactly AT the threshold. This file treats "at
//    threshold" as NOT yet requiring rebalance (`driftBps > threshold`,
//    not `>=`) — a threshold is the point beyond which drift is
//    unacceptable, not including itself.
//
// 3. Target values are distributed via the largest-remainder method
//    (bigint, exact), not naive per-asset floor division. This is what
//    guarantees `sum(targetValue) === grossNavScaled` EXACTLY whenever
//    target weights sum to `TOTAL_WEIGHT_BPS` — which, combined with
//    `sum(currentValue) === grossNavScaled` (NAV Engine's own invariant),
//    makes `sum(BUY value) === sum(SELL value)` an exact algebraic
//    identity, not an approximation (spec section 15). See the proof in
//    `calculateRebalancePlan()`'s body, above the distribution loop.
//
// 4. Unexpected holdings (spec section 8) — an asset the Bag holds that
//    the recipe does not mention — get an implicit `targetWeightBps: 0`
//    and, when a rebalance is triggered, a full-value SELL order. They are
//    never silently ignored or excluded from the drift picture.
//
// 5. Zero NAV (spec section 14) is handled explicitly, not as a division-
//    by-zero accident: with nothing under management there is no weight to
//    compute and no capital to plan a trade against, so `requiresRebalance`
//    is forced `false` and `orders` is always empty, regardless of what the
//    recipe's target weights nominally are.
// -----------------------------------------------------------------------------

/** Mirrors `validation/validators.ts`'s private constant of the same name and value — basis points always sum to 100%. */
const TOTAL_WEIGHT_BPS = 10_000;

export class InvalidTargetWeightsError extends Error {
  constructor(totalBps: number) {
    super(
      `Recipe target weights sum to ${totalBps} bps, not ${TOTAL_WEIGHT_BPS}. ` +
        `calculateRebalancePlan() refuses to plan against an unnormalized recipe — the ` +
        `planner assumes a validated recipe (see validateBasketRecipe()) and fails loudly ` +
        `rather than silently producing wrong orders from invalid weights.`
    );
    this.name = 'InvalidTargetWeightsError';
  }
}

/** Internal per-asset working row — one recipe asset, or one unexpected holding. */
interface AssetLine {
  asset: AssetIdentity;
  key: string;
  symbol: string;
  decimals: number;
  /** 0 for an unexpected holding (spec section 8). */
  targetWeightBps: number;
  /** NAV_VALUE_DECIMALS-scaled bigint — 0 for a recipe asset with no current holding. */
  currentValueScaled: bigint;
  /** The price this asset was valued at in the NavResult — null if never held (no NavComponent exists for it). */
  priceString: string | null;
}

/**
 * Pure, synchronous rebalance planner.
 *
 * `rebalanceRule` defaults to `recipe.rebalanceRule` — pass one explicitly
 * to preview against a different rule than the recipe's own (e.g. a
 * tighter threshold before saving it).
 *
 * Throws `InvalidTargetWeightsError` if `recipe.assets[].weightBps` doesn't
 * sum to exactly 100% (spec section 14 — "Recipe weights invariant").
 */
export function calculateRebalancePlan(
  recipe: BasketRecipe,
  navResult: NavResult,
  rebalanceRule: RebalanceRule = recipe.rebalanceRule
): RebalancePlan {
  const targetTotalBps = recipe.assets.reduce((sum, a) => sum + a.weightBps, 0);
  if (targetTotalBps !== TOTAL_WEIGHT_BPS) {
    throw new InvalidTargetWeightsError(targetTotalBps);
  }

  const grossNavScaled = toProtocolPrice(navResult.grossNav, NAV_VALUE_DECIMALS);

  const componentsByKey = new Map<string, NavComponent>();
  for (const component of navResult.components) {
    componentsByKey.set(assetIdentityKey(component.asset), component);
  }
  const recipeKeys = new Set(recipe.assets.map((a) => assetIdentityKey({ chain: a.chain, address: a.address })));

  // ---- One AssetLine per asset that matters: every recipe asset (even if
  // never held — spec section 8's "zero/missing holding"), plus every held
  // asset the recipe doesn't mention ("unexpected holding"). ----
  const lines: AssetLine[] = [];

  for (const recipeAsset of recipe.assets) {
    const identity = normalizeAssetIdentity({ chain: recipeAsset.chain, address: recipeAsset.address });
    const key = assetIdentityKey(identity);
    const component = componentsByKey.get(key);
    lines.push({
      asset: identity,
      key,
      symbol: recipeAsset.symbol,
      decimals: recipeAsset.decimals,
      targetWeightBps: recipeAsset.weightBps,
      currentValueScaled: component ? toProtocolPrice(component.value, NAV_VALUE_DECIMALS) : BigInt(0),
      priceString: component ? component.price.price : null,
    });
  }

  for (const component of navResult.components) {
    const key = assetIdentityKey(component.asset);
    if (recipeKeys.has(key)) continue; // already covered above
    lines.push({
      asset: normalizeAssetIdentity(component.asset),
      key,
      // AssetIdentity/NavComponent carry no symbol (identity is chain+
      // address only, deliberately — see asset-identity.ts's module doc);
      // the address is the only stable label this pure engine has for an
      // asset the recipe never claimed.
      symbol: component.asset.address,
      decimals: component.decimals,
      targetWeightBps: 0,
      currentValueScaled: toProtocolPrice(component.value, NAV_VALUE_DECIMALS),
      priceString: component.price.price,
    });
  }

  lines.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)); // spec section 16 — deterministic output, independent of insertion order

  // ---- Target values (see design decision 3 above). ----
  const targetValueScaled = new Map<string, bigint>();

  if (grossNavScaled > BigInt(0)) {
    const bps = BigInt(TOTAL_WEIGHT_BPS);
    const remainders: Array<{ key: string; remainder: bigint }> = [];

    for (const line of lines) {
      const numerator = grossNavScaled * BigInt(line.targetWeightBps);
      targetValueScaled.set(line.key, numerator / bps);
      remainders.push({ key: line.key, remainder: numerator % bps });
    }

    // Proof this division is exact: Σ(grossNavScaled * targetWeightBps_i)
    // = grossNavScaled * Σ(targetWeightBps_i) = grossNavScaled * bps
    // (target weights sum to exactly `bps`, checked above). Also
    // Σ(numerator_i) = Σ(bps * floor_i + remainder_i) = bps * Σ(floor_i) +
    // Σ(remainder_i). Equating the two: Σ(remainder_i) = bps * (grossNavScaled
    // − Σ(floor_i)) — an exact multiple of `bps`, so dividing by `bps` here
    // loses nothing.
    const totalRemainder = remainders.reduce((sum, r) => sum + r.remainder, BigInt(0));
    let leftoverUnits = totalRemainder / bps;

    const byRemainderDesc = [...remainders].sort((a, b) => {
      if (a.remainder === b.remainder) return a.key < b.key ? -1 : a.key > b.key ? 1 : 0; // deterministic tie-break
      return a.remainder > b.remainder ? -1 : 1;
    });

    for (const { key } of byRemainderDesc) {
      if (leftoverUnits <= BigInt(0)) break;
      targetValueScaled.set(key, (targetValueScaled.get(key) ?? BigInt(0)) + BigInt(1));
      leftoverUnits -= BigInt(1);
    }
  } else {
    // Zero NAV (design decision 5) — every target value is 0. Every
    // current value must also be 0 here: NAV Engine values are never
    // negative (nav.ts), so a zero sum forces every addend to zero.
    for (const line of lines) {
      targetValueScaled.set(line.key, BigInt(0));
    }
  }

  // ---- Allocations (current weight, drift). ----
  const allocations: Allocation[] = lines.map((line) => {
    const currentWeightBps =
      grossNavScaled > BigInt(0)
        ? Number((line.currentValueScaled * BigInt(TOTAL_WEIGHT_BPS)) / grossNavScaled)
        : 0;
    return {
      asset: line.asset,
      symbol: line.symbol,
      targetWeightBps: line.targetWeightBps,
      currentWeightBps,
      driftBps: currentWeightBps - line.targetWeightBps,
    };
  });

  // ---- Threshold (design decisions 1 & 2). ----
  const requiresRebalance =
    grossNavScaled > BigInt(0) && allocations.some((a) => Math.abs(a.driftBps) > rebalanceRule.driftThresholdBps);

  // ---- Orders — only when the plan as a whole requires rebalancing;
  // every asset with a nonzero delta is corrected, not only the one(s)
  // whose own drift crossed the threshold (design decision 1). ----
  const orders: RebalanceOrder[] = [];
  if (requiresRebalance) {
    for (const line of lines) {
      const target = targetValueScaled.get(line.key) ?? BigInt(0);
      const delta = target - line.currentValueScaled; // positive => BUY, negative => SELL
      if (delta === BigInt(0)) continue;

      const side = delta > BigInt(0) ? 'BUY' : 'SELL';
      const magnitude = delta > BigInt(0) ? delta : -delta;

      orders.push({
        asset: line.asset,
        symbol: line.symbol,
        side,
        value: formatNavValue(magnitude),
        quantityRaw: computeQuantityRaw(magnitude, line.decimals, line.priceString),
        decimals: line.decimals,
      });
    }
  }

  return {
    asOf: navResult.asOf,
    quoteCurrency: navResult.quoteCurrency,
    nav: navResult.grossNav,
    allocations,
    orders,
    requiresRebalance,
  };
}

/**
 * `value / price`, at exact bigint precision (no JS `number` anywhere on
 * this path — spec section 7), truncated to `decimals` places — the same
 * "truncate, never round" policy `toProtocolPrice()` uses elsewhere in this
 * codebase, so an order quantity is never fabricated more precise than the
 * asset's own on-chain decimals allow (spec section 7's explicit
 * requirement).
 *
 * Returns `null` when no price is available — the only case that arises is
 * a target asset that has never been held: it has no `NavComponent` and
 * therefore no price this pure engine is allowed to reach for (see this
 * file's module doc, point 11 in spec). A `null` `quantityRaw` is a
 * legitimate, expected output the plan's consumer must handle — not an
 * error condition of this planner.
 */
function computeQuantityRaw(valueScaled: bigint, decimals: number, priceString: string | null): string | null {
  if (!priceString) return null;
  const priceScaled = toProtocolPrice(priceString, NAV_VALUE_DECIMALS);
  if (priceScaled === BigInt(0)) return null; // a zero price can't back out a quantity
  return ((valueScaled * BigInt(10) ** BigInt(decimals)) / priceScaled).toString();
}
