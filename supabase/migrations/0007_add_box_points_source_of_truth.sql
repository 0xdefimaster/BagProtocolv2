-- Phase 18 — Points / Box Source of Truth.
--
-- Closes the regression supabase/MIGRATION.md documented under "Known
-- regression introduced by this pass": box purchases were spending against
-- a localStorage-only `user_points` copy that nothing writes to anymore
-- (real points accrue in Supabase from trading), so every box purchase
-- failed with "Not enough BAG Points" regardless of a user's real balance.
--
-- See supabase/schema.sql's inline doc comments on buy_box() and
-- open_box_with_result() for the full reasoning — this migration mirrors
-- that schema block for existing installs.

alter table boxes add column if not exists client_request_id text;

create unique index if not exists idx_boxes_user_client_request
  on boxes(user_id, client_request_id) where client_request_id is not null;

insert into box_types (id, name, cost) values
  ('COMMON', 'Common Box', 100),
  ('RARE', 'Rare Box', 500),
  ('EPIC', 'Epic Box', 2000)
on conflict (id) do update set name = excluded.name, cost = excluded.cost;

insert into accessories (id, name, slot, rarity, image) values
  ('head-cyber-cap', 'Cyber Cap', 'HEAD', 'RARE', '🧢'),
  ('head-beanie', 'BAG Beanie', 'HEAD', 'COMMON', '🎩'),
  ('head-halo', 'Golden Halo', 'HEAD', 'LEGENDARY', '😇'),
  ('head-headband', 'Trader Headband', 'HEAD', 'UNCOMMON', '🎽'),
  ('face-laser-glasses', 'Laser Glasses', 'FACE', 'RARE', '🕶️'),
  ('face-monocle', 'Diamond Monocle', 'FACE', 'EPIC', '🧐'),
  ('face-shades', 'Classic Shades', 'FACE', 'COMMON', '😎'),
  ('face-visor', 'Neon Visor', 'FACE', 'UNCOMMON', '🥽'),
  ('neck-red-scarf', 'Red Scarf', 'NECK', 'COMMON', '🧣'),
  ('neck-gold-chain', 'Gold Chain', 'NECK', 'RARE', '📿'),
  ('neck-bowtie', 'Trader Bowtie', 'NECK', 'UNCOMMON', '🎀'),
  ('neck-medallion', 'Genesis Medallion', 'NECK', 'LEGENDARY', '🏅'),
  ('body-hoodie', 'BAG Hoodie', 'BODY', 'COMMON', '🧥'),
  ('body-suit', 'Pinstripe Suit', 'BODY', 'RARE', '🥼'),
  ('body-armor', 'Diamond-Hand Armor', 'BODY', 'EPIC', '🦺'),
  ('body-tee', 'Genesis Tee', 'BODY', 'UNCOMMON', '👕'),
  ('back-rocket', 'Rocket Backpack', 'BACK', 'EPIC', '🚀'),
  ('back-cape', 'Trader Cape', 'BACK', 'RARE', '🦸'),
  ('back-wings', 'Bull Wings', 'BACK', 'LEGENDARY', '🪽'),
  ('back-satchel', 'Canvas Satchel', 'BACK', 'COMMON', '🎒'),
  ('hands-diamond-gloves', 'Diamond Gloves', 'HANDS', 'RARE', '🧤'),
  ('hands-fingerless', 'Fingerless Gloves', 'HANDS', 'COMMON', '🖐️'),
  ('hands-golden-fist', 'Golden Fist', 'HANDS', 'EPIC', '👊'),
  ('hands-rings', 'Stacked Rings', 'HANDS', 'UNCOMMON', '💍'),
  ('feet-sneakers', 'BAG Sneakers', 'FEET', 'COMMON', '👟'),
  ('feet-boots', 'Trader Boots', 'FEET', 'UNCOMMON', '🥾'),
  ('feet-rocket-boots', 'Rocket Boots', 'FEET', 'RARE', '🛼'),
  ('feet-golden-cleats', 'Golden Cleats', 'FEET', 'EPIC', '⛳'),
  ('special-golden-banana', 'Golden Banana', 'SPECIAL', 'LEGENDARY', '🍌'),
  ('special-lucky-coin', 'Lucky Coin', 'SPECIAL', 'RARE', '🪙'),
  ('special-candle', 'Green Candle', 'SPECIAL', 'UNCOMMON', '🕯️'),
  ('special-diamond', 'Raw Diamond', 'SPECIAL', 'EPIC', '💎'),
  ('special-cup', 'Genesis Cup', 'SPECIAL', 'COMMON', '🏆')
on conflict (id) do update set name = excluded.name, slot = excluded.slot, rarity = excluded.rarity, image = excluded.image;

create or replace function buy_box(
  p_user_id uuid,
  p_season_id text,
  p_box_type text,
  p_client_request_id text
) returns jsonb
language plpgsql
as $$
declare
  v_cost integer;
  v_existing_box_id uuid;
  v_available integer;
  v_box_id uuid;
begin
  if p_client_request_id is not null then
    select id into v_existing_box_id
    from boxes
    where user_id = p_user_id and client_request_id = p_client_request_id;

    if v_existing_box_id is not null then
      return jsonb_build_object('alreadyApplied', true, 'boxId', v_existing_box_id);
    end if;
  end if;

  select cost into v_cost from box_types where id = p_box_type;
  if v_cost is null then
    raise exception 'UNKNOWN_BOX_TYPE';
  end if;

  insert into user_points (user_id, season_id)
  values (p_user_id, p_season_id)
  on conflict (user_id, season_id) do nothing;

  select points_available into v_available
  from user_points
  where user_id = p_user_id and season_id = p_season_id
  for update;

  if v_available < v_cost then
    raise exception 'INSUFFICIENT_POINTS';
  end if;

  insert into boxes (user_id, box_type, client_request_id)
  values (p_user_id, p_box_type, p_client_request_id)
  returning id into v_box_id;

  update user_points
  set points_spent = points_spent + v_cost,
      points_available = points_available - v_cost
  where user_id = p_user_id and season_id = p_season_id;

  insert into point_transactions (user_id, season_id, type, amount, reference_id)
  values (p_user_id, p_season_id, 'BOX_PURCHASE', -v_cost, v_box_id::text);

  return jsonb_build_object('alreadyApplied', false, 'boxId', v_box_id);
end;
$$;

revoke execute on function buy_box from public;
grant execute on function buy_box to service_role;

create or replace function open_box_with_result(
  p_user_id uuid,
  p_box_id uuid,
  p_accessory_id text
) returns jsonb
language plpgsql
as $$
declare
  v_updated_id uuid;
  v_result_accessory_id text;
  v_opened_now boolean := false;
begin
  update boxes
  set opened = true, opened_at = now(), result_accessory_id = p_accessory_id
  where id = p_box_id and user_id = p_user_id and opened = false
  returning id into v_updated_id;

  if v_updated_id is not null then
    v_opened_now := true;
    v_result_accessory_id := p_accessory_id;

    insert into inventory (user_id, accessory_id, quantity)
    values (p_user_id, p_accessory_id, 1)
    on conflict (user_id, accessory_id) do update
      set quantity = inventory.quantity + 1;

    insert into activities (user_id, action)
    values (p_user_id, 'BOX_OPENED:' || p_box_id::text || ':' || p_accessory_id);
  else
    select result_accessory_id into v_result_accessory_id
    from boxes
    where id = p_box_id and user_id = p_user_id;

    if v_result_accessory_id is null then
      raise exception 'BOX_NOT_FOUND';
    end if;
  end if;

  return jsonb_build_object('openedNow', v_opened_now, 'accessoryId', v_result_accessory_id);
end;
$$;

revoke execute on function open_box_with_result from public;
grant execute on function open_box_with_result to service_role;
