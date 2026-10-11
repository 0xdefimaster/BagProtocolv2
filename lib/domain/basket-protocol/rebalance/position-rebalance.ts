import { DEFAULT_REBALANCE_RULE, type Allocation, type AssetPrice, type BasketRecipe, type ChainId, type RebalanceOrder } from '@/types/basket-protocol';
import { assetIdentityKey } from '../asset-identity';
import { calculateNavFromPrices } from '../nav/nav';
import { calculateRebalancePlan } from './rebalance';

// -----------------------------------------------------------------------------
// Rebalance preview for ONE investor's position in one strategy (R1: read-only).
//
//   effective holdings (what of the wallet is attributed to this strategy,
//   position-valuation.ts) + verified prices
//   → NAV of the position → calculateRebalancePlan against the strategy's
//     CURRENT version (its weights and its drift threshold)
//
// Decisions (owner, 2026-10-11): the target is the current version, so a
// position bought under v1 is planned toward v2; the trigger is the strategy's
// own driftThresholdBps; a rebalance sale realizes no creator fee (the
// position stays, its contents change; cost basis carries over). Nothing here
// quotes, signs or moves anything.
// -----------------------------------------------------------------------------

export interface PositionHolding {
  chain: string;
  address: string;
  decimals: number;
  /** The wallet balance attributed to this strategy (never more than the wallet holds). */
  sellableRaw: string;
}

export type PositionRebalancePreview =
  | { status: 'NO_POSITION' }
  | { status: 'UNREADABLE_BALANCES' }
  | { status: 'PRICE_UNAVAILABLE'; assets: string[] }
  | {
      status: 'OK';
      targetVersion: number;
      driftThresholdBps: number;
      /** Largest |drift| over every asset, in bps of the position. */
      maxAbsDriftBps: number;
      requiresRebalance: boolean;
      navQuote: string;
      quoteCurrency: string;
      allocations: Allocation[];
      orders: RebalanceOrder[];
    };

export function previewPositionRebalance(input: {
  recipe: BasketRecipe;
  /** null when any balance could not be read (fail closed: no guessed holdings). */
  holdings: PositionHolding[] | null;
  /** Keyed by `assetIdentityKey`. */
  prices: ReadonlyMap<string, AssetPrice>;
  now?: Date;
}): PositionRebalancePreview {
  if (input.holdings === null) return { status: 'UNREADABLE_BALANCES' };
  const held = input.holdings.filter((h) => /^\d+$/.test(h.sellableRaw) && BigInt(h.sellableRaw) > BigInt(0));
  if (held.length === 0) return { status: 'NO_POSITION' };

  const missing = held.filter((h) => !input.prices.has(assetIdentityKey({ chain: h.chain as ChainId, address: h.address }))).map((h) => h.address.toLowerCase());
  if (missing.length > 0) return { status: 'PRICE_UNAVAILABLE', assets: missing };

  let nav;
  try {
    nav = calculateNavFromPrices(
      held.map((h) => ({ asset: { chain: h.chain as ChainId, address: h.address }, quantityRaw: h.sellableRaw, decimals: h.decimals })),
      input.prices,
      { now: input.now }
    );
  } catch {
    // Stale or unusable price: no preview rather than one built on it.
    return { status: 'PRICE_UNAVAILABLE', assets: held.map((h) => h.address.toLowerCase()) };
  }

  // A recipe stored before rebalance rules existed falls back to the protocol default threshold.
  const rule = input.recipe.rebalanceRule ?? DEFAULT_REBALANCE_RULE;
  const plan = calculateRebalancePlan(input.recipe, nav, rule);
  return {
    status: 'OK',
    targetVersion: input.recipe.version,
    driftThresholdBps: rule.driftThresholdBps,
    maxAbsDriftBps: plan.allocations.reduce((m, a) => Math.max(m, Math.abs(a.driftBps)), 0),
    requiresRebalance: plan.requiresRebalance,
    navQuote: plan.nav,
    quoteCurrency: plan.quoteCurrency,
    allocations: plan.allocations,
    orders: plan.orders,
  };
}
