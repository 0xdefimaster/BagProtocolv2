import { SupabaseClient } from '@supabase/supabase-js';
import { ShareSupply } from '@/types/basket-protocol';

// -----------------------------------------------------------------------------
// Phase 13 — Supabase-backed persistence for `ShareSupply`
// (types/basket-protocol.ts, Phase 9) — `bag_share_state` table
// (supabase/schema.sql). Same conventions as `lib/server/bag-holdings-repo.ts`:
// server-only, called with the service-role client, row<->domain mapper.
//
// ---------------------------- Bootstrap state --------------------------------
// A Bag with no row in `bag_share_state` is NOT an error state — it's every
// Bag's starting state, since no mint transaction exists yet (Phase 17).
// `getShareSupply()` returns a zero-supply `ShareSupply` in that case,
// never throws, and never fabricates a nonzero value. This is the same
// state `getDepositQuote()`'s bootstrap branch (lib/domain/basket-protocol/
// shares/shares.ts, Phase 9) is designed to price against — see this
// file's `DEFAULT_SHARE_DECIMALS` doc for the one default this layer does
// own (the domain layer owns none: `ShareSupply` has no built-in default,
// by design, since it's meant to always come from somewhere real).
//
// ---------------------------- Security boundary -----------------------------
// Same split as `bag-holdings-repo.ts`'s header: this file CANNOT enforce
// ownership itself — it's called with the service-role client, which
// bypasses RLS entirely. `setShareSupply()` has no caller anywhere in this
// codebase yet (no mint/redeem transaction exists — Phase 17); it exists
// now so that phase has a ready single-row upsert to call rather than a
// table AND a repo to design at that point. When a caller is added, it
// MUST reach this only after whatever ownership/protocol check that
// future phase requires — exactly the same requirement `bag-holdings-repo.ts`
// already documents for `replaceBagHoldings()`.
// -----------------------------------------------------------------------------

/**
 * What an unminted Bag's share token would use — matches the default
 * every ERC20 in this codebase's `Phase 4` contract tooling assumes
 * (`lib/blockchain/evm/factory-abi.ts`), and the same value
 * `lib/server/purchase-preview.ts` hardcoded before this phase moved that
 * hardcode into this single, documented place. Only relevant for a Bag
 * that has never had a row written here — once `setShareSupply()` writes
 * a real row, that row's own `share_decimals` is authoritative, not this
 * constant.
 */
export const DEFAULT_SHARE_DECIMALS = 18;

interface BagShareStateRow {
  bag_id: string;
  total_shares_raw: string;
  share_decimals: number;
  updated_at: string;
}

function fromRow(row: BagShareStateRow): ShareSupply {
  return {
    bagId: row.bag_id,
    totalSharesRaw: row.total_shares_raw,
    shareDecimals: row.share_decimals,
    updatedAt: row.updated_at,
  };
}

/** The bootstrap `ShareSupply` for a Bag with no persisted row — zero shares outstanding, `DEFAULT_SHARE_DECIMALS` precision, and a deliberately-recognizable epoch `updatedAt` ("never actually persisted") rather than "now", so a caller inspecting this value can tell a genuinely-bootstrap Bag apart from a real (if coincidentally zero) row written at the current instant. */
function bootstrapShareSupply(bagId: string): ShareSupply {
  return {
    bagId,
    totalSharesRaw: '0',
    shareDecimals: DEFAULT_SHARE_DECIMALS,
    updatedAt: new Date(0).toISOString(),
  };
}

/**
 * Reads a Bag's current `ShareSupply`. Never throws for a Bag that simply
 * has no row yet — returns `bootstrapShareSupply()` instead (see this
 * file's module doc). A caller that needs to distinguish "genuinely
 * bootstrap" from "a real row, zero by coincidence" can compare
 * `updatedAt` against the epoch, though nothing in this codebase needs
 * that distinction yet.
 */
export async function getShareSupply(admin: SupabaseClient, bagId: string): Promise<ShareSupply> {
  const { data, error } = await admin.from('bag_share_state').select().eq('bag_id', bagId).maybeSingle<BagShareStateRow>();
  if (error) throw new Error(error.message);
  return data ? fromRow(data) : bootstrapShareSupply(bagId);
}

export interface SetShareSupplyInput {
  bagId: string;
  totalSharesRaw: string;
  shareDecimals: number;
}

/**
 * Creates or overwrites a Bag's share-state row — a single-row upsert,
 * atomic by nature, same shape as `bag-holdings-repo.ts`'s
 * `upsertBagHolding()`. No caller anywhere in this codebase reaches this
 * yet (see this file's module doc) — this is NOT wired into mint/redeem,
 * because no mint/redeem transaction exists yet (Phase 17). Exists now,
 * additively, so that phase's implementation is "call this function" and
 * not "also design this table and this write path."
 */
export async function setShareSupply(admin: SupabaseClient, input: SetShareSupplyInput): Promise<ShareSupply> {
  const { data, error } = await admin
    .from('bag_share_state')
    .upsert(
      {
        bag_id: input.bagId,
        total_shares_raw: input.totalSharesRaw,
        share_decimals: input.shareDecimals,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'bag_id' }
    )
    .select()
    .single<BagShareStateRow>();

  if (error) throw new Error(error.message);
  return fromRow(data);
}
