import { DEC_SCALE, formatDec, parseDec } from './decimal';

// -----------------------------------------------------------------------------
// Accounting V2 / A4 — holdings-based position value (docs/ACCOUNTING_V2_DESIGN.md §7).
//
// A position's value is NOT shares × basket NAV. It is built from what the
// wallet actually holds:
//
//   tracked holdings (bag_investor_holdings, what BAG bought for this strategy)
//   observed wallet balances (balanceOf at one block, fail-closed)
//     → effective position (the part of the wallet attributable to this strategy)
//     → verified prices
//     → position value
//
// Three values are kept apart, never merged into one number:
//   - strategy exposure:   tracked × price (what BAG thinks this strategy holds)
//   - observed in wallet:  min(observed, tracked) × price (what of it is still in the wallet)
//   - effective position:  effective × price (the wallet's balance attributed to this strategy)
// Estimated sale proceeds are a fourth, separate number (a route quote, after
// price impact and fees) and never come from here.
//
// Attribution (D3): when the wallet holds less of an asset than BAG tracks for
// it across all of the user's strategies, each strategy's effective quantity is
// its pro-rata share of the observed balance, floored. A wallet holding more
// than BAG tracks is not more exposure: the surplus belongs to no strategy.
//
// Unknowns stay unknown: an unreadable balance or a missing price makes the
// dependent value null, never zero.
// -----------------------------------------------------------------------------

export interface PositionAssetInput {
  chain: string;
  address: string;
  decimals: number;
  symbol?: string;
  /** What BAG tracks for THIS strategy (bag_investor_holdings.quantity_raw). */
  trackedRaw: string;
  /** What BAG tracks for this asset across ALL of the user's strategies (the attribution denominator). */
  trackedAllStrategiesRaw: string;
  /** The wallet's balance of this asset at one block; null when it could not be read. */
  observedRaw: string | null;
  /** Verified price per whole token in the quote currency; null when no price could be verified. */
  price: string | null;
}

export type PositionAssetStatus = 'IN_SYNC' | 'DRIFT' | 'UNREADABLE';

export interface PositionAssetValue {
  chain: string;
  address: string;
  decimals: number;
  symbol?: string;
  trackedRaw: string;
  observedRaw: string | null;
  /** Sellable for this strategy now; null when the wallet balance could not be read. */
  effectiveRaw: string | null;
  /** trackedRaw − effectiveRaw (never negative); null when unreadable. */
  driftRaw: string | null;
  status: PositionAssetStatus;
  price: string | null;
  exposureQuote: string | null;
  observedQuote: string | null;
  effectiveQuote: string | null;
}

export interface PositionValue {
  assets: PositionAssetValue[];
  /** Σ tracked × price. Null if any held asset has no verified price. */
  strategyExposureQuote: string | null;
  /** Σ min(observed, tracked) × price. Null if any held asset is unreadable or unpriced. */
  observedWalletQuote: string | null;
  /** Σ effective × price. Null if any held asset is unreadable or unpriced. */
  effectivePositionQuote: string | null;
  /** Some asset's effective quantity is below what BAG tracks for this strategy. */
  hasDrift: boolean;
  /** Some asset's wallet balance could not be read: sellable amounts are unknown. */
  hasUnreadable: boolean;
}

const ZERO = BigInt(0);
const RAW_RE = /^\d+$/;

function raw(value: string, label: string): bigint {
  if (!RAW_RE.test(value)) throw new Error(`${label} must be a non-negative integer string, got "${value}"`);
  return BigInt(value);
}

/**
 * The part of the observed balance attributable to one strategy (D3). Never more than the strategy tracks,
 * never more than the wallet holds; floored, so the parts across strategies never sum above the balance.
 */
export function effectiveQuantityRaw(trackedRaw: bigint, trackedAllStrategiesRaw: bigint, observedRaw: bigint): bigint {
  if (trackedRaw <= ZERO) return ZERO;
  const denominator = trackedAllStrategiesRaw > trackedRaw ? trackedAllStrategiesRaw : trackedRaw;
  if (observedRaw >= denominator) return trackedRaw;
  return (trackedRaw * observedRaw) / denominator;
}

/** quantity (raw, `decimals`) × price, as an exact 18-place decimal string. */
function valueOf(quantityRaw: bigint, decimals: number, price: string): bigint {
  const p = parseDec(price);
  // quantity × 10^(18 - decimals) is the quantity at 18 places; × price / 10^18 keeps the result at 18 places.
  const q = decimals <= DEC_SCALE ? quantityRaw * BigInt(10) ** BigInt(DEC_SCALE - decimals) : quantityRaw / BigInt(10) ** BigInt(decimals - DEC_SCALE);
  return (q * p) / BigInt(10) ** BigInt(DEC_SCALE);
}

function sumOrNull(parts: (bigint | null)[]): string | null {
  if (parts.some((p) => p === null)) return null;
  return formatDec(parts.reduce<bigint>((s, p) => s + (p as bigint), ZERO));
}

export function valuePosition(inputs: PositionAssetInput[]): PositionValue {
  const assets: PositionAssetValue[] = [];
  const exposure: (bigint | null)[] = [];
  const observedV: (bigint | null)[] = [];
  const effectiveV: (bigint | null)[] = [];

  for (const a of inputs) {
    const tracked = raw(a.trackedRaw, 'trackedRaw');
    if (tracked === ZERO) continue;
    const trackedAll = raw(a.trackedAllStrategiesRaw, 'trackedAllStrategiesRaw');
    const observed = a.observedRaw === null ? null : raw(a.observedRaw, 'observedRaw');
    const effective = observed === null ? null : effectiveQuantityRaw(tracked, trackedAll, observed);
    const inWallet = observed === null ? null : observed < tracked ? observed : tracked;
    const status: PositionAssetStatus = effective === null ? 'UNREADABLE' : effective < tracked ? 'DRIFT' : 'IN_SYNC';

    const exposureQ = a.price === null ? null : valueOf(tracked, a.decimals, a.price);
    const observedQ = a.price === null || inWallet === null ? null : valueOf(inWallet, a.decimals, a.price);
    const effectiveQ = a.price === null || effective === null ? null : valueOf(effective, a.decimals, a.price);
    exposure.push(exposureQ);
    observedV.push(observedQ);
    effectiveV.push(effectiveQ);

    assets.push({
      chain: a.chain,
      address: a.address,
      decimals: a.decimals,
      ...(a.symbol ? { symbol: a.symbol } : {}),
      trackedRaw: tracked.toString(),
      observedRaw: observed === null ? null : observed.toString(),
      effectiveRaw: effective === null ? null : effective.toString(),
      driftRaw: effective === null ? null : (tracked - effective).toString(),
      status,
      price: a.price,
      exposureQuote: exposureQ === null ? null : formatDec(exposureQ),
      observedQuote: observedQ === null ? null : formatDec(observedQ),
      effectiveQuote: effectiveQ === null ? null : formatDec(effectiveQ),
    });
  }

  return {
    assets,
    strategyExposureQuote: sumOrNull(exposure),
    observedWalletQuote: sumOrNull(observedV),
    effectivePositionQuote: sumOrNull(effectiveV),
    hasDrift: assets.some((a) => a.status === 'DRIFT'),
    hasUnreadable: assets.some((a) => a.status === 'UNREADABLE'),
  };
}
