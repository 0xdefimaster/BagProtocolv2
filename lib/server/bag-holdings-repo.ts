import { SupabaseClient } from '@supabase/supabase-js';
import { AssetIdentity, BagHolding, ChainId } from '@/types/basket-protocol';
import { normalizeAssetAddress } from '@/lib/domain/basket-protocol/asset-identity';

// -----------------------------------------------------------------------------
// Supabase-backed persistence for `BagHolding` (`bag_holdings` table,
// supabase/schema.sql) — same conventions as `lib/server/asset-repo.ts` and
// `lib/server/bag-repo.ts`: server-only, called with the service-role
// client, row<->domain mappers, addresses normalized before every write so
// `unique(bag_id, chain, address)` can't be bypassed by casing alone.
//
// ---------------------------- Security boundary -----------------------------
// Same split as `lib/server/bag-repo.ts`'s header, and just as important
// here: this file CANNOT enforce "creator vs. other user" itself — it's
// called with the service-role client, which bypasses RLS entirely. Every
// write here MUST be reached only through `lib/server/bag-holdings.ts`'s
// `setBagHoldings()`, which does the ownership + verified-asset checks
// BEFORE calling anything in this file. This file trusts whatever bagId/
// holdings it's given — never call it directly from a route handler.
// -----------------------------------------------------------------------------

interface BagHoldingRow {
  id: string;
  bag_id: string;
  chain: string;
  address: string;
  quantity_raw: string;
  decimals: number;
  created_at: string;
  updated_at: string;
}

function fromRow(row: BagHoldingRow): BagHolding {
  return {
    bagId: row.bag_id,
    asset: { chain: row.chain as ChainId, address: row.address },
    quantityRaw: row.quantity_raw,
    decimals: row.decimals,
    updatedAt: row.updated_at,
  };
}

// ----------------------------- Read -----------------------------------------

export async function getBagHoldings(admin: SupabaseClient, bagId: string): Promise<BagHolding[]> {
  const { data, error } = await admin.from('bag_holdings').select().eq('bag_id', bagId);
  if (error) throw new Error(error.message);
  return ((data ?? []) as BagHoldingRow[]).map(fromRow);
}

// ----------------------------- Single-row write -------------------------------

export interface UpsertBagHoldingInput {
  bagId: string;
  asset: AssetIdentity;
  quantityRaw: string;
  decimals: number;
}

/** Creates or updates ONE holding row for (bagId, asset) — a single-row operation, atomic by nature, no RPC needed. For updating several holdings together, use `replaceBagHoldings()` instead — see its doc for why a multi-row change needs a different code path. */
export async function upsertBagHolding(admin: SupabaseClient, input: UpsertBagHoldingInput): Promise<BagHolding> {
  const address = normalizeAssetAddress(input.asset.chain, input.asset.address);
  const now = new Date().toISOString();

  const { data, error } = await admin
    .from('bag_holdings')
    .upsert(
      {
        bag_id: input.bagId,
        chain: input.asset.chain,
        address,
        quantity_raw: input.quantityRaw,
        decimals: input.decimals,
        updated_at: now,
      },
      { onConflict: 'bag_id,chain,address' }
    )
    .select()
    .single<BagHoldingRow>();

  if (error) throw new Error(error.message);
  return fromRow(data);
}

export async function removeBagHolding(admin: SupabaseClient, bagId: string, asset: AssetIdentity): Promise<void> {
  const address = normalizeAssetAddress(asset.chain, asset.address);
  const { error } = await admin
    .from('bag_holdings')
    .delete()
    .eq('bag_id', bagId)
    .eq('chain', asset.chain)
    .eq('address', address);
  if (error) throw new Error(error.message);
}

// ----------------------------- Atomic batch write -------------------------------

export interface ReplaceBagHoldingInput {
  asset: AssetIdentity;
  quantityRaw: string;
  decimals: number;
}

/**
 * Replaces a bag's ENTIRE holdings set atomically — via
 * `replace_bag_holdings()` (supabase/schema.sql), a single Postgres
 * function call, so "BTC updated, ETH/USDC failed" (spec section 6) is
 * structurally impossible: the delete-then-insert happens inside one
 * transaction, same atomicity guarantee `createBag()`
 * (`lib/server/bag-repo.ts`) already relies on for its own RPC. This is
 * the function `lib/server/bag-holdings.ts`'s `setBagHoldings()` (which
 * does the ownership/verified-asset checks) actually calls — nothing else
 * should need a partial/per-asset update in this phase (spec explicitly
 * doesn't ask for incremental rebalance execution yet).
 */
export async function replaceBagHoldings(
  admin: SupabaseClient,
  bagId: string,
  holdings: ReplaceBagHoldingInput[]
): Promise<BagHolding[]> {
  const payload = holdings.map((h) => ({
    chain: h.asset.chain,
    address: normalizeAssetAddress(h.asset.chain, h.asset.address),
    quantity_raw: h.quantityRaw,
    decimals: h.decimals,
  }));

  const { data, error } = await admin.rpc('replace_bag_holdings', { p_bag_id: bagId, p_holdings: payload });
  if (error) throw new Error(error.message);

  return ((data ?? []) as BagHoldingRow[]).map(fromRow);
}
