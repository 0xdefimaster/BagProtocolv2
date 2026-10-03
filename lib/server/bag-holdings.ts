import { SupabaseClient } from '@supabase/supabase-js';
import { AssetIdentity, BagHolding } from '@/types/basket-protocol';
import { findUnverifiedIdentities } from '@/lib/domain/basket-protocol/validation/registry-validation';
import { getVerifiedIdentityKeys } from '@/lib/server/asset-repo';
import { getBagById } from '@/lib/server/bag-repo';
import { ReplaceBagHoldingInput, replaceBagHoldings } from '@/lib/server/bag-holdings-repo';

// -----------------------------------------------------------------------------
// The one place ownership + verified-asset gating + atomic write come
// together for Bag holdings — same shape as `lib/server/deploy-bag.ts`'s
// `confirmBagDeployment()` for deployment. `setBagHoldings()` is what a future
// API route calls AFTER requireSession() has already run; this function
// still re-checks ownership itself, matching the trust contract documented
// at the top of `lib/server/bag-repo.ts` and `lib/server/bag-holdings-repo.ts`.
//
// ---------------------------- Security boundary -----------------------------
//   PUBLIC (no session)   -> may read holdings of ACTIVE bags only (RLS
//                            policy on bag_holdings, supabase/schema.sql).
//   CREATOR (owns the bag) -> may call setBagHoldings() for their own bag.
//   ANY OTHER USER          -> rejected with FORBIDDEN before any write.
// No `/api/bags/*/holdings` route exists yet in this phase (spec section
// 10/15 — holdings persistence has no mint/redeem to drive it yet); this
// orchestrator exists so that whichever route/script calls it later
// already has the ownership + registry checks done correctly, the same way
// `confirmBagDeployment()` was ready before its route existed.
// -----------------------------------------------------------------------------

export interface SetHoldingInput {
  asset: AssetIdentity;
  quantityRaw: string;
  decimals: number;
}

export type SetBagHoldingsResult =
  | { ok: true; holdings: BagHolding[]; unverifiedWarnings: AssetIdentity[] }
  | { ok: false; error: 'BAG_NOT_FOUND' }
  | { ok: false; error: 'FORBIDDEN' }
  | { ok: false; error: 'UNVERIFIED_ASSETS'; unverified: AssetIdentity[] };

/**
 * Replaces a bag's entire holdings set. Verified-asset policy (spec
 * section 8) depends on the bag's current status:
 *   - DRAFT (or any non-ACTIVE status): an unverified asset is allowed —
 *     reported back as `unverifiedWarnings`, never blocks the write.
 *   - ACTIVE (published): an unverified asset is REJECTED outright — no
 *     write happens at all (`UNVERIFIED_ASSETS`).
 * Reuses `findUnverifiedIdentities()` (Phase 5's registry-validation.ts) —
 * the exact same check `validateRecipeAssetsAgainstRegistry()` uses for
 * recipes, not a re-implementation (spec section 8: "Aynı validation
 * mantığını yeniden yazma").
 */
export async function setBagHoldings(
  admin: SupabaseClient,
  requestingUserId: string,
  bagId: string,
  holdings: SetHoldingInput[]
): Promise<SetBagHoldingsResult> {
  const bag = await getBagById(admin, bagId);
  if (!bag) return { ok: false, error: 'BAG_NOT_FOUND' };
  if (bag.creatorId !== requestingUserId) return { ok: false, error: 'FORBIDDEN' };

  const identities = holdings.map((h) => h.asset);
  const verifiedIdentityKeys = await getVerifiedIdentityKeys(admin, identities);
  const unverified = findUnverifiedIdentities(identities, verifiedIdentityKeys);

  if (unverified.length > 0 && bag.status === 'ACTIVE') {
    return { ok: false, error: 'UNVERIFIED_ASSETS', unverified };
  }

  const replaceInput: ReplaceBagHoldingInput[] = holdings.map((h) => ({
    asset: h.asset,
    quantityRaw: h.quantityRaw,
    decimals: h.decimals,
  }));
  const result = await replaceBagHoldings(admin, bagId, replaceInput);

  return { ok: true, holdings: result, unverifiedWarnings: bag.status === 'ACTIVE' ? [] : unverified };
}
