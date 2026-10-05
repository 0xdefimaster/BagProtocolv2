import type { SupabaseClient } from '@supabase/supabase-js';
import type { BagRecord, BagVersionRecord } from '@/types/basket-protocol';
import { findActiveRedeemIntentForBag } from '@/lib/server/redeem-intent-repo';
import { findActivePurchaseIntentForBag, updatePurchaseIntentStatus } from '@/lib/server/purchase-intent-repo';
import type { PurchaseIntent } from '@/types/purchase-intent';

// -----------------------------------------------------------------------------
// B0 — which position state a fee attestation is bound to
// (docs/FEE_ECONOMICS_DESIGN.md §5.6). The fee is attested from the position's
// ledger at T0 (basis, loss carry) and executed at T1; a purchase into the same
// Bag in between would change the average cost of what is sold. B0 keeps the
// two apart: no fee attestation while a purchase of the position is in flight,
// and no purchase while a fee-paying redemption of it is open. Only sales that
// pay a fee are affected; fee-free sales and ordinary purchases are not.
//
// Race-safe without a database lock: each side WRITES its own intent before it
// READS for the other (the sale intent exists before its fee is attested; a
// purchase intent is inserted, then checked, then cancelled if a fee sale is
// open). Whatever the interleaving, the later of the two reads sees the
// earlier write, so at least one side refuses — never both proceed. Proven
// against real PostgreSQL in fee-redemption-lock.integration.test.ts.
// (The contract-level answer — a per-position nonce in the signed struct — is
// part of the separate RedeemFeeRouter v2 PR.)
// -----------------------------------------------------------------------------

/** Statuses after which a transaction may already be on its way: in flight regardless of the quote's expiry. */
const SUBMITTED = new Set(['SUBMITTED', 'CONFIRMING']);

function stillOpen(intent: { status: string; expiresAt: string }, now: number): boolean {
  return SUBMITTED.has(intent.status) || new Date(intent.expiresAt).getTime() > now;
}

/** True when a sale of `bag` by `userId` pays a performance fee (the locked rate, never the creator's own sale). */
export function redemptionPaysFee(bag: Pick<BagRecord, 'creatorId' | 'performanceFeeBpsLocked'>, version: Pick<BagVersionRecord, 'recipe'> | null, userId: string): boolean {
  if (bag.creatorId === userId) return false;
  return (bag.performanceFeeBpsLocked ?? version?.recipe.performanceFeeBps ?? 0) > 0;
}

/** The open fee-paying redemption that blocks a purchase of the same position, if any. */
export async function openFeeRedemptionFor(
  admin: SupabaseClient,
  userId: string,
  bag: Pick<BagRecord, 'id' | 'creatorId' | 'performanceFeeBpsLocked'>,
  version: Pick<BagVersionRecord, 'recipe'> | null,
  now = Date.now()
): Promise<{ id: string } | null> {
  if (!redemptionPaysFee(bag, version, userId)) return null;
  const open = await findActiveRedeemIntentForBag(admin, userId, bag.id);
  return open && stillOpen(open, now) ? { id: open.id } : null;
}

/** The purchase of the same position that blocks a fee attestation, if any. */
export async function purchaseInFlightFor(admin: SupabaseClient, userId: string, bagId: string, now = Date.now()): Promise<{ id: string } | null> {
  const open = await findActivePurchaseIntentForBag(admin, userId, bagId);
  return open && stillOpen(open, now) ? { id: open.id } : null;
}

/**
 * Called right AFTER a purchase intent was written: if a fee-paying sale of the same position is open, the purchase
 * is cancelled (before it could be signed) and the blocking sale is returned.
 */
export async function cancelPurchaseIfFeeSaleOpen(
  admin: SupabaseClient,
  purchase: Pick<PurchaseIntent, 'id' | 'userId' | 'status'>,
  bag: Pick<BagRecord, 'id' | 'creatorId' | 'performanceFeeBpsLocked'>,
  version: Pick<BagVersionRecord, 'recipe'> | null
): Promise<{ id: string } | null> {
  const open = await openFeeRedemptionFor(admin, purchase.userId, bag, version);
  if (!open) return null;
  if (purchase.status === 'READY' || purchase.status === 'QUOTED' || purchase.status === 'DRAFT') {
    await updatePurchaseIntentStatus(admin, { id: purchase.id, from: purchase.status, to: 'CANCELLED' });
  }
  return open;
}

