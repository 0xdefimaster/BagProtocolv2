import { AssetPrice } from '@/types/basket-protocol';

// -----------------------------------------------------------------------------
// Staleness is a PROPERTY a caller checks, not something `AssetPrice` or a
// `PriceProvider` decides for itself — different call sites (NAV math vs. a
// UI "last updated" badge) can reasonably apply different thresholds to
// the exact same price object. Phase 5 only wires the check itself; nothing
// in this phase calls it to block anything yet — that's Phase 6's job once
// a real NAV calculation exists to reject stale inputs (spec section 9:
// "Phase 5'te bunun için abstraction bırak").
// -----------------------------------------------------------------------------

/**
 * Default max age before a price is considered stale for NAV-grade math —
 * 5 minutes. Not the only constant this is ever meant to be used with; a
 * UI "last updated" display may reasonably pass a much looser threshold.
 */
export const DEFAULT_MAX_PRICE_AGE_MS = 5 * 60 * 1000;

export function priceAgeMs(price: AssetPrice, now: Date = new Date()): number {
  return now.getTime() - new Date(price.timestamp).getTime();
}

export function isPriceStale(
  price: AssetPrice,
  maxAgeMs: number = DEFAULT_MAX_PRICE_AGE_MS,
  now: Date = new Date()
): boolean {
  return priceAgeMs(price, now) > maxAgeMs;
}
