import { SupabaseClient } from '@supabase/supabase-js';
import { Accessory, Box, BoxTypeId, InventoryItem } from '@/types/domain';
import { rollRarity, pickRandomSlot, pickAccessory } from '@/lib/domain/collectibles/box-engine';
import { ACCESSORY_POOL, accessoriesBySlot } from '@/data/mock-accessories';
import { RARITY_WEIGHTS_BY_BOX } from '@/lib/config/rarity';

// -----------------------------------------------------------------------------
// Phase 18 — Supabase-backed replacement for lib/services/box-service.ts +
// inventory-service.ts's localStorage collections. Closes the regression
// documented in supabase/MIGRATION.md: box purchases now spend against the
// SAME `user_points` row real trading awards into (via the `buy_box` RPC —
// see its doc comment in supabase/schema.sql), instead of a disconnected
// localStorage copy that nothing ever credited.
//
// The rarity/accessory ROLL still happens here in application code, reusing
// lib/domain/collectibles/box-engine.ts's existing (tested) weighted-RNG
// functions unchanged — no reason to reimplement that in PL/pgSQL. What's
// different from the old client-side flow is WHO calls it (this file, from
// a server route, never the browser) and how the result gets committed —
// see open_box_with_result()'s doc comment for why a roll on its own is
// never enough to credit anything.
// -----------------------------------------------------------------------------

interface BoxRow {
  id: string;
  user_id: string;
  box_type: BoxTypeId;
  opened: boolean;
  result_accessory_id: string | null;
  created_at: string;
  opened_at: string | null;
}

function fromRow(row: BoxRow): Box {
  return {
    id: row.id,
    userId: row.user_id,
    boxType: row.box_type,
    opened: row.opened,
    createdAt: row.created_at,
    openedAt: row.opened_at ?? undefined,
    resultAccessoryId: row.result_accessory_id ?? undefined,
  };
}

export async function listBoxesForUser(admin: SupabaseClient, userId: string): Promise<Box[]> {
  const { data, error } = await admin
    .from('boxes')
    .select()
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []).map(fromRow);
}

export type BuyBoxOutcome =
  | { ok: true; box: Box }
  | { ok: false; error: 'INSUFFICIENT_POINTS' | 'UNKNOWN_BOX_TYPE' | string };

/**
 * Buys a box: atomic, server-verified points check + deduction + box
 * creation, all inside `buy_box()` (supabase/schema.sql) — cost is read
 * from `box_types` there, never trusted from the caller. `clientRequestId`
 * (optional) makes a retried/duplicated request return the SAME box
 * instead of spending points twice.
 */
export async function buyBoxForUser(
  admin: SupabaseClient,
  userId: string,
  seasonId: string,
  boxType: BoxTypeId,
  clientRequestId?: string
): Promise<BuyBoxOutcome> {
  const { data, error } = await admin.rpc('buy_box', {
    p_user_id: userId,
    p_season_id: seasonId,
    p_box_type: boxType,
    p_client_request_id: clientRequestId ?? null,
  });

  if (error) {
    if (error.message.includes('INSUFFICIENT_POINTS')) return { ok: false, error: 'INSUFFICIENT_POINTS' };
    if (error.message.includes('UNKNOWN_BOX_TYPE')) return { ok: false, error: 'UNKNOWN_BOX_TYPE' };
    return { ok: false, error: error.message };
  }

  const boxId = (data as { boxId: string }).boxId;
  const { data: boxRow, error: fetchError } = await admin.from('boxes').select().eq('id', boxId).single<BoxRow>();
  if (fetchError) throw new Error(fetchError.message);
  return { ok: true, box: fromRow(boxRow) };
}

export type OpenBoxOutcome =
  | { ok: true; box: Box; accessory: Accessory }
  | { ok: false; error: 'NOT_FOUND' | string };

/**
 * Opens a box. The rarity/slot/accessory roll happens HERE, server-side —
 * relative to the caller, this is exactly as untrusted-input-free as the
 * old box-service.ts's openBox() was (nothing about the result was ever
 * client-supplied there either) — what Phase 18 adds is that the roll is
 * never itself the thing that "counts": `open_box_with_result()`'s atomic
 * compare-and-swap is (see its doc comment). A box that's already opened
 * (by a previous call, OR a concurrent one that won the race) returns that
 * EXISTING result — this function never re-rolls for an already-opened box.
 */
export async function openBoxForUser(admin: SupabaseClient, userId: string, boxId: string): Promise<OpenBoxOutcome> {
  const boxType = await getOwnedBoxType(admin, userId, boxId);
  if (!boxType.ok) return boxType;

  const rarity = rollRarity(boxType.value, RARITY_WEIGHTS_BY_BOX[boxType.value]);
  const slot = pickRandomSlot();
  const slotPool = accessoriesBySlot(slot);
  const accessory = pickAccessory(slotPool.length > 0 ? slotPool : ACCESSORY_POOL, rarity);

  const { data, error } = await admin.rpc('open_box_with_result', {
    p_user_id: userId,
    p_box_id: boxId,
    p_accessory_id: accessory.id,
  });

  if (error) {
    if (error.message.includes('BOX_NOT_FOUND')) return { ok: false, error: 'NOT_FOUND' };
    return { ok: false, error: error.message };
  }

  const result = data as { openedNow: boolean; accessoryId: string };
  // `openedNow: false` means a PRIOR call already committed a (possibly
  // different) roll — always report the accessory that actually won, never
  // the one rolled in THIS call, since that roll was never written if we
  // lost the race.
  const finalAccessory = ACCESSORY_POOL.find((a) => a.id === result.accessoryId) ?? accessory;

  const { data: boxRow, error: fetchError } = await admin.from('boxes').select().eq('id', boxId).single<BoxRow>();
  if (fetchError) throw new Error(fetchError.message);

  return { ok: true, box: fromRow(boxRow), accessory: finalAccessory };
}

async function getOwnedBoxType(
  admin: SupabaseClient,
  userId: string,
  boxId: string
): Promise<{ ok: true; value: BoxTypeId } | { ok: false; error: 'NOT_FOUND' }> {
  const { data, error } = await admin
    .from('boxes')
    .select('box_type')
    .eq('id', boxId)
    .eq('user_id', userId)
    .maybeSingle<{ box_type: BoxTypeId }>();
  if (error) throw new Error(error.message);
  if (!data) return { ok: false, error: 'NOT_FOUND' };
  return { ok: true, value: data.box_type };
}

interface InventoryRow {
  user_id: string;
  accessory_id: string;
  quantity: number;
}

export async function listInventoryForUser(admin: SupabaseClient, userId: string): Promise<InventoryItem[]> {
  const { data, error } = await admin
    .from('inventory')
    .select()
    .eq('user_id', userId)
    .gt('quantity', 0)
    .order('accessory_id', { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []).map((row: InventoryRow) => ({
    userId: row.user_id,
    accessoryId: row.accessory_id,
    quantity: row.quantity,
  }));
}
