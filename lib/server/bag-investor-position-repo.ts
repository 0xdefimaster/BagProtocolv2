import { SupabaseClient } from '@supabase/supabase-js';

// -----------------------------------------------------------------------------
// Phase 20 — Supabase-backed persistence for a single user's position in a
// single Bag (`bag_investor_positions` table, supabase/migrations/
// 0011_add_bag_investor_positions.sql). Same conventions as
// `bag-share-state-repo.ts`: server-only, called with the service-role
// client, row<->domain mapper, bootstrap-safe reads.
//
// ---------------------------- Bootstrap state --------------------------------
// A (user, bag) pair with no row here is NOT an error — it's every
// investor's starting state before their first completed purchase.
// `getInvestorPosition()` returns a zero position in that case, never
// throws, and never fabricates a nonzero value.
//
// ---------------------------- Security boundary -----------------------------
// This file CANNOT enforce "this position belongs to this session" itself
// — it's called with the service-role client, which bypasses RLS entirely
// (bag_investor_positions has no RLS policies at all — see the migration's
// doc comment). Every caller MUST reach this only after requireSession()
// has confirmed the position being read belongs to the session's own
// userId, exactly like every other private-data repo in this codebase
// (purchase-intent-repo.ts's getPurchaseIntentForUser() is the template).
// -----------------------------------------------------------------------------

export interface InvestorPosition {
  userId: string;
  bagId: string;
  sharesRaw: string;
  shareDecimals: number;
  /** Additive sum of every completed deposit's quoted amount (`purchase_intents.deposit_amount`) — see the migration's doc comment for why this, not a derived `sharePriceAtQuote * shares` figure, is the source of truth. */
  costBasisQuote: string;
  updatedAt: string;
}

interface BagInvestorPositionRow {
  user_id: string;
  bag_id: string;
  shares_raw: string;
  share_decimals: number;
  cost_basis_quote: string;
  updated_at: string;
}

function fromRow(row: BagInvestorPositionRow): InvestorPosition {
  return {
    userId: row.user_id,
    bagId: row.bag_id,
    sharesRaw: row.shares_raw,
    shareDecimals: row.share_decimals,
    costBasisQuote: row.cost_basis_quote,
    updatedAt: row.updated_at,
  };
}

/** Matches `bag-share-state-repo.ts`'s `DEFAULT_SHARE_DECIMALS` — only relevant for a position that has never had a row written (see `bootstrapPosition()`). */
const DEFAULT_SHARE_DECIMALS = 18;

function bootstrapPosition(userId: string, bagId: string): InvestorPosition {
  return {
    userId,
    bagId,
    sharesRaw: '0',
    shareDecimals: DEFAULT_SHARE_DECIMALS,
    costBasisQuote: '0',
    updatedAt: new Date(0).toISOString(),
  };
}

/**
 * Reads one user's position in one Bag. Never throws for a pair with no
 * row yet — returns `bootstrapPosition()` instead (see this file's module
 * doc). Callers MUST have already verified `userId` matches the requesting
 * session (see Security boundary above) — this function performs no such
 * check itself.
 */
export async function getInvestorPosition(
  admin: SupabaseClient,
  userId: string,
  bagId: string
): Promise<InvestorPosition> {
  const { data, error } = await admin
    .from('bag_investor_positions')
    .select()
    .eq('user_id', userId)
    .eq('bag_id', bagId)
    .maybeSingle<BagInvestorPositionRow>();
  if (error) throw new Error(error.message);
  return data ? fromRow(data) : bootstrapPosition(userId, bagId);
}

/** Every position a user holds across all Bags — used by the profile page's holdings list. Rows with zero shares are never inserted in the first place (see the migration), so no zero-filtering is needed here. */
export async function listInvestorPositionsForUser(
  admin: SupabaseClient,
  userId: string
): Promise<InvestorPosition[]> {
  const { data, error } = await admin
    .from('bag_investor_positions')
    .select()
    .eq('user_id', userId)
    .returns<BagInvestorPositionRow[]>();
  if (error) throw new Error(error.message);
  return (data ?? []).map(fromRow);
}
