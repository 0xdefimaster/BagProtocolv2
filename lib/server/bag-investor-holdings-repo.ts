import { SupabaseClient } from '@supabase/supabase-js';
import { ChainId } from '@/types/basket-protocol';

// -----------------------------------------------------------------------------
// Phase 21 — Supabase-backed reads for `bag_investor_holdings` (see
// supabase/migrations/0012_add_redeem_execution.sql for the full
// rationale: this is a specific depositor's OWN per-asset quantities,
// never the bag-level aggregate `bag_holdings`). No write function here —
// same convention as `bag-holdings.ts`'s bag-level table: every write goes
// through the `apply_purchase_execution()`/`apply_redeem_execution()`/
// `apply_partial_redeem_execution()` RPCs, never a direct upsert from
// application code.
//
// ---------------------------- Security boundary -----------------------------
// Same as every other *-repo.ts file here: called with the service-role
// client, which bypasses RLS entirely. Every caller MUST have already
// verified `userId` matches the requesting session.
// -----------------------------------------------------------------------------

export interface InvestorHolding {
  userId: string;
  bagId: string;
  chain: ChainId;
  address: string;
  quantityRaw: string;
  decimals: number;
  updatedAt: string;
}

interface BagInvestorHoldingRow {
  user_id: string;
  bag_id: string;
  chain: string;
  address: string;
  quantity_raw: string;
  decimals: number;
  updated_at: string;
}

function fromRow(row: BagInvestorHoldingRow): InvestorHolding {
  return {
    userId: row.user_id,
    bagId: row.bag_id,
    chain: row.chain as ChainId,
    address: row.address,
    quantityRaw: row.quantity_raw,
    decimals: row.decimals,
    updatedAt: row.updated_at,
  };
}

/** Every asset this depositor holds for this specific Bag right now. Empty array (never an error) for a depositor with no completed purchases yet — same "absence is bootstrap state, not a fault" convention `bag-investor-position-repo.ts` documents. */
export async function getInvestorHoldings(admin: SupabaseClient, userId: string, bagId: string): Promise<InvestorHolding[]> {
  const { data, error } = await admin
    .from('bag_investor_holdings')
    .select()
    .eq('user_id', userId)
    .eq('bag_id', bagId)
    .returns<BagInvestorHoldingRow[]>();
  if (error) throw new Error(error.message);
  return (data ?? []).map(fromRow);
}
