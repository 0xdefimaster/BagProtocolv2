import { SupabaseClient } from '@supabase/supabase-js';
import { AccessorySlot, ACCESSORY_SLOTS, BagNFT, Rarity } from '@/types/domain';

// -----------------------------------------------------------------------------
// Phase 19 — Supabase-backed replacement for lib/services/nft-service.ts's
// listBagNFTs() / assembleBagNFT() (localStorage). See
// supabase/migrations/0010_add_assemble_bag_nft.sql's assemble_bag_nft() for
// why accessory-consumption and minting happen as one atomic RPC call rather
// than as separate reads/writes from here.
// -----------------------------------------------------------------------------

interface BagNftRow {
  id: string;
  owner_id: string;
  season_id: string;
  rarity: Rarity;
  accessories: Record<AccessorySlot, string>;
  genesis_rank: number | null;
  blockchain_status: 'OFFCHAIN' | 'MINTED';
  created_at: string;
}

function fromRow(row: BagNftRow): BagNFT {
  return {
    id: row.id,
    ownerId: row.owner_id,
    seasonId: row.season_id,
    rarity: row.rarity,
    accessories: row.accessories,
    genesisRank: row.genesis_rank ?? undefined,
    createdAt: row.created_at,
    blockchainStatus: row.blockchain_status,
  };
}

export async function listBagNftsForUser(admin: SupabaseClient, userId: string): Promise<BagNFT[]> {
  const { data, error } = await admin
    .from('bag_nfts')
    .select()
    .eq('owner_id', userId)
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []).map(fromRow);
}

export type SlotSelection = Partial<Record<AccessorySlot, string>>;

export type AssembleOutcome =
  | { ok: true; nft: BagNFT }
  | { ok: false; error: 'INCOMPLETE_SELECTION' | 'INSUFFICIENT_ACCESSORIES' | string };

/**
 * Assembles a BAG NFT: requires exactly one accessory per ACCESSORY_SLOTS
 * entry, already owned in `inventory`. Rarity/genesisRank are computed by
 * the caller (route layer) and passed in already-resolved — this function's
 * only job is the atomic consume-and-mint via assemble_bag_nft().
 */
export async function assembleBagNftForUser(
  admin: SupabaseClient,
  userId: string,
  seasonId: string,
  selection: SlotSelection,
  rarity: Rarity,
  genesisRank?: number
): Promise<AssembleOutcome> {
  const missing = ACCESSORY_SLOTS.filter((slot) => !selection[slot]);
  if (missing.length > 0) {
    return { ok: false, error: `INCOMPLETE_SELECTION: ${missing.join(', ')}` };
  }
  const accessories = selection as Record<AccessorySlot, string>;

  const { data, error } = await admin.rpc('assemble_bag_nft', {
    p_user_id: userId,
    p_season_id: seasonId,
    p_accessories: accessories,
    p_rarity: rarity,
    p_genesis_rank: genesisRank ?? null,
  });

  if (error) {
    if (error.message.includes('INSUFFICIENT_ACCESSORIES')) {
      return { ok: false, error: error.message.trim() };
    }
    return { ok: false, error: error.message };
  }

  const nftId = (data as { nftId: string }).nftId;
  const { data: row, error: fetchError } = await admin
    .from('bag_nfts')
    .select()
    .eq('id', nftId)
    .single<BagNftRow>();
  if (fetchError) throw new Error(fetchError.message);

  return { ok: true, nft: fromRow(row) };
}
