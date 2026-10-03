import { SupabaseClient } from '@supabase/supabase-js';
import { NavResult } from '@/types/basket-protocol';
import { bagHoldingsToAssetHoldings } from '@/lib/domain/basket-protocol/bag-holdings';
import { CalculateNavOptions, calculateNav } from '@/lib/domain/basket-protocol/nav';
import { PriceUnavailableError } from '@/lib/domain/basket-protocol/pricing/provider';
import { StalePriceError } from '@/lib/domain/basket-protocol/nav/nav';
import { PriceProvider } from '@/lib/domain/basket-protocol/pricing';
import { getBagHoldings } from '@/lib/server/bag-holdings-repo';

// -----------------------------------------------------------------------------
// The only place `bag_holdings` (persistence) and `calculateNav()` (pure
// NAV Engine, Phase 6) meet. `lib/domain/basket-protocol/nav/nav.ts` never
// imports Supabase or knows a "Bag" exists — that separation
// (Repository = persistence, NAV Engine = pure calculation, spec section 7)
// is exactly what this thin wrapper exists to preserve. It does nothing
// `calculateNav()` doesn't already do: fetch holdings, convert them to
// `AssetHolding[]`, hand them to the unchanged NAV Engine.
// -----------------------------------------------------------------------------

export async function getBagNav(
  admin: SupabaseClient,
  bagId: string,
  priceProvider: PriceProvider,
  options: CalculateNavOptions = {}
): Promise<NavResult> {
  const holdings = await getBagHoldings(admin, bagId);
  const assetHoldings = bagHoldingsToAssetHoldings(holdings);
  return calculateNav(assetHoldings, priceProvider, options);
}

// -----------------------------------------------------------------------------
// Phase 18 — Real Price Authority. `calculateNav()` fails LOUD (throws) on a
// missing/stale/invalid price by design (see nav.ts's module doc) — exactly
// the fail-closed behavior a real price source needs. `getBagNav()` above
// preserves that for internal/test callers. Every real-money HTTP route
// (purchase-preview, purchase-intent creation) should call THIS wrapper
// instead: it turns the same fail-closed throw into a typed outcome so a
// price outage surfaces as a clean 503 ("try again shortly") instead of an
// unhandled 500 — never a fallback price, never a partially-computed NAV.
// -----------------------------------------------------------------------------

export type BagNavOutcome =
  | { ok: true; nav: NavResult }
  | { ok: false; reason: 'PRICE_UNAVAILABLE' | 'STALE_PRICE'; message: string };

export async function getBagNavSafe(
  admin: SupabaseClient,
  bagId: string,
  priceProvider: PriceProvider,
  options: CalculateNavOptions = {}
): Promise<BagNavOutcome> {
  try {
    const nav = await getBagNav(admin, bagId, priceProvider, options);
    return { ok: true, nav };
  } catch (err) {
    if (err instanceof PriceUnavailableError) {
      return { ok: false, reason: 'PRICE_UNAVAILABLE', message: err.message };
    }
    if (err instanceof StalePriceError) {
      return { ok: false, reason: 'STALE_PRICE', message: err.message };
    }
    throw err;
  }
}
