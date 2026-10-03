-- -----------------------------------------------------------------------------
-- Phase 19 — assemble_bag_nft: Supabase-backed replacement for
-- lib/services/nft-service.ts's assembleBagNFT() (localStorage). Closes the
-- last item on supabase/MIGRATION.md's "still on localStorage" list:
-- NFT assembly's accessory-consumption was intentionally left on
-- lib/services/inventory-service.ts's localStorage `inventory` collection,
-- which nothing has written to since box-opening moved server-side
-- (Phase 18's open_box_with_result() credits the REAL `inventory` table
-- instead) — assembly could never succeed for any real user before this.
--
-- Same pattern as open_box_with_result(): the RARITY computation still
-- happens in application code (lib/domain/nft/rarity-engine.ts, unchanged —
-- it's a pure function of already-owned accessories, nothing to gain from
-- reimplementing in PL/pgSQL), but consuming the 8 accessories and minting
-- the NFT row is one atomic transaction here, so a request can never burn
-- accessories without producing an NFT, or vice versa. Ownership of every
-- slot is checked (with a row lock) BEFORE any accessory is consumed, so a
-- request missing just one slot never partially burns the rest.
-- -----------------------------------------------------------------------------
create or replace function assemble_bag_nft(
  p_user_id uuid,
  p_season_id text,
  p_accessories jsonb,      -- { HEAD: accessoryId, FACE: accessoryId, ... } — exactly ACCESSORY_SLOTS.length keys
  p_rarity text,
  p_genesis_rank integer default null
) returns jsonb
language plpgsql
as $$
declare
  v_slot text;
  v_accessory_id text;
  v_owned integer;
  v_nft_id uuid;
begin
  for v_slot, v_accessory_id in select * from jsonb_each_text(p_accessories)
  loop
    select quantity into v_owned
    from inventory
    where user_id = p_user_id and accessory_id = v_accessory_id
    for update;

    if v_owned is null or v_owned < 1 then
      raise exception 'INSUFFICIENT_ACCESSORIES: %', v_slot;
    end if;
  end loop;

  for v_slot, v_accessory_id in select * from jsonb_each_text(p_accessories)
  loop
    update inventory
    set quantity = quantity - 1
    where user_id = p_user_id and accessory_id = v_accessory_id;
  end loop;

  insert into bag_nfts (owner_id, season_id, rarity, accessories, genesis_rank)
  values (p_user_id, p_season_id, p_rarity, p_accessories, p_genesis_rank)
  returning id into v_nft_id;

  insert into activities (user_id, action)
  values (p_user_id, 'NFT_ASSEMBLED:' || v_nft_id::text);

  return jsonb_build_object('nftId', v_nft_id);
end;
$$;

revoke execute on function assemble_bag_nft from public;
grant execute on function assemble_bag_nft to service_role;
