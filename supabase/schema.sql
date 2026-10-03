-- =============================================================================
-- BAG Protocol — Supabase / Postgres schema
--
-- This mirrors exactly what lib/services/*.ts stores in localStorage today
-- (same collections, same fields) so migrating off local-only storage is a
-- mechanical swap: each service function's readCollection/writeCollection
-- call becomes a Supabase query, table names and shapes already match.
--
-- Run this in the Supabase SQL editor (or `supabase db push`) on a fresh
-- project. Row Level Security policies at the bottom assume Supabase Auth
-- with a custom claim / users.wallet_address linkage — adjust to whatever
-- auth strategy you wire up (wallet-signature session, SIWE, etc).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- users — one row per wallet. This is the row that must NEVER reset when a
-- user switches browsers/devices; it's what "wallet address" migrates to.
-- ---------------------------------------------------------------------------
create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  wallet_address text unique not null,
  display_name text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- auth_nonces — one-time Sign-In-With-Wallet challenges. Short-lived by
-- design (see lib/auth/nonce.ts); no RLS needed since only the service-role
-- client (server-only) ever touches this table.
-- ---------------------------------------------------------------------------
create table if not exists auth_nonces (
  wallet_address text primary key,
  nonce text not null,
  message text not null,
  expires_at timestamptz not null
);

-- ---------------------------------------------------------------------------
-- seasons
-- ---------------------------------------------------------------------------
create table if not exists seasons (
  id text primary key,               -- e.g. 'season-genesis-01'
  name text not null,
  start_date timestamptz not null,
  end_date timestamptz not null,
  status text not null check (status in ('UPCOMING', 'ACTIVE', 'ENDED')),
  top_users_reward integer not null default 20
);

-- Seed the one season the app currently ships (lib/config/season.ts).
-- point_transactions/user_points/bag_nfts all have a foreign key into this
-- table, so it must exist before any trade is ever recorded.
insert into seasons (id, name, start_date, end_date, status, top_users_reward)
values (
  'season-genesis-01',
  'BAG Genesis Season 01',
  '2026-01-01T00:00:00.000Z',
  '2026-04-01T00:00:00.000Z',
  'ACTIVE',
  20
)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- portfolios — one row per user (1:1). Cash balance + realized PnL live
-- here; open positions live in `positions`.
-- ---------------------------------------------------------------------------
create table if not exists portfolios (
  user_id uuid primary key references users(id) on delete cascade,
  cash_balance numeric(18, 2) not null default 10000,
  realized_pnl numeric(18, 2) not null default 0,
  -- Phase 18.9 — monotonic counter, incremented by 1 on every successful
  -- commit_investment_transaction() write. Replaces a cash-balance-only
  -- staleness check (see that function's doc comment in this file).
  portfolio_version integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists positions (
  user_id uuid not null references users(id) on delete cascade,
  symbol text not null,
  quantity numeric(24, 8) not null check (quantity >= 0),
  avg_cost numeric(18, 8) not null,
  primary key (user_id, symbol)
);

-- ---------------------------------------------------------------------------
-- trades — full BUY/SELL log. client_trade_id enforces idempotency: the
-- same client-submitted trade can never post twice.
-- ---------------------------------------------------------------------------
create table if not exists trades (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  symbol text not null,
  side text not null check (side in ('BUY', 'SELL')),
  quantity numeric(24, 8) not null check (quantity > 0),
  price numeric(18, 8) not null check (price > 0),
  total_value numeric(18, 2) not null,
  realized_pnl numeric(18, 2) not null default 0,
  bag_id text,
  client_trade_id text,
  created_at timestamptz not null default now(),
  unique (user_id, client_trade_id)
);

create index if not exists idx_trades_user on trades(user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- points — BAG Points ledger + per-season aggregate.
-- ---------------------------------------------------------------------------
create table if not exists point_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  season_id text not null references seasons(id),
  type text not null check (type in ('TRADE_PROFIT', 'BOX_PURCHASE', 'ADMIN_ADJUSTMENT')),
  amount integer not null,
  reference_id text,
  created_at timestamptz not null default now()
);

create table if not exists user_points (
  user_id uuid not null references users(id) on delete cascade,
  season_id text not null references seasons(id),
  total_realized_pnl numeric(18, 2) not null default 0,
  bag_points integer not null default 0,
  points_spent integer not null default 0,
  points_available integer not null default 0,
  primary key (user_id, season_id)
);

create index if not exists idx_user_points_leaderboard
  on user_points(season_id, total_realized_pnl desc);

-- ---------------------------------------------------------------------------
-- leaderboard_snapshots — optional: periodic frozen snapshots so "Top 20"
-- history / Genesis rank at a point in time can be audited later, instead
-- of only ever reading the live-computed rank.
-- ---------------------------------------------------------------------------
create table if not exists leaderboard_snapshots (
  id uuid primary key default gen_random_uuid(),
  season_id text not null references seasons(id),
  taken_at timestamptz not null default now(),
  rank integer not null,
  user_id uuid not null references users(id) on delete cascade,
  realized_pnl numeric(18, 2) not null,
  bag_points integer not null
);

-- ---------------------------------------------------------------------------
-- boxes / accessories / inventory / bag_nfts
-- ---------------------------------------------------------------------------
create table if not exists box_types (
  id text primary key,               -- 'COMMON' | 'RARE' | 'EPIC'
  name text not null,
  cost integer not null
);

create table if not exists boxes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  box_type text not null references box_types(id),
  opened boolean not null default false,
  result_accessory_id text,
  created_at timestamptz not null default now(),
  opened_at timestamptz,
  -- Phase 18 — optional client-supplied idempotency key for buy_box()
  -- below, same convention as trades.client_trade_id: a retried "buy"
  -- request (double-click, client retry after a dropped response) returns
  -- the SAME box and never spends points twice. NULL when the caller
  -- doesn't supply one (multiple NULLs are allowed by this partial unique
  -- index — only non-null keys are deduped).
  client_request_id text
);

create unique index if not exists idx_boxes_user_client_request
  on boxes(user_id, client_request_id) where client_request_id is not null;

create table if not exists accessories (
  id text primary key,               -- e.g. 'head-cyber-cap'
  name text not null,
  slot text not null check (slot in ('HEAD','FACE','NECK','BODY','BACK','HANDS','FEET','SPECIAL')),
  rarity text not null check (rarity in ('COMMON','UNCOMMON','RARE','EPIC','LEGENDARY')),
  image text not null,
  metadata jsonb not null default '{}'::jsonb
);

create table if not exists inventory (
  user_id uuid not null references users(id) on delete cascade,
  accessory_id text not null references accessories(id),
  quantity integer not null default 0 check (quantity >= 0),
  primary key (user_id, accessory_id)
);

create table if not exists bag_nfts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references users(id) on delete cascade,
  season_id text not null references seasons(id),
  rarity text not null check (rarity in ('COMMON','UNCOMMON','RARE','EPIC','LEGENDARY')),
  accessories jsonb not null,        -- { HEAD: accessoryId, FACE: accessoryId, ... }
  genesis_rank integer,
  blockchain_status text not null default 'OFFCHAIN' check (blockchain_status in ('OFFCHAIN','MINTED')),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- activities — the existing activity feed, given a durable home.
-- ---------------------------------------------------------------------------
create table if not exists activities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete cascade,
  action text not null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Phase 18 — reference-data seed for box_types / accessories, mirroring
-- lib/config/boxes.ts's BOX_CONFIG and data/mock-accessories.ts's
-- ACCESSORY_POOL exactly. buy_box()/open_box_with_result() below read cost
-- and rarity/slot from THESE rows (never a client-supplied value), so a
-- fresh install needs them present for the box loop to work at all.
-- `on conflict do update` makes this safe to re-run if either TS source of
-- truth is ever edited and this block re-applied.
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- Phase 18 — buy_box: the atomic, server-side-only counterpart to what
-- lib/services/box-service.ts's buyBox() used to do against localStorage
-- (see supabase/MIGRATION.md's "known regression" section — that
-- localStorage points balance was already permanently stale/disconnected
-- from the real Supabase one trading awards into; this closes that gap by
-- moving box purchase onto the SAME `user_points` row trading already
-- uses). Cost is read from `box_types` here, never accepted from the
-- caller. `for update` row-locks the buyer's `user_points` row so two
-- concurrent purchase requests can't both read the same "available"
-- balance and both succeed (double-spend).
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- Phase 18 — open_box_with_result: the rarity/accessory ROLL itself still
-- happens in application code (lib/domain/collectibles/box-engine.ts,
-- unchanged — no reason to reimplement tested weighted-RNG logic in
-- PL/pgSQL), but the ROLL IS NEVER TRUSTED ON ITS OWN: this function is
-- what actually COMMITS a result, and it does so with a single
-- compare-and-swap UPDATE (`where ... and opened = false`). Only the
-- request that wins that race gets to write a result and credit
-- inventory; a duplicate/concurrent/replayed request for the same box
-- always finds `opened = false -> false` already lost and simply reads
-- back the SAME result that already won — never re-rolls, never credits
-- inventory twice. This is what "prevent double-open" means concretely.
-- ---------------------------------------------------------------------------
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

-- -----------------------------------------------------------------------------
-- Phase 19 — assemble_bag_nft: Supabase-backed replacement for
-- lib/services/nft-service.ts's assembleBagNFT() (localStorage). Closes the
-- last item on supabase/MIGRATION.md's "still on localStorage" list: NFT
-- assembly's accessory-consumption was intentionally left on
-- lib/services/inventory-service.ts's localStorage `inventory` collection,
-- which nothing has written to since box-opening moved server-side
-- (open_box_with_result() above credits the REAL `inventory` table
-- instead) — assembly could never succeed for any real user before this.
--
-- Same pattern as open_box_with_result(): the RARITY computation still
-- happens in application code (lib/domain/nft/rarity-engine.ts, unchanged),
-- but consuming the 8 accessories and minting the NFT row is one atomic
-- transaction here. Ownership of every slot is checked (with a row lock)
-- BEFORE any accessory is consumed, so a request missing just one slot
-- never partially burns the rest.
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

-- =============================================================================
-- Row Level Security — every table is user-scoped except the read-only
-- reference tables (seasons, box_types, accessories) and the leaderboard,
-- which needs cross-user read access by definition.
-- =============================================================================
alter table portfolios enable row level security;
alter table positions enable row level security;
alter table trades enable row level security;
alter table point_transactions enable row level security;
alter table user_points enable row level security;
alter table boxes enable row level security;
alter table inventory enable row level security;
alter table bag_nfts enable row level security;
alter table activities enable row level security;

-- Example policy shape (adjust auth.uid() mapping to however you link
-- Supabase Auth sessions to `users.id` — e.g. via a wallet-signature login
-- that writes auth.uid() = users.id at signup):
--
-- create policy "own portfolio only" on portfolios
--   for select using (auth.uid() = user_id);
-- create policy "own portfolio writes" on portfolios
--   for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
--
-- user_points needs a *read* policy that allows reading other users' rows
-- for the given active season (to compute/display the leaderboard), while
-- writes stay restricted to server-side service-role calls only — points
-- must never be written directly by a client:
--
-- create policy "read points for leaderboard" on user_points
--   for select using (true);
-- -- (no insert/update policy for the anon/authenticated role: only the
-- -- service role, called from a trusted server function, can write here)
-- =============================================================================
-- Phase 3 — Bag Registry.
--
-- Canonical, persisted identity for a Bag, replacing (for anything that
-- writes going forward) the static objects in `lib/mock-data.ts`. `bags.id`
-- is THE canonical identity referenced everywhere else in the protocol
-- layer (Factory/Registry/Contract address mapping in later phases hangs
-- off this id, not off any derived value like slug or composition hash).
--
-- `bags` and `bag_versions` reference each other (`bags.current_version_id`
-- -> `bag_versions.id`, `bag_versions.bag_id` -> `bags.id`), so the FK from
-- `bags` to `bag_versions` is added via ALTER TABLE after both tables exist
-- — same shape a normal migration tool would produce, just inline here
-- since this project keeps one schema.sql rather than a migrations dir.
--
-- Same conventions as the rest of this file: server-only writes through the
-- service-role client (`lib/supabase/server.ts`), RLS enabled everywhere,
-- ownership enforced primarily in the API route (via the session cookie —
-- see `lib/auth/require-session.ts`) since the service-role key bypasses
-- RLS entirely. The one exception is `bags`' SELECT policy below, which is
-- a REAL policy (not commented out) because, unlike trades/portfolios,
-- published Bag data is meant to be publicly browsable — this is the seam
-- for a future Explore page that reads straight from Supabase with the
-- anon key (`lib/supabase/browser.ts`) instead of an API route.
-- =============================================================================

create table if not exists bags (
  id uuid primary key,
  slug text unique not null,
  name text not null,
  symbol text not null,
  description text not null default '',
  creator_id uuid not null references users(id) on delete cascade,
  chain text not null check (chain in ('ethereum', 'base', 'arbitrum', 'solana', 'robinhood')),
  -- Phase 11 — denormalized from `bag_versions.recipe.strategyType` (see
  -- types/basket-protocol.ts's `BagRecord.strategyType` doc comment) so
  -- Explore/Profile can filter/badge by strategy without joining out to
  -- the current version. `not null default 'STATIC_BASKET'` makes this
  -- migration backward-compatible: every pre-existing row is backfilled
  -- to the only strategy type that has ever existed, with no data loss
  -- and no separate UPDATE step required. Only 'STATIC_BASKET' is valid
  -- today — widen this check (and `STRATEGY_TYPES` in
  -- types/basket-protocol.ts) together when a second strategy type ships.
  strategy_type text not null default 'STATIC_BASKET' check (strategy_type in ('STATIC_BASKET')),
  mutability text not null check (mutability in ('IMMUTABLE', 'MUTABLE')),
  status text not null default 'DRAFT' check (status in ('DRAFT', 'ACTIVE', 'ARCHIVED')),
  current_version integer not null default 0,
  -- FK to bag_versions added below, after that table exists.
  current_version_id uuid,
  -- Nullable on purpose — no protocol registry or on-chain deployment
  -- exists yet. Phase 4+ (Bag Factory / BagToken) is what ever populates
  -- these; Phase 3 is app-database identity only.
  registry_id text,
  contract_address text,
  -- Fork lineage columns, added now (not in a later phase) because they're
  -- cheap, nullable, self-referencing FKs that cost nothing to have sit
  -- empty — adding them later would mean an ALTER TABLE plus backfilling
  -- root_bag_id for every existing row. No fork *logic* is implemented in
  -- this phase; `components/landing/ForkTree` remains a marketing visual,
  -- not backed by these columns yet.
  parent_bag_id uuid references bags(id) on delete set null,
  root_bag_id uuid references bags(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_bags_status_created on bags(status, created_at desc);
create index if not exists idx_bags_creator on bags(creator_id);
create index if not exists idx_bags_parent on bags(parent_bag_id) where parent_bag_id is not null;
create index if not exists idx_bags_strategy_type on bags(strategy_type);

-- Backward-compatible migration for a `bags` table that was already
-- created (via an earlier run of this file) before `strategy_type` existed
-- — `create table if not exists` above is a no-op on that table, so the
-- column has to be added explicitly. `if not exists` makes this safe to
-- re-run on a fresh install too, where the column already came from the
-- `create table` above. `not null default 'STATIC_BASKET'` backfills every
-- existing row in the same statement — no separate UPDATE, no downtime.
alter table bags add column if not exists strategy_type text not null default 'STATIC_BASKET';
alter table bags drop constraint if exists bags_strategy_type_check;
alter table bags add constraint bags_strategy_type_check check (strategy_type in ('STATIC_BASKET'));

-- ---------------------------------------------------------------------------
-- bag_versions — one row per published composition change. `recipe` stores
-- the full `BasketRecipe` (types/basket-protocol.ts) as canonical JSONB.
--
-- Deliberately NO separate `bag_assets` relational table: nothing in this
-- phase needs to query "which bags hold asset X" or join across assets —
-- the only current asset-shaped read is "give me bag Y's current
-- composition", which is a single-row JSONB fetch either way. A relational
-- `bag_assets` table would duplicate `recipe.assets` and require every
-- writer to keep both in sync for no present benefit. If/when Explore adds
-- "bags containing BTC" filtering (spec section 19) or the NAV engine
-- (Phase 6 — Phase 5 is the Asset Registry & Pricing Layer below, not NAV
-- itself) needs to aggregate holdings across many bags, that's the
-- trigger to add a GIN index on `recipe -> 'assets'` first, and only fall
-- back to a real `bag_assets` table if that's not enough — not before.
-- ---------------------------------------------------------------------------
create table if not exists bag_versions (
  id uuid primary key default gen_random_uuid(),
  bag_id uuid not null references bags(id) on delete cascade,
  version integer not null check (version > 0),
  composition_hash text not null,
  recipe jsonb not null,
  created_by uuid not null references users(id),
  reason text not null default '',
  created_at timestamptz not null default now(),
  unique (bag_id, version)
);

create index if not exists idx_bag_versions_bag on bag_versions(bag_id, version desc);

alter table bags
  add constraint bags_current_version_id_fkey
  foreign key (current_version_id) references bag_versions(id) on delete set null;

-- ---------------------------------------------------------------------------
-- Atomic creation. A Bag must never exist without its initial version (spec
-- section 8) — both inserts plus the `bags.current_version_id` backfill run
-- inside one plpgsql function, which Postgres already treats as a single
-- transaction. If `p_slug` collides with an existing bag, the UNIQUE
-- constraint raises inside the function and the whole thing rolls back —
-- no orphaned `bags` row, no orphaned `bag_versions` row. Called from
-- `lib/server/bag-repo.ts`'s `createBag()` via the service-role client;
-- execute is revoked from PUBLIC and granted only to service_role below,
-- so this function can't be invoked directly via the anon/authenticated
-- PostgREST role even if someone learns its name.
-- ---------------------------------------------------------------------------
create or replace function create_bag_with_initial_version(
  p_id uuid,
  p_slug text,
  p_name text,
  p_symbol text,
  p_description text,
  p_creator_id uuid,
  p_chain text,
  p_mutability text,
  p_status text,
  p_recipe jsonb,
  p_composition_hash text,
  p_reason text,
  p_parent_bag_id uuid default null,
  p_root_bag_id uuid default null,
  -- Defaulted (not a required positional param) so this stays
  -- backward-compatible with any caller still built against the
  -- pre-Phase-11 signature — falls back to the same default the rest of
  -- the strategy-type plumbing uses (DEFAULT_STRATEGY_TYPE in
  -- types/basket-protocol.ts).
  p_strategy_type text default 'STATIC_BASKET'
) returns jsonb
language plpgsql
as $$
declare
  v_version_id uuid;
  v_bag jsonb;
  v_version jsonb;
begin
  insert into bags (
    id, slug, name, symbol, description, creator_id, chain, strategy_type,
    mutability, status, parent_bag_id, root_bag_id
  )
  values (
    p_id, p_slug, p_name, p_symbol, p_description, p_creator_id, p_chain,
    p_strategy_type, p_mutability, p_status, p_parent_bag_id, p_root_bag_id
  );

  insert into bag_versions (bag_id, version, composition_hash, recipe, created_by, reason)
  values (p_id, 1, p_composition_hash, p_recipe, p_creator_id, p_reason)
  returning id into v_version_id;

  update bags
  set current_version = 1, current_version_id = v_version_id, updated_at = now()
  where id = p_id
  returning to_jsonb(bags.*) into v_bag;

  select to_jsonb(bag_versions.*) into v_version from bag_versions where id = v_version_id;

  return jsonb_build_object('bag', v_bag, 'version', v_version);
end;
$$;

revoke execute on function create_bag_with_initial_version from public;
grant execute on function create_bag_with_initial_version to service_role;

-- Same atomicity concern for a later composition update on an existing
-- (already-created) Bag — with one more requirement than
-- create_bag_with_initial_version: the NEXT version number must itself be
-- computed inside this transaction, not passed in by the caller. If the
-- caller computed `currentVersion + 1` in application code, two concurrent
-- calls could both read `currentVersion = 1`, both decide "next is 2", and
-- race — the `unique (bag_id, version)` constraint would catch the
-- collision, but only as a confusing 23505 error after the fact, which
-- isn't clean enough for protocol-level versioning. `select ... for update`
-- row-locks the `bags` row for the rest of this function call: a second
-- concurrent call blocks until the first commits, then reads the
-- already-bumped `current_version` and correctly computes the version
-- after that one — no caller-supplied version number, no race.
create or replace function create_bag_version(
  p_bag_id uuid,
  p_composition_hash text,
  p_recipe jsonb,
  p_created_by uuid,
  p_reason text
) returns jsonb
language plpgsql
as $$
declare
  v_next_version integer;
  v_version_id uuid;
  v_recipe jsonb;
  v_bag jsonb;
  v_version jsonb;
begin
  select current_version + 1 into v_next_version
  from bags
  where id = p_bag_id
  for update;

  if v_next_version is null then
    raise exception 'bag % not found', p_bag_id;
  end if;

  -- The `version`/`id` the caller stamped into the recipe before the DB
  -- decided the real version number are placeholders (see
  -- lib/server/bag-repo.ts's createBagVersion()) — overwrite them here so
  -- what's persisted in `recipe` always agrees with the `version` column.
  v_recipe := p_recipe || jsonb_build_object(
    'version', v_next_version,
    'id', 'recipe_' || p_bag_id::text || '_v' || v_next_version::text
  );

  insert into bag_versions (bag_id, version, composition_hash, recipe, created_by, reason)
  values (p_bag_id, v_next_version, p_composition_hash, v_recipe, p_created_by, p_reason)
  returning id into v_version_id;

  update bags
  set current_version = v_next_version, current_version_id = v_version_id, updated_at = now()
  where id = p_bag_id
  returning to_jsonb(bags.*) into v_bag;

  select to_jsonb(bag_versions.*) into v_version from bag_versions where id = v_version_id;

  return jsonb_build_object('bag', v_bag, 'version', v_version);
end;
$$;

revoke execute on function create_bag_version from public;
grant execute on function create_bag_version to service_role;

alter table bags enable row level security;
alter table bag_versions enable row level security;

-- Real (non-commented) policy: published Bags are public data by design —
-- the whole product is a basket *discovery* surface (Explore, per spec
-- section 19). Archived bags intentionally do NOT match this policy, so a
-- future direct-from-browser read via the anon key never surfaces them
-- alongside active ones, matching spec section 10's "archived ≠ visible in
-- public listings" requirement.
create policy "public read active bags" on bags
  for select using (status = 'ACTIVE');

-- No insert/update/delete policy for bags or bag_versions: every write
-- today goes through `lib/server/bag-repo.ts` using the service-role
-- client (bypasses RLS by design, same as trades/portfolios above), with
-- creator ownership checked in the API route against the session cookie
-- before the repo is ever called — never against a client-supplied
-- creator_id. `bag_versions` has no public SELECT policy yet either
-- (default-deny): nothing reads version history directly from the browser
-- yet, so there's nothing to open up prematurely. Add one the same way as
-- `bags` above when that becomes true.

-- =============================================================================
-- Phase 4 — bag_deployments. On-chain deployment identity, per (bag, chain).
--
-- `bags.contract_address` / `bags.registry_id` (Phase 3) were designed as a
-- single nullable pair — fine for "has this bag been deployed at all", not
-- enough once a bag can deploy to more than one chain (spec section 7's
-- "Base deployment / Arbitrum deployment / Solana deployment" example).
-- This table is the actual source of truth for deployment state, one row
-- per (bag_id, chain); `bags.contract_address`/`registry_id` are kept as a
-- denormalized pointer to the *first* successful deployment for cheap
-- reads that don't care about multi-chain (see
-- the confirm_bag_deployment() function below, which sets it in the SAME
-- transaction as the deployment row) — not a second source of truth to keep
-- in sync by hand.
--
-- `unique (bag_id, chain)` is what makes "same bag → cannot deploy twice"
-- (on the same chain) a database guarantee, not just an application check
-- — matching the same "never trust the app layer alone" principle
-- already applied to `bags.slug unique`.
-- =============================================================================
create table if not exists bag_deployments (
  id uuid primary key default gen_random_uuid(),
  bag_id uuid not null references bags(id) on delete cascade,
  chain text not null check (chain in ('ethereum', 'base', 'arbitrum', 'solana', 'robinhood')),
  -- 'DEPLOYING' is LEGACY (the retired backend-signed flow); the user-signed
  -- flow never writes it — prepare writes nothing and confirm hops straight to
  -- DEPLOYED (see confirm_bag_deployment below).
  status text not null default 'NOT_DEPLOYED' check (status in ('NOT_DEPLOYED', 'DEPLOYING', 'DEPLOYED', 'FAILED')),
  factory_address text,
  contract_address text,
  tx_hash text,
  block_number bigint,
  error_message text,
  -- The Bag's REAL on-chain id (lowercase bytes32), read from the confirmed
  -- `BagCreated` event: keccak256(abi.encode(creator, offChainRef)). Execution
  -- reads THIS; it is never re-derived. See 0024_user_signed_bag_deployment.sql.
  on_chain_bag_id text,
  -- BagCreated.creator (lowercase) — the wallet the id is bound to. NULL only
  -- for legacy rows created before creator-bound ids.
  on_chain_creator text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- "one Bag + one chain = one deployment": a database guarantee, not an app check.
  unique (bag_id, chain)
);

create index if not exists idx_bag_deployments_bag on bag_deployments(bag_id);
create index if not exists idx_bag_deployments_status on bag_deployments(status);

-- ---------------------------------------------------------------------------
-- User-signed deployment (migrations 0024-0025). Kept in sync with those
-- files by hand; the integration test (lib/server/__tests__/integration/
-- schema-parity.integration.test.ts) fails if a fresh install of this file and
-- "previous schema + migrations" ever diverge.
-- ---------------------------------------------------------------------------
create unique index if not exists uq_bag_deployments_chain_tx_hash
  on bag_deployments (chain, tx_hash) where tx_hash is not null;
create unique index if not exists uq_bag_deployments_chain_on_chain_bag_id
  on bag_deployments (chain, on_chain_bag_id) where on_chain_bag_id is not null;

alter table bag_deployments drop constraint if exists bag_deployments_on_chain_bag_id_format;
alter table bag_deployments add constraint bag_deployments_on_chain_bag_id_format
  check (on_chain_bag_id is null or on_chain_bag_id ~ '^0x[0-9a-f]{64}$');

alter table bag_deployments drop constraint if exists bag_deployments_on_chain_creator_format;
alter table bag_deployments add constraint bag_deployments_on_chain_creator_format
  check (on_chain_creator is null or on_chain_creator ~ '^0x[0-9a-f]{40}$');

alter table bag_deployments drop constraint if exists bag_deployments_tx_hash_format;
alter table bag_deployments add constraint bag_deployments_tx_hash_format
  check (tx_hash is null or tx_hash ~ '^0x[0-9a-f]{64}$');

alter table bag_deployments drop constraint if exists bag_deployments_deployed_has_on_chain_id;
alter table bag_deployments add constraint bag_deployments_deployed_has_on_chain_id
  check (status <> 'DEPLOYED' or on_chain_bag_id is not null);


create or replace function assert_deployed_bag_not_draft() returns trigger
language plpgsql
as $$
declare
  v_bag_id uuid;
begin
  if tg_table_name = 'bag_deployments' then
    if new.status <> 'DEPLOYED' then return null; end if;
    v_bag_id := new.bag_id;
  else
    v_bag_id := new.id;
  end if;

  if exists (select 1 from bags b where b.id = v_bag_id and b.status = 'DRAFT')
     and exists (select 1 from bag_deployments d where d.bag_id = v_bag_id and d.status = 'DEPLOYED') then
    raise exception 'invariant violated: bag % has a DEPLOYED deployment but is still DRAFT', v_bag_id
      using errcode = 'check_violation';
  end if;
  return null;
end;
$$;

drop trigger if exists trg_bag_deployments_deployed_not_draft on bag_deployments;
create constraint trigger trg_bag_deployments_deployed_not_draft
  after insert or update on bag_deployments
  deferrable initially deferred
  for each row execute function assert_deployed_bag_not_draft();

drop trigger if exists trg_bags_deployed_not_draft on bags;
create constraint trigger trg_bags_deployed_not_draft
  after update of status on bags
  deferrable initially deferred
  for each row execute function assert_deployed_bag_not_draft();


create or replace function confirm_bag_deployment(
  p_bag_id uuid,
  p_creator_id uuid,
  p_bag_version_id uuid,
  p_chain text,
  p_factory_address text,
  p_contract_address text,
  p_tx_hash text,
  p_block_number bigint,
  p_on_chain_bag_id text,
  p_on_chain_creator text
) returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_tx text := lower(p_tx_hash);
  v_factory text := lower(p_factory_address);
  v_contract text := lower(p_contract_address);
  v_onchain text := lower(p_on_chain_bag_id);
  v_creator text := lower(p_on_chain_creator);
  v_bag bags;
  v_dep bag_deployments;
begin
  -- Defence in depth: the table CHECKs enforce these too, but reject early with a clear error.
  if v_tx !~ '^0x[0-9a-f]{64}$' then raise exception 'confirm_bag_deployment: malformed tx_hash' using errcode = 'invalid_parameter_value'; end if;
  if v_onchain !~ '^0x[0-9a-f]{64}$' then raise exception 'confirm_bag_deployment: malformed on_chain_bag_id' using errcode = 'invalid_parameter_value'; end if;
  if v_creator !~ '^0x[0-9a-f]{40}$' then raise exception 'confirm_bag_deployment: malformed on_chain_creator' using errcode = 'invalid_parameter_value'; end if;
  if v_contract !~ '^0x[0-9a-f]{40}$' or v_factory !~ '^0x[0-9a-f]{40}$' then
    raise exception 'confirm_bag_deployment: malformed contract/factory address' using errcode = 'invalid_parameter_value';
  end if;
  if p_block_number is null or p_block_number < 0 then raise exception 'confirm_bag_deployment: invalid block_number' using errcode = 'invalid_parameter_value'; end if;

  select * into v_bag from bags where id = p_bag_id for update;
  if not found then return jsonb_build_object('outcome', 'BAG_NOT_FOUND'); end if;
  if v_bag.creator_id is distinct from p_creator_id then return jsonb_build_object('outcome', 'FORBIDDEN'); end if;

  select * into v_dep from bag_deployments where bag_id = p_bag_id and chain = p_chain;

  if found and v_dep.status = 'DEPLOYED' then
    if v_dep.tx_hash = v_tx and v_dep.on_chain_bag_id = v_onchain then
      -- Same confirmation again (retry / refresh / double click): idempotent success. Also re-applies the Bag
      -- finalization, which is a no-op unless it was somehow left incomplete.
      update bags
         set registry_id = case when contract_address is null then p_chain else registry_id end,
             contract_address = case when contract_address is null then v_dep.contract_address else contract_address end,
             status = case when status = 'DRAFT' then 'ACTIVE' else status end,
             updated_at = now()
       where id = p_bag_id and (contract_address is null or status = 'DRAFT');
      select * into v_bag from bags where id = p_bag_id;
      return jsonb_build_object('outcome', 'ALREADY_CONFIRMED', 'deployment', to_jsonb(v_dep),
        'bag', jsonb_build_object('status', v_bag.status, 'contract_address', v_bag.contract_address, 'registry_id', v_bag.registry_id));
    end if;
    -- A DIFFERENT deployment already owns this (bag, chain): refuse, never overwrite.
    return jsonb_build_object('outcome', 'CONFLICT', 'deployment', to_jsonb(v_dep));
  end if;

  -- About to write: the verified composition must still be the Bag's current one.
  if v_bag.current_version_id is distinct from p_bag_version_id then
    return jsonb_build_object('outcome', 'STALE_VERSION');
  end if;

  begin
    if found then
      -- Legacy NOT_DEPLOYED / FAILED / DEPLOYING row -> DEPLOYED.
      update bag_deployments
         set status = 'DEPLOYED', factory_address = v_factory, contract_address = v_contract,
             tx_hash = v_tx, block_number = p_block_number,
             on_chain_bag_id = v_onchain, on_chain_creator = v_creator,
             error_message = null, updated_at = now()
       where id = v_dep.id
      returning * into v_dep;
    else
      insert into bag_deployments (bag_id, chain, status, factory_address, contract_address, tx_hash, block_number, on_chain_bag_id, on_chain_creator)
      values (p_bag_id, p_chain, 'DEPLOYED', v_factory, v_contract, v_tx, p_block_number, v_onchain, v_creator)
      returning * into v_dep;
    end if;
  exception when unique_violation then
    -- Another Bag/chain already holds this tx hash or on-chain id (the (bag_id, chain) case cannot reach here:
    -- the bag-row lock above serialises it). Nothing was written.
    return jsonb_build_object('outcome', 'IDENTITY_TAKEN');
  end;

  update bags
     set registry_id = case when contract_address is null then p_chain else registry_id end,
         contract_address = case when contract_address is null then v_contract else contract_address end,
         status = case when status = 'DRAFT' then 'ACTIVE' else status end,
         updated_at = now()
   where id = p_bag_id;
  select * into v_bag from bags where id = p_bag_id;

  return jsonb_build_object('outcome', 'CONFIRMED', 'deployment', to_jsonb(v_dep),
    'bag', jsonb_build_object('status', v_bag.status, 'contract_address', v_bag.contract_address, 'registry_id', v_bag.registry_id));
end;
$$;

do $$
declare
  v_sig constant text := 'confirm_bag_deployment(uuid, uuid, uuid, text, text, text, text, bigint, text, text)';
begin
  execute format('revoke execute on function %s from public', v_sig);
  if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke execute on function %s from anon', v_sig); end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke execute on function %s from authenticated', v_sig); end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', v_sig); end if;
end $$;

-- RLS enabled, deliberately with NO policies defined: default-deny for
-- every role except service_role (which bypasses RLS). This table is
-- only ever read/written by this app's own API routes via the
-- service-role client (see lib/server/bag-deployment-repo.ts) — there is
-- no legitimate client-side/browser access pattern for it, unlike
-- creator_reward_settlements above (which at least has a dashboard read
-- use case, even if that policy is currently inert for the same
-- auth.uid()-is-always-NULL reason documented there). Default-deny here
-- is the correct end state already, not a placeholder waiting for a
-- policy to be added.
alter table bag_deployments enable row level security;

-- No public SELECT policy: deployment bookkeeping (tx hashes, block
-- numbers, in-flight DEPLOYING/FAILED state) is operational data, not
-- Explore-page content — `bags.contract_address` (Phase 3, public via the
-- `bags` policy above) is what a public UI should read to link out to an
-- explorer, not this table directly. No insert/update policy either, same
-- reasoning as `bags`/`bag_versions`: every write goes through
-- `lib/server/bag-deployment-repo.ts` via the service-role client, called
-- only from `lib/server/deploy-bag.ts` after the ownership check in
-- app/api/bags/[id]/deploy/route.ts.

-- =============================================================================
-- Phase 5 — assets. Canonical Asset Identity + verification state — the
-- foundation the NAV Engine (Phase 6) builds `PriceProvider`/`AssetPrice`
-- on top of. See `lib/domain/basket-protocol/asset-identity.ts` for why
-- identity is `chain + address`, never `symbol`.
--
-- `unique(chain, address)` is the database guarantee behind "same asset →
-- cannot register twice" — same pattern as `bags.slug unique` /
-- `bag_deployments unique(bag_id, chain)` above. `address` is stored
-- pre-normalized (`lib/server/asset-repo.ts` always lowercases EVM
-- addresses before insert/query) so the uniqueness constraint can't be
-- bypassed by casing alone — Postgres `text` equality is case-sensitive,
-- so `0xAbC...` and `0xabc...` would otherwise be seen as two different
-- rows despite being the same address.
-- =============================================================================
create table if not exists assets (
  id uuid primary key default gen_random_uuid(),
  chain text not null check (chain in ('ethereum', 'base', 'arbitrum', 'solana', 'robinhood')),
  address text not null,
  symbol text not null,
  decimals integer not null check (decimals >= 0 and decimals <= 18),
  name text not null,
  status text not null default 'VERIFIED' check (status in ('UNKNOWN', 'VERIFIED', 'DEPRECATED')),
  -- 'stock' (Robinhood Stock Tokens, robinhood-import.ts) or 'crypto'
  -- (coingecko-import.ts) — see 0020_add_asset_type.sql for why this exists
  -- as its own column rather than inferred from chain.
  asset_type text not null default 'stock' check (asset_type in ('crypto', 'stock')),
  -- Corporate-action multiplier as of last import/update (decimal string,
  -- e.g. Robinhood Stock Tokens' ERC-8056 `uiMultiplier()` — see
  -- lib/domain/basket-protocol/registry/robinhood-import.ts). Nullable:
  -- only chain='robinhood' assets populate this today.
  current_multiplier text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (chain, address)
);

create index if not exists idx_assets_status on assets(status);
create index if not exists idx_assets_chain_address on assets(chain, address);
create index if not exists idx_assets_type on assets(asset_type);

alter table assets enable row level security;

-- Verified assets are meant to be publicly readable — a creator's asset
-- picker or an Explore filter needs to check "is this a real asset"
-- without a round trip through a server route for every keystroke, same
-- reasoning as the `bags` public-read policy above. UNKNOWN/DEPRECATED
-- rows stay hidden from this same public read on purpose: an unverified or
-- deprecated row is operational registry state, not something a public
-- asset picker should ever surface as a real option.
create policy "public read verified assets" on assets
  for select using (status = 'VERIFIED');

-- No insert/update/delete policy: every write goes through
-- `lib/server/asset-repo.ts` using the service-role client, reachable only
-- from an admin/service-role code path (spec section 14) — no
-- creator-facing route reaches this table's writes yet.

-- =============================================================================
-- Phase 7 — bag_holdings. What a Bag ACTUALLY holds, right now — never to
-- be confused with `bag_versions.recipe.assets[].weightBps` (target
-- allocation). See lib/domain/basket-protocol/nav/nav.ts's module doc for
-- why NAV is computed from this table, never from recipe weights.
--
-- Deliberately NOT `positions`/`portfolio`/`trades` (this schema's original
-- paper-trading tables, above) — those represent a USER's simulated
-- personal positions; this represents what a BAG ITSELF holds. A different
-- domain entirely, and those tables are untouched by this phase.
--
-- `unique(bag_id, chain, address)` is the "no duplicate holding row for the
-- same asset in the same bag" guarantee (spec section 4) — same
-- pre-normalized-address convention as `assets` above
-- (`lib/server/bag-holdings-repo.ts` always lowercases EVM addresses
-- before insert/query, same helper `lib/server/asset-repo.ts` already uses).
-- =============================================================================
create table if not exists bag_holdings (
  id uuid primary key default gen_random_uuid(),
  bag_id uuid not null references bags(id) on delete cascade,
  chain text not null check (chain in ('ethereum', 'base', 'arbitrum', 'solana', 'robinhood')),
  address text not null,
  quantity_raw text not null,
  decimals integer not null check (decimals >= 0 and decimals <= 18),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (bag_id, chain, address)
);

create index if not exists idx_bag_holdings_bag on bag_holdings(bag_id);

alter table bag_holdings enable row level security;

-- Public read for ACTIVE bags only — same shape as the `bag_versions`
-- policy above (EXISTS join back to `bags.status`), and the same reasoning:
-- a Bag detail page computing/displaying NAV for a published Bag needs to
-- read its holdings; a DRAFT/ARCHIVED bag's holdings are not public
-- content.
create policy "public read of holdings for active bags" on bag_holdings
  for select using (
    exists (
      select 1 from bags
      where bags.id = bag_holdings.bag_id
      and bags.status = 'ACTIVE'
    )
  );

-- No insert/update/delete policy: every write goes through
-- `lib/server/bag-holdings-repo.ts` via the service-role client, called
-- only from `lib/server/bag-holdings.ts` after the ownership check (same
-- security boundary as `bags`/`bag_versions`/`bag_deployments` above).

-- ---------------------------------------------------------------------------
-- replace_bag_holdings — atomic "delete every existing holding row for this
-- bag, insert the new set" so a multi-asset holdings update can never leave
-- a bag half-updated (spec section 6: "BTC update başarılı, ETH/USDC
-- başarısız" must never happen — a Postgres function runs inside the
-- calling transaction, same atomicity guarantee as
-- `create_bag_with_initial_version`/`create_bag_version` above). Returns
-- the resulting row set so the caller doesn't need a second round trip.
--
-- `p_holdings` is a jsonb array of `{chain, address, quantity_raw,
-- decimals}` — addresses are expected PRE-NORMALIZED by the caller
-- (`lib/server/bag-holdings-repo.ts`), same division of responsibility
-- `create_bag_with_initial_version` already has with its caller's
-- already-validated recipe: this function enforces what the schema itself
-- can (chain/decimals check constraints, the unique constraint), not
-- normalization rules that live in TypeScript.
-- ---------------------------------------------------------------------------
create or replace function replace_bag_holdings(
  p_bag_id uuid,
  p_holdings jsonb
) returns jsonb
language plpgsql
as $$
declare
  v_result jsonb;
begin
  delete from bag_holdings where bag_id = p_bag_id;

  insert into bag_holdings (bag_id, chain, address, quantity_raw, decimals)
  select
    p_bag_id,
    (h->>'chain')::text,
    (h->>'address')::text,
    (h->>'quantity_raw')::text,
    (h->>'decimals')::integer
  from jsonb_array_elements(p_holdings) as h;

  select coalesce(jsonb_agg(to_jsonb(bh.*)), '[]'::jsonb) into v_result
  from bag_holdings bh
  where bh.bag_id = p_bag_id;

  return v_result;
end;
$$;

revoke execute on function replace_bag_holdings from public;
grant execute on function replace_bag_holdings to service_role;

-- =============================================================================
-- Phase 13 — bag_share_state. Persistent counterpart to
-- `lib/domain/basket-protocol/shares/shares.ts` (Phase 9)'s `ShareSupply`
-- type — same relationship `bag_holdings` above has to the pure NAV Engine
-- (Phase 6): the domain math (`calculateNavPerShare()`, `getDepositQuote()`,
-- `getRedeemQuote()`) stays pure and knows nothing about Postgres; this
-- table is the one place a Bag's outstanding share count actually lives.
--
-- ONE ROW PER BAG, `bag_id` itself as the primary key — same shape as
-- `portfolios` above (`user_id uuid primary key`), not a separate `id`
-- column, because there is exactly one share-state row per bag by
-- definition, never a history of them (a mint/redeem updates this row in
-- place; it does not append a new one — `trades`/`bag_versions` are where
-- an append-only history belongs, this is current state only).
--
-- ABSENCE OF A ROW IS THE BOOTSTRAP STATE, NOT AN ERROR: every Bag starts
-- with zero shares outstanding and no row here at all — `lib/server/
-- bag-share-state-repo.ts`'s `getShareSupply()` returns a zero-supply
-- `ShareSupply` (never throws, never fabricates a nonzero value) when no
-- row exists, exactly the state `getDepositQuote()`'s bootstrap branch
-- (Phase 9, spec section 8/9) is designed to price against. No row is
-- ever inserted here by this phase — no mint transaction exists yet
-- (Phase 17) — this table and its repo exist so the day mint does exist,
-- it has a real row to write into, and every reader between now and then
-- (this phase's Purchase Preview included) reads the real, current state
-- instead of a value hardcoded into application code.
-- =============================================================================
create table if not exists bag_share_state (
  bag_id uuid primary key references bags(id) on delete cascade,
  total_shares_raw text not null default '0',
  share_decimals integer not null default 18 check (share_decimals >= 0 and share_decimals <= 18),
  updated_at timestamptz not null default now()
);

alter table bag_share_state enable row level security;

-- Public read for ACTIVE bags only — same shape and reasoning as the
-- `bag_holdings` policy above: a Bag detail page or Purchase Preview for a
-- published Bag needs to read its current share supply; a DRAFT/ARCHIVED
-- bag's share state is not public content.
create policy "public read of share state for active bags" on bag_share_state
  for select using (
    exists (
      select 1 from bags
      where bags.id = bag_share_state.bag_id
      and bags.status = 'ACTIVE'
    )
  );

-- No insert/update/delete policy: every future write goes through
-- `lib/server/bag-share-state-repo.ts`'s `setShareSupply()` via the
-- service-role client — same security boundary as `bag_holdings`.
-- Phase 17's mint (see below) is the first caller of that write path.

-- =============================================================================
-- Phase 20 — bag_investor_positions: `bag_share_state`'s per-depositor
-- breakdown. See supabase/migrations/0011_add_bag_investor_positions.sql
-- for the full rationale (fork royalty + performance fee + per-user P&L
-- all need "whose deposit is this", which nothing before this phase
-- tracked). One row per (user_id, bag_id); updated additively, in the same
-- transaction as `bag_share_state`, by `apply_purchase_execution()` below.
-- =============================================================================
create table if not exists bag_investor_positions (
  user_id uuid not null references users(id) on delete cascade,
  bag_id uuid not null references bags(id) on delete cascade,
  shares_raw text not null default '0',
  share_decimals integer not null default 18 check (share_decimals >= 0 and share_decimals <= 18),
  cost_basis_quote text not null default '0',
  updated_at timestamptz not null default now(),
  primary key (user_id, bag_id)
);

create index if not exists idx_bag_investor_positions_bag on bag_investor_positions(bag_id);

-- No RLS policies — same boundary as `purchase_intents`/`trades`: every
-- read and write goes through a route handler that calls requireSession()
-- first, using the service-role client. Deliberately NOT given
-- `bag_share_state`'s public-read policy — a user's own cost basis is
-- private financial data, read only via an authenticated route.

-- =============================================================================
-- Phase 21 — bag_investor_holdings: per-user, per-asset quantities. This
-- protocol has NO pooled custody (lib/blockchain/lifi-purchase-quote.ts:
-- every swap's `toAddress` is the depositor's OWN wallet) — `bag_holdings`
-- is only ever an aggregate SUM across every depositor's own, separately
-- -held tokens. A redemption can only honestly sell what a SPECIFIC
-- depositor's OWN past deposits actually put in THEIR OWN wallet — this
-- table is that. Credited additively, in the SAME transaction as
-- `bag_holdings`, by `apply_purchase_execution()` below. See
-- supabase/migrations/0012_add_redeem_execution.sql for the full rationale
-- and the redeem-side RPCs that consume this table.
-- =============================================================================
create table if not exists bag_investor_holdings (
  user_id uuid not null references users(id) on delete cascade,
  bag_id uuid not null references bags(id) on delete cascade,
  chain text not null check (chain in ('ethereum', 'base', 'arbitrum', 'solana', 'robinhood')),
  address text not null,
  quantity_raw text not null default '0',
  decimals integer not null check (decimals >= 0 and decimals <= 18),
  updated_at timestamptz not null default now(),
  primary key (user_id, bag_id, chain, address)
);

create index if not exists idx_bag_investor_holdings_bag on bag_investor_holdings(bag_id);
create index if not exists idx_bag_investor_holdings_user_bag on bag_investor_holdings(user_id, bag_id);

-- No RLS — same boundary as bag_investor_positions above.

-- =============================================================================
-- Phase 21 — redeem_intents: exit-side counterpart to purchase_intents. See
-- supabase/migrations/0012_add_redeem_execution.sql for why this has no
-- input_asset/recipe_version/composition_hash/nav_* columns.
-- =============================================================================
create table if not exists redeem_intents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  wallet_address text not null,
  bag_id uuid not null references bags(id) on delete cascade,
  shares_raw text not null,
  share_decimals integer not null,
  output_asset_chain text not null,
  output_asset_address text not null,
  output_decimals integer not null,
  route_fingerprint text not null,
  share_price_at_quote text not null,
  redeem_value_quote text not null,
  steps jsonb not null default '[]'::jsonb,
  status text not null default 'DRAFT',
  failure_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null,
  executed_at timestamptz,
  accounting_applied_at timestamptz,
  reconciliation_applied_at timestamptz
);

create index if not exists idx_redeem_intents_user_bag_status on redeem_intents(user_id, bag_id, status);

-- No RLS — same boundary as purchase_intents.

-- =============================================================================
-- Phase 17 — purchase_intents + apply_purchase_execution().
-- See supabase/migrations/0004_add_purchase_intents.sql for the full module
-- doc — reproduced verbatim below so a fresh install reaches the same schema
-- an existing install reaches by running that migration.
-- =============================================================================
-- 0004_add_purchase_intents.sql
--
-- Phase 17 — Real Wallet + LI.FI Execution.
--
-- `purchase_intents` is the server-side canonical record between a quoted
-- `ExecutionPlan` (Phase 10/14, quote-only) and a real, user-signed
-- on-chain execution (types/purchase-intent.ts's `PurchaseIntent`). Same
-- conventions as every other table in this project (see schema.sql):
-- server-only writes through the service-role client, ownership enforced
-- in the API route via the session cookie (lib/auth/require-session.ts),
-- never via RLS (the service-role key bypasses it entirely, same
-- documented boundary `trades`/`portfolios` already have).
--
-- `steps` is a jsonb array of `PurchaseIntentStepRecord` — same "structured
-- data as jsonb" convention `bag_versions.recipe` already uses. Each
-- element's `lifiStep` sub-field is an opaque LI.FI route payload (public
-- route/calldata data, never a credential) that the CLIENT replays back to
-- LI.FI's own SDK to actually execute — this column is never interpreted
-- for business logic beyond what's read back into
-- `PurchaseIntentStepRecord`'s typed fields.
--
-- No private key, seed phrase, or wallet signature is ever a column on
-- this table.

create table if not exists purchase_intents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  -- Denormalized copy of the session's wallet address at intent-creation
  -- time — never trusted from the client on any subsequent request; every
  -- route re-reads `users.wallet_address` (via the session) and compares.
  wallet_address text not null,
  bag_id uuid not null references bags(id) on delete cascade,

  input_asset_chain text not null check (input_asset_chain in ('ethereum', 'base', 'arbitrum', 'solana', 'robinhood')),
  input_asset_address text not null,
  input_amount_raw text not null,
  -- Locked in at quote time from the same DepositQuote the Purchase
  -- Preview already showed the user — minted verbatim on completion, never
  -- recomputed against NAV at execution time.
  shares_raw text not null,
  share_decimals integer not null default 18,

  route_fingerprint text not null,
  -- Phase 18 — locked at quote time, re-verified at execute time
  -- (lib/server/purchase-execution.ts's prepareExecution()) instead of the
  -- weaker "output asset set" comparison Phase 17 shipped with. See
  -- types/purchase-intent.ts's PurchaseIntent doc comments for what each
  -- field is for.
  recipe_version integer not null,
  composition_hash text not null,
  nav_gross text not null,
  nav_quote_currency text not null,
  nav_as_of timestamptz not null,
  -- Null for a bootstrap (zero-share-supply) deposit, where no share price
  -- yet exists.
  share_price_at_quote text,
  steps jsonb not null,
  -- Phase 22 — non-null iff every SWAP step above was executed as ONE
  -- shared LI.FI Composer transaction rather than N independent LI.FI
  -- routes. See supabase/migrations/0021_add_composer_transaction.sql and
  -- lib/blockchain/lifi-composer-adapter.ts.
  composer_transaction jsonb,

  status text not null check (status in (
    'DRAFT', 'QUOTED', 'READY', 'AWAITING_SIGNATURE', 'SUBMITTED',
    'CONFIRMING', 'COMPLETED', 'PARTIAL_SUCCESS', 'RECONCILIATION_REQUIRED',
    'FAILED', 'EXPIRED', 'CANCELLED'
  )),
  failure_code text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null,
  executed_at timestamptz,
  -- Non-null once bag_holdings/bag_share_state accounting has been applied
  -- for this intent — the idempotency guard for spec Aşama 11. Checked
  -- BEFORE calling apply_purchase_execution() below, never after. Only
  -- ever set for a fully-COMPLETED intent.
  accounting_applied_at timestamptz,
  -- Phase 18 — separate guard for a PARTIAL_SUCCESS intent's holdings-only
  -- credit (apply_partial_purchase_execution() below). Deliberately a
  -- DIFFERENT column from accounting_applied_at, never the same one: a
  -- partial credit never mints shares, so conflating the two guards would
  -- make it impossible to tell from this row alone whether a completed
  -- intent's shares were ever actually minted.
  reconciliation_applied_at timestamptz,
  -- Phase 20 — the human decimal quote-currency amount this deposit was
  -- quoted at (`DepositQuote.depositAmount`, locked at intent-creation
  -- time). Threaded into `apply_purchase_execution()` as this depositor's
  -- cost-basis delta — see `bag_investor_positions.cost_basis_quote`'s doc
  -- comment (0011_add_bag_investor_positions.sql) for why this, and not
  -- `share_price_at_quote * shares_raw`, is the value used.
  deposit_amount text not null default '0'
);

create index if not exists idx_purchase_intents_user on purchase_intents(user_id, created_at desc);
create index if not exists idx_purchase_intents_bag on purchase_intents(bag_id);

-- No RLS policies — same boundary as `trades` (schema.sql): every read and
-- write goes through a route handler that calls `requireSession()` first
-- and always filters by `auth.session.userId`, using the service-role
-- client. There is no anon/authenticated-role access path to this table at
-- all, so RLS would be redundant defense that's easy to mistakenly rely on
-- instead of the route-level check that's actually authoritative here.

-- ---------------------------------------------------------------------------
-- apply_purchase_execution — atomically applies ONE verified PurchaseIntent's
-- effect on a Bag's holdings and share supply (spec Aşama 11: "1. purchase
-- accounting 2. allocation accounting 3. BAG share update 4. transaction
-- record 5. audit event ... idempotent şekilde uygulanmalı"). Runs as a
-- single Postgres function call — same atomicity guarantee
-- `replace_bag_holdings`/`create_bag_with_initial_version` already rely on
-- — so a Bag can never end up with holdings updated but shares not minted
-- (or vice versa).
--
-- IDEMPOTENCY: `accounting_applied_at` is checked and set INSIDE this same
-- function, under a row lock (`for update`) on the `purchase_intents` row,
-- so two concurrent calls for the same intent can't both pass the check
-- before either commits — the second caller always observes the first
-- caller's write and returns `alreadyApplied: true` without writing again.
-- `total_shares_raw`/`quantity_raw` are additive deltas, not absolute
-- values, so applying this twice would double-mint if the guard were ever
-- bypassed — it must stay the only entry point for this accounting.
--
-- Phase 20 — also upserts the per-user `bag_investor_positions` row in the
-- SAME transaction, keyed additively off the same `p_shares_delta_raw`,
-- plus a new `p_cost_basis_delta` (quote-currency units — see
-- `bag_investor_positions.cost_basis_quote`'s doc comment). A Bag's
-- `bag_share_state.total_shares_raw` and the sum of its
-- `bag_investor_positions.shares_raw` rows can therefore never disagree —
-- both are written here, or neither is.
-- ---------------------------------------------------------------------------
-- Phase 23 (0016) — also returns `royaltyActivityId`/`royaltyAmount` so
-- lib/server/purchase-execution.ts can insert a matching
-- creator_reward_settlements row itself, immediately, rather than relying
-- on a later timestamp-correlation backfill the way 0015 had to for
-- legacy rows. See supabase/migrations/0016_return_royalty_activity_id.sql.
create or replace function apply_purchase_execution(
  p_intent_id uuid,
  p_bag_id uuid,
  p_holdings jsonb,
  p_shares_delta_raw text,
  p_share_decimals integer,
  p_user_id uuid,
  p_cost_basis_delta text default '0',
  p_fork_royalty_bps integer default 0,
  p_root_creator_id uuid default null
) returns jsonb
language plpgsql
as $$
declare
  v_already_applied timestamptz;
  v_result jsonb;
  v_royalty_amount numeric;
  v_royalty_activity_id uuid;
  v_root_creator_wallet text;
begin
  select accounting_applied_at into v_already_applied
  from purchase_intents
  where id = p_intent_id
  for update;

  if v_already_applied is not null then
    select jsonb_build_object(
      'alreadyApplied', true,
      'holdings', coalesce((select jsonb_agg(to_jsonb(bh.*)) from bag_holdings bh where bh.bag_id = p_bag_id), '[]'::jsonb),
      'shareState', (select to_jsonb(s.*) from bag_share_state s where s.bag_id = p_bag_id),
      'investorPosition', (select to_jsonb(p.*) from bag_investor_positions p where p.bag_id = p_bag_id and p.user_id = p_user_id),
      'royaltyActivityId', null,
      'royaltyAmount', null
    ) into v_result;
    return v_result;
  end if;

  insert into bag_holdings (bag_id, chain, address, quantity_raw, decimals)
  select
    p_bag_id,
    (h->>'chain')::text,
    (h->>'address')::text,
    (h->>'delta_raw')::text,
    (h->>'decimals')::integer
  from jsonb_array_elements(p_holdings) as h
  on conflict (bag_id, chain, address) do update
    set quantity_raw = (bag_holdings.quantity_raw::numeric + excluded.quantity_raw::numeric)::text,
        updated_at = now();

  insert into bag_investor_holdings (user_id, bag_id, chain, address, quantity_raw, decimals)
  select
    p_user_id,
    p_bag_id,
    (h->>'chain')::text,
    (h->>'address')::text,
    (h->>'delta_raw')::text,
    (h->>'decimals')::integer
  from jsonb_array_elements(p_holdings) as h
  on conflict (user_id, bag_id, chain, address) do update
    set quantity_raw = (bag_investor_holdings.quantity_raw::numeric + excluded.quantity_raw::numeric)::text,
        updated_at = now();

  insert into bag_share_state (bag_id, total_shares_raw, share_decimals)
  values (p_bag_id, p_shares_delta_raw, p_share_decimals)
  on conflict (bag_id) do update
    set total_shares_raw = (bag_share_state.total_shares_raw::numeric + excluded.total_shares_raw::numeric)::text,
        updated_at = now();

  insert into bag_investor_positions (user_id, bag_id, shares_raw, share_decimals, cost_basis_quote)
  values (p_user_id, p_bag_id, p_shares_delta_raw, p_share_decimals, p_cost_basis_delta)
  on conflict (user_id, bag_id) do update
    set shares_raw = (bag_investor_positions.shares_raw::numeric + excluded.shares_raw::numeric)::text,
        cost_basis_quote = (bag_investor_positions.cost_basis_quote::numeric + excluded.cost_basis_quote::numeric)::text,
        updated_at = now();

  if p_root_creator_id is not null and p_root_creator_id <> p_user_id and p_fork_royalty_bps > 0 and p_cost_basis_delta::numeric > 0 then
    v_royalty_amount := round(p_cost_basis_delta::numeric * p_fork_royalty_bps / 10000.0, 2);
    if v_royalty_amount > 0 then
      -- P0 FIX (0018): no `portfolios.cash_balance` mutation here anymore
      -- — see this migration's module doc. The activities row + the
      -- creator_reward_settlements insert below are the ONLY records of
      -- this royalty; CreatorRewardsVault.balanceOf is the only place
      -- it's ever spendable.
      insert into activities (user_id, action)
      values (p_root_creator_id, 'FORK_ROYALTY_EARNED:' || v_royalty_amount::text || ':' || p_bag_id::text)
      returning id into v_royalty_activity_id;

      select wallet_address into v_root_creator_wallet from users where id = p_root_creator_id;
      if v_root_creator_wallet is null then
        raise exception 'FORK_ROYALTY_SETTLEMENT_NO_WALLET: root creator % has no wallet_address on file — cannot record a settleable royalty', p_root_creator_id;
      end if;

      insert into creator_reward_settlements (
        creator_id, creator_wallet, bag_id, reward_type,
        source_activity_id, gross_amount_quote, reward_amount_token_raw,
        reward_token_address, reward_token_decimals, reward_chain_id,
        status
      ) values (
        p_root_creator_id, v_root_creator_wallet, p_bag_id, 'FORK_ROYALTY',
        v_royalty_activity_id, v_royalty_amount::text,
        floor(v_royalty_amount * 1000000)::text,
        '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', 6, 4663,
        'EARNED'
      );
    end if;
  end if;

  update purchase_intents
  set accounting_applied_at = now()
  where id = p_intent_id;

  insert into activities (user_id, action)
  values (p_user_id, 'PURCHASE_EXECUTED:' || p_intent_id::text || ':' || p_bag_id::text);

  select jsonb_build_object(
    'alreadyApplied', false,
    'holdings', coalesce((select jsonb_agg(to_jsonb(bh.*)) from bag_holdings bh where bh.bag_id = p_bag_id), '[]'::jsonb),
    'shareState', (select to_jsonb(s.*) from bag_share_state s where s.bag_id = p_bag_id),
    'investorPosition', (select to_jsonb(p.*) from bag_investor_positions p where p.bag_id = p_bag_id and p.user_id = p_user_id),
    'royaltyActivityId', v_royalty_activity_id,
    'royaltyAmount', v_royalty_amount
  ) into v_result;

  return v_result;
end;
$$;

revoke execute on function apply_purchase_execution from public;
grant execute on function apply_purchase_execution to service_role;

-- ---------------------------------------------------------------------------
-- Phase 18 — apply_partial_purchase_execution: the PARTIAL_SUCCESS /
-- RECONCILIATION_REQUIRED counterpart to apply_purchase_execution() above.
-- Credits bag_holdings for ONLY the SWAP/KEEP steps the caller has already
-- verified COMPLETED on-chain (lib/server/purchase-execution.ts's
-- reconcilePartialExecution()) — deliberately NEVER touches
-- bag_share_state. Minting the full quoted `shares_raw` against a deposit
-- that was only partially fulfilled would overstate this depositor's claim
-- on the Bag relative to what it actually contributed; computing a correct
-- PARTIAL share amount is a real pricing decision this phase does not
-- invent (see RECONCILIATION_REQUIRED's doc comment,
-- types/purchase-intent.ts). This function's ONLY job is to make sure
-- verified, real on-chain receipts are never simply lost from the books.
--
-- IDEMPOTENCY: same row-lock pattern as apply_purchase_execution() —
-- `reconciliation_applied_at` is checked and set INSIDE this function
-- under `for update`, so two concurrent/retried calls for the same intent
-- can't both credit holdings.
-- ---------------------------------------------------------------------------
create or replace function apply_partial_purchase_execution(
  p_intent_id uuid,
  p_bag_id uuid,
  p_holdings jsonb,        -- [{chain, address, decimals, delta_raw}]
  p_user_id uuid
) returns jsonb
language plpgsql
as $$
declare
  v_already_applied timestamptz;
  v_result jsonb;
begin
  select reconciliation_applied_at into v_already_applied
  from purchase_intents
  where id = p_intent_id
  for update;

  if v_already_applied is not null then
    select jsonb_build_object(
      'alreadyApplied', true,
      'holdings', coalesce((select jsonb_agg(to_jsonb(bh.*)) from bag_holdings bh where bh.bag_id = p_bag_id), '[]'::jsonb)
    ) into v_result;
    return v_result;
  end if;

  insert into bag_holdings (bag_id, chain, address, quantity_raw, decimals)
  select
    p_bag_id,
    (h->>'chain')::text,
    (h->>'address')::text,
    (h->>'delta_raw')::text,
    (h->>'decimals')::integer
  from jsonb_array_elements(p_holdings) as h
  on conflict (bag_id, chain, address) do update
    set quantity_raw = (bag_holdings.quantity_raw::numeric + excluded.quantity_raw::numeric)::text,
        updated_at = now();

  -- Deliberately NO write to bag_share_state here — see module doc above.

  update purchase_intents
  set reconciliation_applied_at = now()
  where id = p_intent_id;

  insert into activities (user_id, action)
  values (p_user_id, 'PURCHASE_PARTIALLY_RECONCILED:' || p_intent_id::text || ':' || p_bag_id::text);

  select jsonb_build_object(
    'alreadyApplied', false,
    'holdings', coalesce((select jsonb_agg(to_jsonb(bh.*)) from bag_holdings bh where bh.bag_id = p_bag_id), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

revoke execute on function apply_partial_purchase_execution from public;
grant execute on function apply_partial_purchase_execution to service_role;

-- ---------------------------------------------------------------------------
-- Phase 21 — apply_redeem_execution: the burn-side counterpart to
-- apply_purchase_execution(). See supabase/migrations/
-- 0012_add_redeem_execution.sql for the full doc comment (row-lock +
-- re-validation ordering, why cost_basis_quote is reduced proportionally
-- rather than by subtracting the redeemed value).
-- ---------------------------------------------------------------------------
create or replace function apply_redeem_execution(
  p_intent_id uuid,
  p_bag_id uuid,
  p_holdings_sold jsonb,
  p_shares_burn_raw text,
  p_share_decimals integer,
  p_user_id uuid,
  p_redeem_value_quote text default '0',
  p_performance_fee_bps integer default 0,
  p_creator_id uuid default null
) returns jsonb
language plpgsql
as $$
declare
  v_already_applied timestamptz;
  v_position bag_investor_positions%rowtype;
  v_new_shares numeric;
  v_new_cost_basis numeric;
  v_consumed_cost_basis numeric;
  v_profit numeric;
  v_fee_amount numeric;
  v_fee_bps integer;
  v_fee_activity_id uuid;
  v_creator_wallet text;
  v_result jsonb;
  h jsonb;
  v_chain text;
  v_address text;
  v_qty numeric;
  v_row_count integer;
begin
  select accounting_applied_at into v_already_applied
  from redeem_intents
  where id = p_intent_id
  for update;

  if v_already_applied is not null then
    select jsonb_build_object(
      'alreadyApplied', true,
      'holdings', coalesce((select jsonb_agg(to_jsonb(bh.*)) from bag_holdings bh where bh.bag_id = p_bag_id), '[]'::jsonb),
      'shareState', (select to_jsonb(s.*) from bag_share_state s where s.bag_id = p_bag_id),
      'investorPosition', (select to_jsonb(p.*) from bag_investor_positions p where p.bag_id = p_bag_id and p.user_id = p_user_id),
      'feeActivityId', null,
      'feeAmount', null
    ) into v_result;
    return v_result;
  end if;

  select * into v_position
  from bag_investor_positions
  where user_id = p_user_id and bag_id = p_bag_id
  for update;

  if not found or v_position.shares_raw::numeric < p_shares_burn_raw::numeric then
    raise exception 'INSUFFICIENT_SHARES: user % bag % has % raw shares, tried to burn %',
      p_user_id, p_bag_id, coalesce(v_position.shares_raw, '0'), p_shares_burn_raw;
  end if;

  v_new_shares := v_position.shares_raw::numeric - p_shares_burn_raw::numeric;
  v_new_cost_basis := case
    when v_position.shares_raw::numeric = 0 then 0
    else v_position.cost_basis_quote::numeric * v_new_shares / v_position.shares_raw::numeric
  end;

  v_consumed_cost_basis := v_position.cost_basis_quote::numeric - v_new_cost_basis;
  v_profit := p_redeem_value_quote::numeric - v_consumed_cost_basis;

  update bag_investor_positions
  set shares_raw = v_new_shares::text,
      cost_basis_quote = v_new_cost_basis::text,
      updated_at = now()
  where user_id = p_user_id and bag_id = p_bag_id;

  update bag_share_state
  set total_shares_raw = (total_shares_raw::numeric - p_shares_burn_raw::numeric)::text,
      updated_at = now()
  where bag_id = p_bag_id;

  for h in select * from jsonb_array_elements(p_holdings_sold) loop
    v_chain := h->>'chain';
    v_address := h->>'address';
    v_qty := (h->>'quantity_raw')::numeric;

    update bag_holdings
    set quantity_raw = (quantity_raw::numeric - v_qty)::text, updated_at = now()
    where bag_id = p_bag_id and chain = v_chain and address = v_address
      and quantity_raw::numeric >= v_qty;
    get diagnostics v_row_count = row_count;
    if v_row_count = 0 then
      raise exception 'HOLDINGS_UNDERFLOW: bag % chain % address % cannot sell % (stale allocation)',
        p_bag_id, v_chain, v_address, v_qty;
    end if;

    update bag_investor_holdings
    set quantity_raw = (quantity_raw::numeric - v_qty)::text, updated_at = now()
    where user_id = p_user_id and bag_id = p_bag_id and chain = v_chain and address = v_address
      and quantity_raw::numeric >= v_qty;
    get diagnostics v_row_count = row_count;
    if v_row_count = 0 then
      raise exception 'INVESTOR_HOLDINGS_UNDERFLOW: user % bag % chain % address % cannot sell % (stale allocation)',
        p_user_id, p_bag_id, v_chain, v_address, v_qty;
    end if;
  end loop;

  -- P0 FIX (0018): performance fee no longer touches `portfolios.cash_balance`
  -- — it now gets the SAME atomic creator_reward_settlements treatment
  -- fork royalty already has (0017), using `p_intent_id` directly as
  -- `source_redeem_intent_id` (a real FK this function already holds, no
  -- correlation trick needed — contrast migration 0015's legacy backfill).
  -- Never charged on a loss (v_profit <= 0), never charged to a creator
  -- redeeming their own bag — unchanged from the original rule.
  -- 0033: the fee RATE is the bag's LOCKED rate once the first external
  -- investor exists (always the case when a non-creator is redeeming — a
  -- redeemer holds shares, and holding shares locked the fee). The caller's
  -- p_performance_fee_bps is only a fallback for a never-locked bag, where
  -- no fee-bearing (non-creator) redemption can exist anyway.
  select coalesce(performance_fee_bps_locked, p_performance_fee_bps) into v_fee_bps from bags where id = p_bag_id;

  if p_creator_id is not null and p_creator_id <> p_user_id and v_fee_bps > 0 and v_profit > 0 then
    v_fee_amount := round(v_profit * v_fee_bps / 10000.0, 2);
    if v_fee_amount > 0 then
      insert into activities (user_id, action)
      values (p_creator_id, 'PERFORMANCE_FEE_EARNED:' || v_fee_amount::text || ':' || p_bag_id::text)
      returning id into v_fee_activity_id;

      select wallet_address into v_creator_wallet from users where id = p_creator_id;
      if v_creator_wallet is null then
        raise exception 'PERFORMANCE_FEE_SETTLEMENT_NO_WALLET: creator % has no wallet_address on file — cannot record a settleable fee', p_creator_id;
      end if;

      insert into creator_reward_settlements (
        creator_id, creator_wallet, bag_id, reward_type,
        source_activity_id, source_redeem_intent_id,
        gross_amount_quote, reward_amount_token_raw,
        reward_token_address, reward_token_decimals, reward_chain_id,
        status
      ) values (
        p_creator_id, v_creator_wallet, p_bag_id, 'PERFORMANCE_FEE',
        v_fee_activity_id, p_intent_id,
        v_fee_amount::text, floor(v_fee_amount * 1000000)::text,
        '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', 6, 4663,
        'EARNED'
      );
    end if;
  end if;

  update redeem_intents
  set accounting_applied_at = now()
  where id = p_intent_id;

  insert into activities (user_id, action)
  values (p_user_id, 'REDEEM_EXECUTED:' || p_intent_id::text || ':' || p_bag_id::text);

  select jsonb_build_object(
    'alreadyApplied', false,
    'holdings', coalesce((select jsonb_agg(to_jsonb(bh.*)) from bag_holdings bh where bh.bag_id = p_bag_id), '[]'::jsonb),
    'shareState', (select to_jsonb(s.*) from bag_share_state s where s.bag_id = p_bag_id),
    'investorPosition', (select to_jsonb(p.*) from bag_investor_positions p where p.bag_id = p_bag_id and p.user_id = p_user_id),
    'feeActivityId', v_fee_activity_id,
    'feeAmount', v_fee_amount
  ) into v_result;

  return v_result;
end;
$$;


revoke execute on function apply_redeem_execution from public;
grant execute on function apply_redeem_execution to service_role;

-- ---------------------------------------------------------------------------
-- Phase 21 — apply_partial_redeem_execution: mixed-outcome twin, removes
-- ONLY the verifiably-sold holdings, never touches shares/cost basis (same
-- "don't invent a partial burn amount" reasoning apply_partial_purchase_
-- execution() already documents for the deposit side).
-- ---------------------------------------------------------------------------
create or replace function apply_partial_redeem_execution(
  p_intent_id uuid,
  p_bag_id uuid,
  p_holdings_sold jsonb,
  p_user_id uuid
) returns jsonb
language plpgsql
as $$
declare
  v_already_applied timestamptz;
  v_result jsonb;
  h jsonb;
  v_chain text;
  v_address text;
  v_qty numeric;
  v_row_count integer;
begin
  select reconciliation_applied_at into v_already_applied
  from redeem_intents
  where id = p_intent_id
  for update;

  if v_already_applied is not null then
    select jsonb_build_object(
      'alreadyApplied', true,
      'holdings', coalesce((select jsonb_agg(to_jsonb(bh.*)) from bag_holdings bh where bh.bag_id = p_bag_id), '[]'::jsonb)
    ) into v_result;
    return v_result;
  end if;

  for h in select * from jsonb_array_elements(p_holdings_sold) loop
    v_chain := h->>'chain';
    v_address := h->>'address';
    v_qty := (h->>'quantity_raw')::numeric;

    update bag_holdings
    set quantity_raw = (quantity_raw::numeric - v_qty)::text, updated_at = now()
    where bag_id = p_bag_id and chain = v_chain and address = v_address
      and quantity_raw::numeric >= v_qty;
    get diagnostics v_row_count = row_count;
    if v_row_count = 0 then
      raise exception 'HOLDINGS_UNDERFLOW (partial): bag % chain % address % cannot sell %',
        p_bag_id, v_chain, v_address, v_qty;
    end if;

    update bag_investor_holdings
    set quantity_raw = (quantity_raw::numeric - v_qty)::text, updated_at = now()
    where user_id = p_user_id and bag_id = p_bag_id and chain = v_chain and address = v_address
      and quantity_raw::numeric >= v_qty;
    get diagnostics v_row_count = row_count;
    if v_row_count = 0 then
      raise exception 'INVESTOR_HOLDINGS_UNDERFLOW (partial): user % bag % chain % address % cannot sell %',
        p_user_id, p_bag_id, v_chain, v_address, v_qty;
    end if;
  end loop;

  update redeem_intents
  set reconciliation_applied_at = now()
  where id = p_intent_id;

  insert into activities (user_id, action)
  values (p_user_id, 'REDEEM_PARTIAL_RECONCILED:' || p_intent_id::text || ':' || p_bag_id::text);

  select jsonb_build_object(
    'alreadyApplied', false,
    'holdings', coalesce((select jsonb_agg(to_jsonb(bh.*)) from bag_holdings bh where bh.bag_id = p_bag_id), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

revoke execute on function apply_partial_redeem_execution from public;
grant execute on function apply_partial_redeem_execution to service_role;

-- ---------------------------------------------------------------------------
-- Phase 18.7 — commit_investment_transaction: the single atomic write path
-- for an invest() basket (and, for symmetry, a single BUY/SELL) — portfolio
-- mutation + every trade insert + points/related accounting all inside one
-- Postgres transaction. See supabase/migrations/0008_add_investment_commit_
-- transaction.sql's header comment for the full reasoning (row-lock
-- concurrency serialization, idempotency-key semantics, stale-plan
-- detection). This block mirrors that migration for a fresh install.
-- ---------------------------------------------------------------------------
create table if not exists investment_commits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  investment_id text not null,
  bag_id text,
  trade_ids jsonb not null default '[]'::jsonb,
  final_cash_balance numeric(18, 2) not null,
  final_realized_pnl numeric(18, 2) not null,
  points_awarded integer not null default 0,
  -- Phase 18.9 — the portfolio_version this commit produced, so an
  -- idempotent replay (either by investment_id or, via a client_trade_id
  -- match, by trade content) can report the correct version without
  -- re-deriving it.
  portfolio_version integer not null default 0,
  created_at timestamptz not null default now(),
  unique (user_id, investment_id)
);

create index if not exists idx_investment_commits_user on investment_commits(user_id, created_at desc);

create or replace function commit_investment_transaction(
  p_user_id uuid,
  p_investment_id text,
  p_bag_id text,
  p_expected_portfolio_version integer,
  p_final_cash_balance numeric,
  p_final_realized_pnl numeric,
  p_positions jsonb,          -- full final position set: [{symbol, quantity, avg_cost}]
  p_trades jsonb,             -- every leg to insert: [{id, symbol, side, quantity, price, total_value, realized_pnl, client_trade_id}]
  p_season_id text default null,      -- non-null only when points accounting applies (a SELL leg changed realized PnL)
  p_current_bag_points integer default 0,
  p_current_points_spent integer default 0
) returns jsonb
language plpgsql
as $$
declare
  v_actual_cash_balance numeric;
  v_actual_portfolio_version integer;
  v_existing investment_commits%rowtype;
  v_trade_ids jsonb := '[]'::jsonb;
  v_new_bag_points integer;
  v_points_delta integer := 0;
  v_points_available integer;
  v_new_version integer;
  -- Phase 18.9 additions:
  v_leg jsonb;
  v_leg_client_trade_id text;
  v_existing_trade trades%rowtype;
  v_prior_commit investment_commits%rowtype;
begin
  -- Row lock FIRST — see 0008's CONCURRENCY note. This is the single
  -- serialization point every other guarantee in this function relies on.
  select cash_balance, portfolio_version into v_actual_cash_balance, v_actual_portfolio_version
  from portfolios
  where user_id = p_user_id
  for update;

  if v_actual_portfolio_version is null then
    raise exception 'PORTFOLIO_NOT_FOUND';
  end if;

  -- Idempotency (whole-commit, by investment_id): safe to check now that we
  -- hold the per-user lock — no other commit for this user can be in flight.
  select * into v_existing
  from investment_commits
  where user_id = p_user_id and investment_id = p_investment_id;

  if found then
    return jsonb_build_object(
      'alreadyApplied', true,
      'tradeIds', v_existing.trade_ids,
      'finalCashBalance', v_existing.final_cash_balance,
      'finalRealizedPnl', v_existing.final_realized_pnl,
      'pointsAwarded', v_existing.points_awarded,
      'portfolioVersion', v_existing.portfolio_version
    );
  end if;

  -- Phase 18.9 — staleness is now judged on portfolio_version, not
  -- cash_balance: catches "positions changed but cash happened to net out"
  -- too. See this migration's module doc above.
  if v_actual_portfolio_version != p_expected_portfolio_version then
    raise exception 'PORTFOLIO_STALE';
  end if;

  -- Phase 18.9 — client_trade_id conflict pre-check, BEFORE any write.
  -- Every leg is checked; a genuine conflict aborts the whole function via
  -- `raise exception` before anything below this loop has run.
  for v_leg in select * from jsonb_array_elements(p_trades)
  loop
    v_leg_client_trade_id := v_leg->>'client_trade_id';

    select * into v_existing_trade
    from trades
    where user_id = p_user_id and client_trade_id = v_leg_client_trade_id;

    if found then
      if v_existing_trade.symbol = (v_leg->>'symbol')
         and v_existing_trade.side = (v_leg->>'side')
         and v_existing_trade.quantity = (v_leg->>'quantity')::numeric
         and v_existing_trade.price = (v_leg->>'price')::numeric
      then
        -- Same logical trade, reached via a DIFFERENT investment_id (the
        -- investment_id lookup above already missed, or we wouldn't be
        -- here). Whichever commit originally wrote this trade already
        -- applied its full effect — replay THAT commit's result verbatim
        -- and write nothing new, rather than guessing how to merge.
        select * into v_prior_commit
        from investment_commits
        where user_id = p_user_id
          and trade_ids @> to_jsonb(v_existing_trade.id::text);

        if found then
          return jsonb_build_object(
            'alreadyApplied', true,
            'tradeIds', v_prior_commit.trade_ids,
            'finalCashBalance', v_prior_commit.final_cash_balance,
            'finalRealizedPnl', v_prior_commit.final_realized_pnl,
            'pointsAwarded', v_prior_commit.points_awarded,
            'portfolioVersion', v_prior_commit.portfolio_version
          );
        else
          -- Defensive only: every write path to `trades` goes through this
          -- function, so an orphaned trade with no owning investment_commits
          -- row should not be reachable. Treat conservatively as a
          -- conflict rather than silently guessing.
          raise exception 'CLIENT_TRADE_ID_CONFLICT: %', v_leg_client_trade_id;
        end if;
      else
        -- Same client_trade_id, genuinely different trade content.
        raise exception 'CLIENT_TRADE_ID_CONFLICT: %', v_leg_client_trade_id;
      end if;
    end if;
  end loop;

  v_new_version := v_actual_portfolio_version + 1;

  -- 1. portfolio mutation
  update portfolios
  set cash_balance = p_final_cash_balance,
      realized_pnl = p_final_realized_pnl,
      portfolio_version = v_new_version,
      updated_at = now()
  where user_id = p_user_id;

  -- 2. positions — full reconciliation against the plan's final set,
  -- same semantics as trading-repo.ts's persistPortfolio(): delete symbols
  -- no longer held, upsert the rest.
  delete from positions
  where user_id = p_user_id
    and symbol not in (
      select (elem->>'symbol')::text
      from jsonb_array_elements(p_positions) as elem
    );

  insert into positions (user_id, symbol, quantity, avg_cost)
  select
    p_user_id,
    (elem->>'symbol')::text,
    (elem->>'quantity')::numeric,
    (elem->>'avg_cost')::numeric
  from jsonb_array_elements(p_positions) as elem
  on conflict (user_id, symbol) do update
    set quantity = excluded.quantity,
        avg_cost = excluded.avg_cost;

  -- 3. all trade inserts. `on conflict do nothing` remains here only as a
  -- defensive belt-and-suspenders — the pre-check loop above has already
  -- ruled out every possible collision under the row lock we're still
  -- holding, so this should never actually fire in practice.
  insert into trades (id, user_id, symbol, side, quantity, price, total_value, realized_pnl, bag_id, client_trade_id)
  select
    (elem->>'id')::uuid,
    p_user_id,
    (elem->>'symbol')::text,
    (elem->>'side')::text,
    (elem->>'quantity')::numeric,
    (elem->>'price')::numeric,
    (elem->>'total_value')::numeric,
    (elem->>'realized_pnl')::numeric,
    p_bag_id,
    (elem->>'client_trade_id')::text
  from jsonb_array_elements(p_trades) as elem
  on conflict (user_id, client_trade_id) do nothing;

  select coalesce(jsonb_agg(elem->>'id'), '[]'::jsonb) into v_trade_ids
  from jsonb_array_elements(p_trades) as elem;

  -- 4. points / related accounting — only when this commit's caller says
  -- points accounting applies (a SELL leg changed realized PnL; every-BUY
  -- invest() baskets pass p_season_id = null and this whole block is a
  -- no-op, matching today's behaviour where invest() never awards points).
  -- Same derivation rule as points-repo.ts's syncPointsFromRealizedPnL:
  -- BAG Points are always recomputed from total realized PnL, never
  -- accumulated — $10 of net realized profit = 1 point.
  if p_season_id is not null then
    v_new_bag_points := greatest(floor(p_final_realized_pnl / 10), 0)::integer;
    v_points_delta := v_new_bag_points - p_current_bag_points;
    v_points_available := v_new_bag_points - p_current_points_spent;

    insert into user_points (user_id, season_id, total_realized_pnl, bag_points, points_spent, points_available)
    values (p_user_id, p_season_id, p_final_realized_pnl, v_new_bag_points, p_current_points_spent, v_points_available)
    on conflict (user_id, season_id) do update
      set total_realized_pnl = excluded.total_realized_pnl,
          bag_points = excluded.bag_points,
          points_available = excluded.points_available;

    if v_points_delta > 0 then
      insert into point_transactions (user_id, season_id, type, amount, reference_id)
      values (p_user_id, p_season_id, 'TRADE_PROFIT', v_points_delta, p_investment_id);
    end if;
  end if;

  -- 5. investment/audit record — also this commit's idempotency guard for
  -- every future replay of this same investment_id (or, via the trade-id
  -- lookup above, of any of its individual trades under a different id).
  insert into investment_commits (
    user_id, investment_id, bag_id, trade_ids, final_cash_balance, final_realized_pnl, points_awarded, portfolio_version
  )
  values (
    p_user_id, p_investment_id, p_bag_id, v_trade_ids, p_final_cash_balance, p_final_realized_pnl, greatest(v_points_delta, 0), v_new_version
  );

  insert into activities (user_id, action)
  values (p_user_id, 'INVESTMENT_COMMITTED:' || p_investment_id);

  -- 6. commit — implicit: returning here ends the function successfully,
  -- and Postgres commits the transaction the function body ran in. Any
  -- exception raised above (including the unique-constraint conflicts and
  -- explicit `raise exception` calls) unwinds ALL of the above — no partial
  -- write is ever observable, by design of a single plpgsql function body.
  return jsonb_build_object(
    'alreadyApplied', false,
    'tradeIds', v_trade_ids,
    'finalCashBalance', p_final_cash_balance,
    'finalRealizedPnl', p_final_realized_pnl,
    'pointsAwarded', greatest(v_points_delta, 0),
    'portfolioVersion', v_new_version
  );
end;
$$;

revoke execute on function commit_investment_transaction from public;
grant execute on function commit_investment_transaction to service_role;

-- =============================================================================
-- Phase 22/23 — creator_reward_settlements + legacy backfill + royalty
-- activity-id return value (supabase/migrations/
-- 0014_add_creator_reward_settlements.sql, 0015_backfill_legacy_creator_rewards.sql,
-- 0016_return_royalty_activity_id.sql — appended verbatim so a fresh
-- install ends up in the same state as an existing DB that ran all three
-- migrations — same convention every earlier phase in this file follows).
-- 0016's replace of apply_purchase_execution() already appears ABOVE, in
-- its final (post-0016) form — not duplicated again here.
-- See docs/CREATOR_REWARDS_SETTLEMENT.md for the full design rationale.
-- =============================================================================

-- 0014_add_creator_reward_settlements.sql
--
-- Upgrades creator rewards from "activities row = paper ledger credit"
-- (0013) to an explicit on-chain settlement lifecycle. A row in
-- `activities` (FORK_ROYALTY_EARNED / PERFORMANCE_FEE_EARNED) was never
-- proof that real USDG sits in CreatorRewardsVault
-- (contracts/CreatorRewardsVault.sol) — this table is what closes that
-- gap, one row per reward event, tracked from EARNED through to
-- CONFIRMED on-chain (or FAILED/CANCELLED).
--
-- Two settlement paths write into this table (see
-- lib/server/creator-rewards-settlement.ts and
-- contracts/RedeemFeeRouter.sol):
--   1. Fork royalty (purchase-time): still resolved by the cross-chain
--      LI.FI purchase flow, so it cannot yet be made atomic with the
--      user's own purchase transaction (see that file's doc block for
--      why). Settlement worker picks up EARNED rows and submits a
--      `CreatorRewardsVault.settleReward` transaction after the fact —
--      still idempotent (refId = deterministic hash of this row's id),
--      never a second charge to the user, but not single-signature.
--   2. Performance fee (redeem-time): settled ATOMICALLY by
--      RedeemFeeRouter in the same transaction as the user's own redeem
--      swap. For this path, a row here is inserted ALREADY confirmed
--      (status starts at 'CONFIRMED', on_chain_tx_hash populated) by the
--      route handler once RedeemFeeRouter's `Redeemed` event is observed
--      — never a naive "we asked the router, so the creator must have
--      been paid" assumption; the caller must have the transaction
--      receipt with the matching event in hand.
--
-- Legacy note: rewards recorded ONLY in `activities` before this
-- migration (see 0013) are NOT retroactively considered settled. See
-- docs/CREATOR_REWARDS_SETTLEMENT.md "historical rewards" section for the
-- explicit, one-time, idempotent migration process required before any
-- of that legacy balance could become claimable on-chain. This migration
-- does not perform that backfill — doing so automatically would be
-- exactly the "pretend a database row is money" failure this table
-- exists to prevent.

create table if not exists creator_reward_settlements (
  id uuid primary key default gen_random_uuid(),

  -- Who earned it and for which bag/reward type — same shape as the
  -- 0013 activities encoding, but now structured columns instead of a
  -- colon-joined string, so the settlement worker doesn't need to
  -- re-parse `activities.action`.
  creator_id uuid not null references users(id),
  creator_wallet text not null, -- snapshot of users.wallet_address AT THE TIME this row was created — see "wallet changes" note below
  bag_id uuid not null references bags(id),
  reward_type text not null check (reward_type in ('FORK_ROYALTY', 'PERFORMANCE_FEE')),

  -- The exact off-chain event this settlement is FOR — never a second,
  -- independently-computed value. One of these two is set depending on
  -- reward_type; enforced by the check constraint below.
  source_activity_id uuid references activities(id),
  source_redeem_intent_id uuid references redeem_intents(id),

  -- Money, in both units — see lib/config/robinhood-chain.ts's
  -- quoteDecimalToRewardTokenRaw/rewardTokenRawToQuoteDecimal for the
  -- ONLY sanctioned conversion between them. Never derive one from the
  -- other with floating point at read time.
  gross_amount_quote text not null, -- decimal string, same convention as activities.action's amount
  reward_amount_token_raw text not null, -- raw USDG base units, as decimal text (numeric can't hold uint256 safely as text round-trips cleanly)
  reward_token_address text not null,
  reward_token_decimals integer not null,
  reward_chain_id integer not null,

  status text not null default 'EARNED' check (
    status in ('EARNED', 'PENDING_SETTLEMENT', 'SUBMITTED', 'CONFIRMED', 'FAILED', 'RETRYABLE', 'CANCELLED')
  ),

  -- The vault's bytes32 refId this settlement used/will use — deterministic
  -- (keccak256 of this row's id, computed by the settlement worker /
  -- route handler, never random) so a retried job always recomputes the
  -- SAME refId and CreatorRewardsVault.refUsed naturally rejects a
  -- duplicate on-chain, even if the DB-level idempotency check below
  -- somehow raced.
  settlement_ref_id text,
  onchain_tx_hash text,
  settled_at timestamptz,
  claimed_at timestamptz, -- set once we observe a Withdrawn event for this creator covering this settlement — best-effort display only, NEVER authoritative for "is this claimable" (the vault's own balanceOf is)
  failure_reason text,

  -- Optimistic-lock-style counter so the settlement worker can detect
  -- "someone else already claimed this job" without a DB-level advisory
  -- lock — see lib/server/creator-rewards-settlement.ts's claimNextBatch().
  attempt_count integer not null default 0,
  locked_by text,
  locked_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint creator_reward_settlements_source_matches_type check (
    (reward_type = 'FORK_ROYALTY' and source_activity_id is not null and source_redeem_intent_id is null)
    or
    (reward_type = 'PERFORMANCE_FEE' and source_redeem_intent_id is not null)
  )
);

-- One settlement row per source event, ever. This is the DATABASE-layer
-- idempotency guarantee (section 17's "database" requirement) — a
-- worker/route handler that races or retries and tries to insert a
-- second row for the same source_activity_id / source_redeem_intent_id
-- gets a unique-violation, not a silent duplicate.
create unique index if not exists creator_reward_settlements_source_activity_uidx
  on creator_reward_settlements (source_activity_id)
  where source_activity_id is not null;

create unique index if not exists creator_reward_settlements_source_redeem_intent_uidx
  on creator_reward_settlements (source_redeem_intent_id)
  where source_redeem_intent_id is not null;

-- The BLOCKCHAIN-layer idempotency guarantee's DB-side mirror: once a
-- refId has actually been used on-chain, no other row may claim it.
create unique index if not exists creator_reward_settlements_ref_id_uidx
  on creator_reward_settlements (settlement_ref_id)
  where settlement_ref_id is not null;

create index if not exists creator_reward_settlements_creator_idx
  on creator_reward_settlements (creator_id, status);

create index if not exists creator_reward_settlements_pending_idx
  on creator_reward_settlements (status, created_at)
  where status in ('EARNED', 'RETRYABLE');

alter table creator_reward_settlements enable row level security;

-- Creators may read their own settlement rows (for the dashboard's
-- "pending settlement" / "failed" states — see hooks/useCreatorRewards.ts
-- follow-up). No insert/update/delete policy for authenticated users:
-- only service_role (server-side worker / route handlers) ever writes.
--
-- CURRENTLY INERT — documented, not a live security boundary: this app
-- has no Supabase Auth session (see lib/auth/session.ts — auth is a
-- custom JWT the app issues itself after a wallet-signature login, never
-- a Supabase `auth.users` row), so `auth.uid()` is always NULL for every
-- request this app makes. The browser never talks to Supabase directly
-- either way (every table access goes through this app's own API routes,
-- using the service-role client, which bypasses RLS entirely) — so this
-- policy neither protects anything today nor is exploitable as a false
-- sense of security: the REAL access boundary is `requireSession()` +
-- each route's own ownership check (e.g. `creator_id = session.userId`),
-- enforced in application code, not here. Left in place (rather than
-- dropped) as the shape a real policy would take IF a future pass wires
-- Supabase Auth sessions directly to `users.id` and lets the browser read
-- this table straight from a client SDK instead of through a route.
create policy creator_reward_settlements_select_own
  on creator_reward_settlements for select
  using (creator_id = auth.uid());

revoke all on creator_reward_settlements from public;
grant select on creator_reward_settlements to authenticated;
grant all on creator_reward_settlements to service_role;

-- Concurrency-safe batch claim, same `for update skip locked` pattern the
-- rest of this codebase's row-locking RPCs use (see 0004/0012/0013).
-- `skip locked` (not a bare `for update`) is the important part here: it
-- lets N settlement worker instances run concurrently, each grabbing a
-- disjoint batch, rather than blocking on each other or racing to double-
-- process the same row (section 18's "implement concurrency protection").
create or replace function claim_reward_settlement_batch(p_worker_id text, p_limit integer default 20)
returns setof creator_reward_settlements
language plpgsql
as $$
begin
  return query
    update creator_reward_settlements
    set status = 'PENDING_SETTLEMENT',
        locked_by = p_worker_id,
        locked_at = now(),
        attempt_count = attempt_count + 1,
        updated_at = now()
    where id in (
      select id from creator_reward_settlements
      where status in ('EARNED', 'RETRYABLE')
      order by created_at asc
      limit p_limit
      for update skip locked
    )
    returning *;
end;
$$;

revoke execute on function claim_reward_settlement_batch from public;
grant execute on function claim_reward_settlement_batch to service_role;


-- ---------------------------------------------------------------------------
-- Phase 23 — legacy backfill functions (0015). On a FRESH install there are
-- no pre-existing `activities` rows to backfill, so
-- `select backfill_legacy_fork_royalty_rewards();` at the end is a correct,
-- harmless no-op (0 inserted, 0 skipped).
-- ---------------------------------------------------------------------------

-- 0015_backfill_legacy_creator_rewards.sql
--
-- One-time, idempotent backfill of pre-0014 creator rewards (activities
-- rows written by apply_purchase_execution()/apply_redeem_execution()
-- BEFORE creator_reward_settlements existed) into the new settlement
-- lifecycle table, at status EARNED — NOT CONFIRMED. This does NOT make
-- any legacy reward claimable on-chain by itself: it only unblocks the
-- accounting path so the existing settlement worker
-- (lib/server/creator-rewards-settlement.ts) can pick these rows up like
-- any other EARNED fork-royalty row, exactly once real USDG funding for
-- them has been separately arranged. See
-- docs/CREATOR_REWARDS_SETTLEMENT.md's "Historical / legacy rewards"
-- section for the full rationale — this migration is the "step 2"
-- (idempotent script) that doc said was missing.
--
-- IMPORTANT SCOPE NOTE: only FORK_ROYALTY_EARNED rows are backfilled by
-- this migration. PERFORMANCE_FEE_EARNED legacy rows are intentionally
-- NOT backfilled here — see the long comment above
-- backfill_legacy_performance_fee_rewards() below for why that path is a
-- best-effort correlation (bag_id + exact-transaction-timestamp match
-- against a companion REDEEM_EXECUTED row) rather than a guaranteed one,
-- and is exposed as a separate, explicitly-invoked function so it is
-- never silently run as part of `supabase db push` without someone
-- reviewing its output first.
--
-- Idempotency: safe to run this migration (or re-invoke either function)
-- any number of times. Every insert is protected by the SAME unique
-- indexes 0014 already created (`creator_reward_settlements_source_
-- activity_uidx` / `..._source_redeem_intent_uidx`) via `on conflict do
-- nothing` — a row already backfilled is simply skipped, never
-- duplicated, never re-credited.

-- ---------------------------------------------------------------------------
-- Fork royalty: unambiguous. FORK_ROYALTY_EARNED's own activities.id IS
-- the source_activity_id the 0014 schema wants — no correlation needed,
-- unlike performance fee below.
-- ---------------------------------------------------------------------------
create or replace function backfill_legacy_fork_royalty_rewards()
returns table(inserted_count integer, skipped_malformed_count integer)
language plpgsql
as $$
declare
  v_inserted integer := 0;
  v_skipped integer := 0;
  v_row record;
  v_amount numeric;
  v_bag_id uuid;
  v_wallet text;
begin
  for v_row in
    select a.id, a.user_id, a.action, a.created_at
    from activities a
    where a.action like 'FORK_ROYALTY_EARNED:%'
      -- Already covered — either backfilled by a prior run of this
      -- function, or settled the "normal" way after 0014 shipped.
      and not exists (
        select 1 from creator_reward_settlements s
        where s.source_activity_id = a.id
      )
  loop
    -- action shape: 'FORK_ROYALTY_EARNED:<amount>:<bagId>' — same parse
    -- rule as lib/server/creator-rewards-repo.ts's parseRewardActivity(),
    -- kept in sync deliberately (see that file's own comment on why the
    -- colon-joined convention exists at all).
    begin
      v_amount := split_part(substring(v_row.action from length('FORK_ROYALTY_EARNED:') + 1), ':', 1)::numeric;
      v_bag_id := split_part(substring(v_row.action from length('FORK_ROYALTY_EARNED:') + 1), ':', 2)::uuid;
    exception when others then
      -- Malformed/unparseable row — never guess, never invent a bag_id
      -- or amount. Skip and count it so the caller can investigate.
      v_skipped := v_skipped + 1;
      continue;
    end;

    select wallet_address into v_wallet from users where id = v_row.user_id;
    if v_wallet is null then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    insert into creator_reward_settlements (
      creator_id, creator_wallet, bag_id, reward_type,
      source_activity_id, gross_amount_quote, reward_amount_token_raw,
      reward_token_address, reward_token_decimals, reward_chain_id,
      status, created_at
    ) values (
      v_row.user_id, v_wallet, v_bag_id, 'FORK_ROYALTY',
      v_row.id, v_amount::text,
      -- USDG, 6 decimals (lib/config/robinhood-chain.ts) — gross_amount_quote
      -- here always already has <= 2 decimal places (apply_purchase_
      -- execution() rounds with `round(..., 2)` before ever writing the
      -- activities row), so floor(amount * 10^6) is exact, never lossy.
      floor(v_amount * 1000000)::text,
      '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', 6, 4663,
      'EARNED', v_row.created_at
    )
    on conflict (source_activity_id) where source_activity_id is not null do nothing;

    if found then
      v_inserted := v_inserted + 1;
    end if;
  end loop;

  return query select v_inserted, v_skipped;
end;
$$;

revoke execute on function backfill_legacy_fork_royalty_rewards from public;
grant execute on function backfill_legacy_fork_royalty_rewards to service_role;

-- ---------------------------------------------------------------------------
-- Performance fee: needs a redeem_intents.id to satisfy 0014's check
-- constraint (`reward_type = 'PERFORMANCE_FEE' requires source_redeem_
-- intent_id is not null`), but the legacy PERFORMANCE_FEE_EARNED string
-- itself only ever encoded '<amount>:<bagId>' — no intent id.
--
-- Correlation trick: apply_redeem_execution() (0013) always inserts the
-- creator's PERFORMANCE_FEE_EARNED row and the redeemer's own
-- 'REDEEM_EXECUTED:<intentId>:<bagId>' row in the SAME function call,
-- i.e. the SAME database transaction — and `now()` in Postgres returns
-- the transaction's start time, identical for every statement inside one
-- transaction. So for a given PERFORMANCE_FEE_EARNED row, the matching
-- REDEEM_EXECUTED row (same bag_id, IDENTICAL created_at timestamp down
-- to the microsecond) reveals the intent id we need.
--
-- This is a real correlation, not a guess — but it is not proof the way
-- source_activity_id's direct foreign key is, so this function is kept
-- SEPARATE from the fork-royalty one above, is NOT called automatically
-- by this migration file, and returns its unmatched rows explicitly so a
-- human reviews them rather than this silently leaving some legacy
-- performance fees unmigrated with no visibility. Call manually:
--   select * from backfill_legacy_performance_fee_rewards();
-- ---------------------------------------------------------------------------
create or replace function backfill_legacy_performance_fee_rewards()
returns table(inserted_count integer, unmatched_count integer, malformed_count integer)
language plpgsql
as $$
declare
  v_inserted integer := 0;
  v_unmatched integer := 0;
  v_malformed integer := 0;
  v_row record;
  v_amount numeric;
  v_bag_id uuid;
  v_wallet text;
  v_intent_id uuid;
begin
  for v_row in
    select a.id, a.user_id, a.action, a.created_at
    from activities a
    where a.action like 'PERFORMANCE_FEE_EARNED:%'
      and not exists (
        select 1 from creator_reward_settlements s
        where s.source_activity_id = a.id
      )
  loop
    begin
      v_amount := split_part(substring(v_row.action from length('PERFORMANCE_FEE_EARNED:') + 1), ':', 1)::numeric;
      v_bag_id := split_part(substring(v_row.action from length('PERFORMANCE_FEE_EARNED:') + 1), ':', 2)::uuid;
    exception when others then
      v_malformed := v_malformed + 1;
      continue;
    end;

    -- Find the companion REDEEM_EXECUTED row: same bag, exact same
    -- transaction timestamp. Ambiguous match (more than one candidate) is
    -- treated as unmatched, not "pick the first one" — a wrong intent id
    -- here would misattribute a real user's redemption to the wrong
    -- settlement row.
    select (split_part(substring(re.action from length('REDEEM_EXECUTED:') + 1), ':', 1))::uuid
      into v_intent_id
    from activities re
    where re.action like 'REDEEM_EXECUTED:%:' || v_bag_id::text
      and re.created_at = v_row.created_at
    limit 2; -- fetch up to 2 just to detect ambiguity below without a second query

    if not found then
      v_unmatched := v_unmatched + 1;
      continue;
    end if;

    -- Re-check for ambiguity explicitly (the LIMIT 2 above only prevented
    -- an unbounded scan; this confirms exactly one candidate existed).
    if (
      select count(*) from activities re
      where re.action like 'REDEEM_EXECUTED:%:' || v_bag_id::text
        and re.created_at = v_row.created_at
    ) <> 1 then
      v_unmatched := v_unmatched + 1;
      continue;
    end if;

    select wallet_address into v_wallet from users where id = v_row.user_id;
    if v_wallet is null then
      v_unmatched := v_unmatched + 1;
      continue;
    end if;

    insert into creator_reward_settlements (
      creator_id, creator_wallet, bag_id, reward_type,
      source_activity_id, source_redeem_intent_id,
      gross_amount_quote, reward_amount_token_raw,
      reward_token_address, reward_token_decimals, reward_chain_id,
      status, created_at
    ) values (
      v_row.user_id, v_wallet, v_bag_id, 'PERFORMANCE_FEE',
      v_row.id, v_intent_id,
      v_amount::text, floor(v_amount * 1000000)::text,
      '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', 6, 4663,
      'EARNED', v_row.created_at
    )
    on conflict (source_redeem_intent_id) where source_redeem_intent_id is not null do nothing;

    if found then
      v_inserted := v_inserted + 1;
    else
      v_unmatched := v_unmatched + 1; -- redeem_intent_id already used by another settlement row — investigate, don't silently drop
    end if;
  end loop;

  return query select v_inserted, v_unmatched, v_malformed;
end;
$$;

revoke execute on function backfill_legacy_performance_fee_rewards from public;
grant execute on function backfill_legacy_performance_fee_rewards to service_role;

-- Fork royalty backfill IS safe to run automatically as part of applying
-- this migration (unambiguous, direct FK correlation) — performance fee
-- backfill is not auto-invoked here, per the rationale above.
select backfill_legacy_fork_royalty_rewards();

-- 0019_router_settled_redeem_indexing.sql
--
-- V11 P0 #8 ("DB accounting sadece sonucu indexlemeli... double settlement
-- kesinlikle mümkün olmamalı"): the NEW RedeemFeeRouter-based redemption
-- path settles the creator fee ATOMICALLY on-chain, inside the SAME
-- transaction as the swap (see contracts/RedeemFeeRouter.sol's `redeem()`
-- calling `vault.settleReward()` directly). By the time the server ever
-- hears about this redemption, the fee is already real, already paid,
-- already in `CreatorRewardsVault.balanceOf(creator)` — recomputing it and
-- inserting a fresh EARNED `creator_reward_settlements` row (the way
-- `apply_redeem_execution()`, unchanged, still correctly does for the
-- legacy LI.FI path) would create a SECOND economic record for money that
-- was already paid once, which the settlement worker would then try to
-- pay AGAIN. This function exists specifically to avoid that.
--
-- Deliberately a NEW function, not a modified `apply_redeem_execution()`
-- signature — that function's existing behavior (compute fee, credit
-- portfolios/activities, insert an EARNED settlement row for the async
-- worker to later pay) remains exactly correct for the legacy LI.FI path,
-- which this migration does not touch, per "don't rewrite working
-- systems" / "don't change existing repository-layer signatures unless
-- strictly required".
create or replace function apply_redeem_execution_router_settled(
  p_intent_id uuid,
  p_bag_id uuid,
  p_holdings_sold jsonb,
  p_shares_burn_raw text,
  p_share_decimals integer,
  p_user_id uuid,
  p_redeem_value_quote text,
  p_creator_id uuid,
  p_creator_wallet text,
  p_fee_amount_quote text,
  p_fee_amount_token_raw text,
  p_onchain_tx_hash text,
  p_redemption_id_hex text
) returns jsonb
language plpgsql
as $$
declare
  v_already_applied timestamptz;
  v_position bag_investor_positions%rowtype;
  v_new_shares numeric;
  v_new_cost_basis numeric;
  v_consumed_cost_basis numeric;
  v_profit numeric;
  v_result jsonb;
  h jsonb;
  v_chain text;
  v_address text;
  v_qty numeric;
begin
  select accounting_applied_at into v_already_applied
  from redeem_intents
  where id = p_intent_id
  for update;

  if v_already_applied is not null then
    select jsonb_build_object(
      'alreadyApplied', true,
      'holdings', coalesce((select jsonb_agg(to_jsonb(bh.*)) from bag_holdings bh where bh.bag_id = p_bag_id), '[]'::jsonb),
      'investorPosition', (select to_jsonb(p.*) from bag_investor_positions p where p.bag_id = p_bag_id and p.user_id = p_user_id)
    ) into v_result;
    return v_result;
  end if;

  -- IDENTICAL holdings/shares/cost-basis logic to apply_redeem_execution()
  -- (0018) — this function only diverges in how the FEE is recorded, never
  -- in the position accounting itself. Kept duplicated rather than
  -- factored into a shared helper: PL/pgSQL has no cheap way to share a
  -- code block across two SECURITY-relevant functions without an extra
  -- indirection layer that would make both harder to audit independently.
  for h in select * from jsonb_array_elements(p_holdings_sold)
  loop
    v_chain := h->>'chain';
    v_address := h->>'address';
    v_qty := (h->>'quantity_raw')::numeric;

    update bag_holdings
    set quantity_raw = (quantity_raw::numeric - v_qty)::text, updated_at = now()
    where bag_id = p_bag_id and chain = v_chain and address = v_address;

    update bag_investor_holdings
    set quantity_raw = (quantity_raw::numeric - v_qty)::text, updated_at = now()
    where user_id = p_user_id and bag_id = p_bag_id and chain = v_chain and address = v_address;
  end loop;

  select * into v_position from bag_investor_positions where user_id = p_user_id and bag_id = p_bag_id for update;

  if v_position.shares_raw::numeric > 0 then
    v_consumed_cost_basis := round(
      v_position.cost_basis_quote::numeric * (p_shares_burn_raw::numeric / v_position.shares_raw::numeric),
      2
    );
  else
    v_consumed_cost_basis := 0;
  end if;

  v_profit := p_redeem_value_quote::numeric - v_consumed_cost_basis;
  v_new_shares := v_position.shares_raw::numeric - p_shares_burn_raw::numeric;
  v_new_cost_basis := v_position.cost_basis_quote::numeric - v_consumed_cost_basis;

  update bag_investor_positions
  set shares_raw = v_new_shares::text,
      cost_basis_quote = v_new_cost_basis::text,
      updated_at = now()
  where user_id = p_user_id and bag_id = p_bag_id;

  update bag_share_state
  set total_shares_raw = (total_shares_raw::numeric - p_shares_burn_raw::numeric)::text,
      updated_at = now()
  where bag_id = p_bag_id;

  -- Audit-only activity row — same PERFORMANCE_FEE_EARNED convention as
  -- the legacy path, so lib/server/creator-rewards-repo.ts's existing
  -- parser keeps working unchanged for a creator's reward history view.
  if p_fee_amount_quote::numeric > 0 then
    insert into activities (user_id, action)
    values (p_creator_id, 'PERFORMANCE_FEE_EARNED:' || p_fee_amount_quote || ':' || p_bag_id::text);

    -- THE key difference from apply_redeem_execution(): inserted directly
    -- at CONFIRMED, with the real on-chain proof, because the fee is
    -- ALREADY settled — never EARNED (which would make the async
    -- settlement worker try to pay it a second time). `source_redeem_intent_id`
    -- carries the SAME unique-index protection 0014 already created, so a
    -- retried call to this function (e.g. a webhook redelivery) can never
    -- insert a second row for the same intent either.
    insert into creator_reward_settlements (
      creator_id, creator_wallet, bag_id, reward_type,
      source_redeem_intent_id, gross_amount_quote, reward_amount_token_raw,
      reward_token_address, reward_token_decimals, reward_chain_id,
      status, settlement_ref_id, onchain_tx_hash, settled_at
    ) values (
      p_creator_id, p_creator_wallet, p_bag_id, 'PERFORMANCE_FEE',
      p_intent_id, p_fee_amount_quote, p_fee_amount_token_raw,
      '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', 6, 4663,
      'CONFIRMED', p_redemption_id_hex, p_onchain_tx_hash, now()
    )
    on conflict (source_redeem_intent_id) where source_redeem_intent_id is not null do nothing;
  end if;

  update redeem_intents
  set accounting_applied_at = now()
  where id = p_intent_id;

  insert into activities (user_id, action)
  values (p_user_id, 'REDEEM_EXECUTED:' || p_intent_id::text || ':' || p_bag_id::text);

  select jsonb_build_object(
    'alreadyApplied', false,
    'consumedCostBasis', v_consumed_cost_basis,
    'profit', v_profit,
    'investorPosition', (select to_jsonb(p.*) from bag_investor_positions p where p.bag_id = p_bag_id and p.user_id = p_user_id)
  ) into v_result;

  return v_result;
end;
$$;

revoke execute on function apply_redeem_execution_router_settled(uuid, uuid, jsonb, text, integer, uuid, text, uuid, text, text, text, text, text) from public;
grant execute on function apply_redeem_execution_router_settled(uuid, uuid, jsonb, text, integer, uuid, text, uuid, text, text, text, text, text) to service_role;
-- 0020_add_asset_type.sql
--
-- Adds `asset_type` ('crypto' | 'stock') to `assets`.
-- `supabase/schema.sql` already reflects this for fresh installs; this
-- migration brings an EXISTING project's `assets` table up to date without
-- dropping/recreating it — same pattern as 0003_add_asset_current_multiplier.sql.
--
-- Why: until now, every row in this table was a Robinhood Stock Token
-- (robinhood-import.ts), so `lib/registry-assets-client.ts`'s
-- `canonicalAssetToUiAsset()` hardcoded `type: 'stock'` when mapping a
-- registry row to the UI's `Asset` shape. `coingecko-import.ts` now also
-- writes crypto (BTC/ETH/SOL/... ERC-20 deployments) into this same table,
-- so the registry needs its own record of which is which — the UI's
-- All/Crypto/Stocks filter tabs (components/create/AssetSelector.tsx) read
-- straight off this, not off any heuristic (e.g. chain) that would be
-- wrong the day a crypto asset and a Stock Token share a chain.
--
-- Backfill: every row that exists before this migration is a Stock Token
-- (the only importer that has ever run), so `default 'stock'` on the
-- `alter table ... add column` backfills existing rows correctly in the
-- same statement — no separate `update` needed.
--
-- Run this BEFORE running `scripts/import-coin-assets.ts --apply`.

alter table assets
  add column if not exists asset_type text not null default 'stock'
    check (asset_type in ('crypto', 'stock'));

create index if not exists idx_assets_type on assets(asset_type);
-- 0021_add_composer_transaction.sql
--
-- Adds `composer_transaction` (nullable jsonb) to `purchase_intents`.
--
-- Why: lib/blockchain/lifi-composer-adapter.ts + lifi-purchase-quote.ts's
-- `tryBuildComposerSteps()` can now build a deposit's SWAP steps as ONE
-- shared LI.FI Composer transaction (single signature for N target
-- assets) instead of N independent LI.FI routes. That one transaction's
-- { to, data, value, chainId, userProxy } needs somewhere to live between
-- intent creation and the client actually signing it — this column, read
-- by the SAME route (`app/api/bags/[id]/purchase-intent`) that already
-- returns `steps`, not a new endpoint.
--
-- Deliberately NOT a new table / NOT normalized into `steps` jsonb itself:
-- this is ONE transaction shared across potentially several SWAP step
-- rows, not a per-step value, so it doesn't belong inside any single
-- step's own JSON the way `lifiStep` (needed as: it IS the value)
-- historically has.
--
-- Null for every existing row and for every future non-Composer intent
-- (redemptions always; deposits whenever Composer wasn't eligible or
-- wasn't configured) — `tryBuildComposerSteps()` returning null already
-- means "use the sequential path", and this column mirrors that: null
-- here is the normal case, not a migration gap to backfill.

alter table purchase_intents
  add column if not exists composer_transaction jsonb;
-- 0022_add_execution_plan_hash.sql
--
-- Adds `execution_plan_hash` (nullable text) to `purchase_intents`.
--
-- Why: lib/execution/compiler.ts's `compileBagExecution()` stamps every
-- `CompiledExecution` with a sha256 `executionPlanHash`
-- (lib/execution/plan.ts's `computeBagExecutionGraphHash()`) — a
-- fingerprint of the provider-independent `BagExecutionGraph` a purchase
-- was actually compiled from. This column is where that value is
-- persisted so `prepareExecution()` (lib/server/purchase-execution.ts) can
-- re-derive the CURRENT graph's hash at execute time and compare, the
-- same integrity pattern `route_fingerprint` (0004_add_purchase_intents.sql)
-- already established for the pre-compiler `ExecutionPlan` shape — this is
-- the compiler-layer equivalent, not a replacement for it. Both checks run
-- side by side when the new layer is active; `route_fingerprint`'s check
-- alone already protects every legacy (flag-off) intent exactly as before.
--
-- Null for every existing row and for every intent created while
-- `BAG_EXECUTION_COMPILER_ENABLED` is off (lib/config/execution.ts) — the
-- legacy path never had a `BagExecutionGraph` to hash in the first place.
-- `prepareExecution()` only runs the new mismatch check when this column
-- is non-null on the intent being executed, so a null value is the normal
-- case for the legacy path, not a migration gap to backfill.

alter table purchase_intents
  add column if not exists execution_plan_hash text;
-- 0023_add_execution_mode.sql
--
-- Adds `execution_mode` (nullable text) to `purchase_intents`.
--
-- Why (item 8 — UI signaling): `compileBagExecution()` already produces a
-- `CompiledExecution.mode` (`SINGLE_TX` / `MULTI_TX` / `CROSS_CHAIN` /
-- `UNSUPPORTED`, lib/execution/types.ts) describing what the compiled
-- execution ACTUALLY requires from the wallet — but until now that value
-- was computed and then discarded at `compiledExecutionToPurchaseIntentSteps()`,
-- so nothing downstream could ever see it. The purchase UI consequently
-- told every user the same thing ("signs and sends a real transaction",
-- singular) whether the compiled result was one Composer transaction or a
-- sequential LI.FI plan needing an approval plus a swap per leg. That is
-- the specific dishonesty `ExecutionMode`'s own doc calls out: "never let
-- the UI say '1 signature' when the compiled result is actually MULTI_TX".
--
-- This column is where the compiled mode is persisted so the intent the
-- browser already fetches carries it, no new endpoint required.
--
-- Null for every existing row and for every intent created while
-- `BAG_EXECUTION_COMPILER_ENABLED` is off (lib/config/execution.ts) — the
-- legacy path has no `CompiledExecution` to take a mode from. The UI
-- treats null as "unknown", and falls back to describing the expectation
-- from the intent's own steps rather than asserting a count it cannot
-- know (see lib/execution/signing-expectation.ts). Nothing to backfill:
-- a legacy intent genuinely never had a compiler-determined mode.

alter table purchase_intents
  add column if not exists execution_mode text;

-- =============================================================================
-- =============================================================================
-- 0027_add_rate_limiting.sql
--
-- Adds a minimal, Postgres-backed rate limiter for the user-facing routes
-- that were flagged (docs/FINAL_PRODUCTION_AUDIT.md's general review) as
-- having NO throttling at all: POST /api/auth/nonce, POST
-- /api/bags/:id/purchase-intent, POST /api/bags/:id/redeem-intent, and —
-- production-hardening P1-10 — the additional routes wired up since (see
-- lib/server/rate-limit.ts's own callers).
--
-- Fixed-window counter, not a sliding window or token bucket: simpler,
-- cheaper (one upsert per check), and the tradeoff — a caller could send
-- up to ~2x max_requests across a window boundary — is acceptable for
-- abuse-prevention/availability protection, which is what this is for.
-- This is NOT a security boundary: every route it's applied to already has
-- its own real enforcement (session auth, ownership checks, on-chain
-- verification, EIP-712 attestation) independent of this table.

create table if not exists rate_limit_buckets (
  bucket_key text not null,
  window_start timestamptz not null,
  request_count integer not null default 0,
  primary key (bucket_key, window_start)
);

create index if not exists idx_rate_limit_buckets_window on rate_limit_buckets(window_start);

alter table rate_limit_buckets enable row level security;
-- Deliberately zero policies: RLS enabled + no policies means anon/authenticated
-- can neither read nor write this table at all. service_role bypasses RLS
-- entirely, which is the only client that ever touches this table.

create or replace function check_rate_limit(
  p_bucket_key text,
  p_window_seconds integer,
  p_max_requests integer
) returns table(allowed boolean, retry_after_seconds integer) as $$
declare
  v_window_start timestamptz;
  v_count integer;
begin
  if p_window_seconds <= 0 or p_max_requests <= 0 then
    raise exception 'check_rate_limit: p_window_seconds and p_max_requests must be positive.';
  end if;

  v_window_start := to_timestamp(floor(extract(epoch from clock_timestamp()) / p_window_seconds) * p_window_seconds);

  if random() < 0.01 then
    delete from rate_limit_buckets where window_start < clock_timestamp() - interval '1 day';
  end if;

  insert into rate_limit_buckets as b (bucket_key, window_start, request_count)
  values (p_bucket_key, v_window_start, 1)
  on conflict (bucket_key, window_start)
  do update set request_count = b.request_count + 1
  returning b.request_count into v_count;

  if v_count > p_max_requests then
    return query select false, greatest(0, ceil(p_window_seconds - extract(epoch from clock_timestamp() - v_window_start)))::integer;
  else
    return query select true, 0;
  end if;
end;
$$ language plpgsql security definer set search_path = public;

revoke execute on function check_rate_limit(text, integer, integer) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke execute on function check_rate_limit(text, integer, integer) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke execute on function check_rate_limit(text, integer, integer) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function check_rate_limit(text, integer, integer) to service_role;
  end if;
end $$;

-- =============================================================================
-- 0028_fix_misleading_rls_policy.sql
--
-- `creator_reward_settlements_select_own`'s `using (creator_id = auth.uid())`
-- looks like real per-creator filtering, but `auth.uid()` is always NULL
-- under this app's actual auth model (custom-JWT wallet-signature sessions,
-- never Supabase Auth) — the policy silently denies every row instead of
-- filtering to "your own settlements". Not a security hole (every real read
-- goes through the service-role client, which bypasses RLS) — this just
-- stops the policy/grant from claiming to do something they can't.

drop policy if exists creator_reward_settlements_select_own on creator_reward_settlements;
revoke select on creator_reward_settlements from authenticated;

-- 0029_add_provider_id_and_bag_router_transaction.sql
--
-- Adds `provider_id` (nullable text) and `bag_router_transaction` (nullable
-- jsonb) to `purchase_intents`.
--
-- Why (Bag Router execution hardening, checkpoint 1/3): `compiler.ts`'s
-- `CompiledExecution.mode` is `SINGLE_TX` for BOTH the `lifi-composer` and
-- `bag-router` providers — `lib/execution/purchase-intent-bridge.ts`
-- previously used `mode === 'SINGLE_TX'` as its ONLY discriminator between
-- "this is a Composer transaction" and everything else, which silently
-- mapped a BAG Router result into `composer_transaction` too. That bug
-- meant a BAG-Router-executed purchase would (a) be sent to the wallet via
-- the Composer execution path client-side, with no ERC-20 allowance check
-- the router's own `transferFrom` actually requires, and (b) have its
-- steps' `output_decimals`/`min_output_raw` forced to `null` the same way
-- Composer's genuinely-non-enforced simulation figure is, even though the
-- BAG Router provider always returns a REAL, on-chain-enforced minimum for
-- every leg. A `null` `output_decimals` step is silently EXCLUDED from
-- `apply_purchase_execution`'s/`apply_partial_purchase_execution`'s holdings
-- credit (see purchase-execution.ts) — so a successfully-executed BAG
-- Router purchase would leave the depositor's bag never credited with the
-- assets it actually received.
--
-- `provider_id` is the explicit, persisted discriminant `compiledExecutionToPurchaseIntentSteps()`
-- now branches on (`CompiledExecution.providerId`, never `mode`) — carried
-- through to the persisted intent so nothing downstream has to re-derive
-- which provider actually compiled this execution. `bag_router_transaction`
-- is `bag-router`'s own, separate counterpart to `composer_transaction`:
-- shaped similarly ({to, data, value, chainId}) but never interchangeable
-- with it, and carries the two extra fields (`inputToken`/`inputAmountRaw`)
-- the client needs to check/request an ERC-20 approval before sending the
-- router transaction, plus `bagOnChainId` so `verifyExecution()` can confirm
-- the on-chain `ExecutionCompleted` event attests to the exact bag/plan this
-- intent was compiled for.
--
-- Null for every existing row and for every intent whose selected provider
-- isn't `bag-router` (redemptions always; every Composer/sequential
-- deposit) — nothing to backfill, this is the normal case, same convention
-- as `composer_transaction`/`execution_mode` (0021/0023).

alter table purchase_intents
  add column if not exists provider_id text,
  add column if not exists bag_router_transaction jsonb;

-- =============================================================================
-- 0030_fix_stale_season_status.sql
--
-- Production-hardening P0-6 — one-time data fix for `seasons.status`.
--
-- Why: `lib/server/season-repo.ts`'s `getCurrentSeason()` now derives
-- status from `start_date`/`end_date` vs `now()` on every read and never
-- trusts this column — so this migration is not required for correctness
-- going forward. It exists anyway because a stale `status = 'ACTIVE'` sitting
-- in the table for a season whose `end_date` has already passed is
-- misleading to anyone who queries `seasons` directly (support, an admin
-- tool, a future migration), and the original seed row
-- ('season-genesis-01', ends 2026-04-01) is such a case as of this
-- revision. Recomputes every row's `status` from its own dates, once.

update seasons
set status = case
  when now() < start_date then 'UPCOMING'
  when now() < end_date then 'ACTIVE'
  else 'ENDED'
end;

-- =============================================================================
-- 0031_add_consume_auth_nonce_rpc.sql
--
-- Production-hardening P0-7 — atomic nonce consume. See
-- supabase/migrations/0031_add_consume_auth_nonce_rpc.sql for the full
-- rationale: a single `delete ... returning` closes the SELECT-then-DELETE
-- race the old two-step `consumeNonce()` had, while preserving its exact
-- behavior (deletes unconditionally on any read attempt; the caller still
-- checks the returned nonce/expiry itself).

create or replace function consume_auth_nonce(p_wallet_address text)
returns table(nonce text, message text, expires_at timestamptz)
language sql
as $$
  delete from auth_nonces
  where wallet_address = p_wallet_address
  returning auth_nonces.nonce, auth_nonces.message, auth_nonces.expires_at;
$$;

-- =============================================================================
-- 0032_add_get_or_create_wallet_user_rpc.sql
--
-- Production-hardening P1-9 — atomic first-login. See
-- supabase/migrations/0032_add_get_or_create_wallet_user_rpc.sql for the
-- full rationale: folds the select-then-insert-user-then-insert-portfolio
-- sequence into one concurrent-safe upsert, so two simultaneous first
-- logins for the same wallet never race into a raw unique-violation 500,
-- and a user row can never exist without its portfolio row.

create or replace function get_or_create_wallet_user(p_wallet_address text, p_starting_cash_balance numeric)
returns table(id uuid, wallet_address text, display_name text, was_created boolean)
language plpgsql
as $$
declare
  v_user_id uuid;
  v_created boolean := false;
begin
  insert into users (wallet_address)
  values (p_wallet_address)
  on conflict on constraint users_wallet_address_key do nothing
  returning users.id into v_user_id;

  if v_user_id is not null then
    v_created := true;
  else
    select u.id into v_user_id from users u where u.wallet_address = p_wallet_address;
  end if;

  insert into portfolios (user_id, cash_balance)
  values (v_user_id, p_starting_cash_balance)
  on conflict (user_id) do nothing;

  return query
    select u.id, u.wallet_address, u.display_name, v_created
    from users u
    where u.id = v_user_id;
end;
$$;

-- =============================================================================
-- RPC execute lockdown (migration 0026). MUST stay at the END of this file so it
-- sees every function defined above — including 0031's consume_auth_nonce.
-- =============================================================================
do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as sig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prokind in ('f', 'p')
       and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
  loop
    execute format('revoke execute on function %s from public', r.sig);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke execute on function %s from anon', r.sig);
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke execute on function %s from authenticated', r.sig);
    end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('grant execute on function %s to service_role', r.sig);
    end if;
  end loop;

  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'alter default privileges in schema public revoke execute on functions from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'alter default privileges in schema public revoke execute on functions from authenticated';
  end if;
end $$;

-- 0033_lock_performance_fee_after_first_external_investment.sql
--
-- ECONOMIC INVARIANT (MVP, deliberately simple): a Bag's performance fee is
-- IMMUTABLE once the first EXTERNAL investor (anyone other than the Bag's
-- creator) holds a position. Before that, the creator may set or change it
-- freely (a new version with a different `recipe.performanceFeeBps`).
--
-- Why: apply_redeem_execution() charged whatever `performanceFeeBps` the
-- Bag's CURRENT version carried at redemption time, so a creator could raise
-- the fee on a later version and apply it retroactively to investors who
-- bought under the old one. A lot-by-lot historical fee snapshot would fix
-- that too, but nothing else in this schema is lot-based (a position is one
-- aggregate row with proportional cost basis), so "locked after first
-- external investment" is the invariant that fits the existing model.
--
-- Enforcement is DATABASE-AUTHORITATIVE (no API/RPC/script can bypass it):
--   * bags.performance_fee_locked_at / performance_fee_bps_locked — set ONCE,
--     by trigger, when a non-creator position first holds shares > 0; the
--     locked rate is the current version's fee at that moment.
--   * bag_versions insert/update — a locked Bag can never get a version (or
--     a fee edit) whose fee differs from the locked rate; any version's fee
--     must be an integer 0..3000 bps (MAX_PERFORMANCE_FEE_BPS).
--   * bags update — the lock can never be cleared or altered, and
--     current_version_id can never be pointed at a version with another fee.
--   * apply_redeem_execution() — uses the LOCKED rate, not the caller's.
-- Creator-only activity (the creator buying into their own Bag) never locks.
-- The lock is permanent: it does not lift if every external investor later
-- redeems (simplest safe rule — no "unlock window" to reason about).
-- Forks are new Bags with their own, independent lock (see fork route).

alter table bags add column if not exists performance_fee_locked_at timestamptz;
alter table bags add column if not exists performance_fee_bps_locked integer;
alter table bags drop constraint if exists bags_performance_fee_lock_consistent;
alter table bags add constraint bags_performance_fee_lock_consistent check (
  (performance_fee_locked_at is null and performance_fee_bps_locked is null)
  or (performance_fee_locked_at is not null and performance_fee_bps_locked between 0 and 3000)
);

-- The ONE reader of a recipe's fee in SQL. Missing/null = 0 (the TS default).
-- Anything else must be an integer 0..3000 — the same bounds as
-- validateBasketRecipe() (MAX_PERFORMANCE_FEE_BPS), enforced here too so a
-- direct write cannot store a fee the application would refuse.
create or replace function recipe_performance_fee_bps(p_recipe jsonb) returns integer
language plpgsql
immutable
as $$
declare
  v_raw jsonb := p_recipe->'performanceFeeBps';
  v_num numeric;
begin
  if v_raw is null or jsonb_typeof(v_raw) = 'null' then
    return 0;
  end if;
  if jsonb_typeof(v_raw) <> 'number' then
    raise exception 'INVALID_PERFORMANCE_FEE: % is not a number', v_raw using errcode = 'check_violation';
  end if;
  v_num := (v_raw #>> '{}')::numeric;
  if v_num <> trunc(v_num) or v_num < 0 or v_num > 3000 then
    raise exception 'INVALID_PERFORMANCE_FEE: % (must be an integer 0..3000 bps)', v_num using errcode = 'check_violation';
  end if;
  return v_num::integer;
end;
$$;

-- Locks the fee the first time a NON-creator position holds shares.
create or replace function lock_performance_fee_on_external_position() returns trigger
language plpgsql
as $$
declare
  v_bag bags%rowtype;
  v_fee integer;
begin
  if NEW.shares_raw::numeric <= 0 then
    return NEW;
  end if;
  -- Row lock first (serializes with create_bag_version / direct version writes),
  -- THEN read the current version in a separate statement so it sees the latest
  -- committed current_version_id.
  select * into v_bag from bags where id = NEW.bag_id for update;
  if not found or v_bag.creator_id = NEW.user_id or v_bag.performance_fee_locked_at is not null then
    return NEW;
  end if;
  select recipe_performance_fee_bps(v.recipe) into v_fee from bag_versions v where v.id = v_bag.current_version_id;
  update bags
     set performance_fee_locked_at = now(),
         performance_fee_bps_locked = coalesce(v_fee, 0)
   where id = NEW.bag_id;
  return NEW;
end;
$$;

drop trigger if exists trg_lock_performance_fee_on_external_position on bag_investor_positions;
create trigger trg_lock_performance_fee_on_external_position
  after insert or update of shares_raw on bag_investor_positions
  for each row execute function lock_performance_fee_on_external_position();

create or replace function guard_performance_fee_lock_on_bags() returns trigger
language plpgsql
as $$
declare
  v_fee integer;
begin
  if OLD.performance_fee_locked_at is not null
     and (NEW.performance_fee_locked_at is distinct from OLD.performance_fee_locked_at
          or NEW.performance_fee_bps_locked is distinct from OLD.performance_fee_bps_locked) then
    raise exception 'PERFORMANCE_FEE_LOCKED: bag % performance fee lock is permanent', OLD.id using errcode = 'check_violation';
  end if;
  if NEW.performance_fee_locked_at is not null
     and (OLD.performance_fee_locked_at is null or NEW.current_version_id is distinct from OLD.current_version_id)
     and NEW.current_version_id is not null then
    select recipe_performance_fee_bps(recipe) into v_fee from bag_versions where id = NEW.current_version_id;
    if v_fee is distinct from NEW.performance_fee_bps_locked then
      raise exception 'PERFORMANCE_FEE_LOCKED: bag % fee is locked at % bps; version % carries % bps',
        NEW.id, NEW.performance_fee_bps_locked, NEW.current_version_id, v_fee using errcode = 'check_violation';
    end if;
  end if;
  return NEW;
end;
$$;

drop trigger if exists trg_guard_performance_fee_lock_on_bags on bags;
create trigger trg_guard_performance_fee_lock_on_bags
  before update on bags
  for each row execute function guard_performance_fee_lock_on_bags();

create or replace function guard_performance_fee_on_versions() returns trigger
language plpgsql
as $$
declare
  v_bag bags%rowtype;
  v_fee integer;
begin
  v_fee := recipe_performance_fee_bps(NEW.recipe); -- also validates the range
  select * into v_bag from bags where id = NEW.bag_id for update;
  if found and v_bag.performance_fee_locked_at is not null and v_fee <> v_bag.performance_fee_bps_locked then
    if TG_OP = 'INSERT' or recipe_performance_fee_bps(OLD.recipe) <> v_fee then
      raise exception 'PERFORMANCE_FEE_LOCKED: bag % fee is locked at % bps (an external investor exists); refusing % bps',
        NEW.bag_id, v_bag.performance_fee_bps_locked, v_fee using errcode = 'check_violation';
    end if;
  end if;
  return NEW;
end;
$$;

drop trigger if exists trg_guard_performance_fee_on_versions on bag_versions;
create trigger trg_guard_performance_fee_on_versions
  before insert or update on bag_versions
  for each row execute function guard_performance_fee_on_versions();

-- Backfill: any Bag that ALREADY has a non-creator position with shares is locked
-- at its current version's fee (an external investment already happened).
update bags b
   set performance_fee_locked_at = now(),
       performance_fee_bps_locked = coalesce((select recipe_performance_fee_bps(v.recipe) from bag_versions v where v.id = b.current_version_id), 0)
 where b.performance_fee_locked_at is null
   and exists (
     select 1 from bag_investor_positions p
      where p.bag_id = b.id and p.user_id <> b.creator_id and p.shares_raw::numeric > 0
   );

-- apply_redeem_execution: 0018's body, with the fee rate taken from the lock.
create or replace function apply_redeem_execution(
  p_intent_id uuid,
  p_bag_id uuid,
  p_holdings_sold jsonb,
  p_shares_burn_raw text,
  p_share_decimals integer,
  p_user_id uuid,
  p_redeem_value_quote text default '0',
  p_performance_fee_bps integer default 0,
  p_creator_id uuid default null
) returns jsonb
language plpgsql
as $$
declare
  v_already_applied timestamptz;
  v_position bag_investor_positions%rowtype;
  v_new_shares numeric;
  v_new_cost_basis numeric;
  v_consumed_cost_basis numeric;
  v_profit numeric;
  v_fee_amount numeric;
  v_fee_bps integer;
  v_fee_activity_id uuid;
  v_creator_wallet text;
  v_result jsonb;
  h jsonb;
  v_chain text;
  v_address text;
  v_qty numeric;
  v_row_count integer;
begin
  select accounting_applied_at into v_already_applied
  from redeem_intents
  where id = p_intent_id
  for update;

  if v_already_applied is not null then
    select jsonb_build_object(
      'alreadyApplied', true,
      'holdings', coalesce((select jsonb_agg(to_jsonb(bh.*)) from bag_holdings bh where bh.bag_id = p_bag_id), '[]'::jsonb),
      'shareState', (select to_jsonb(s.*) from bag_share_state s where s.bag_id = p_bag_id),
      'investorPosition', (select to_jsonb(p.*) from bag_investor_positions p where p.bag_id = p_bag_id and p.user_id = p_user_id),
      'feeActivityId', null,
      'feeAmount', null
    ) into v_result;
    return v_result;
  end if;

  select * into v_position
  from bag_investor_positions
  where user_id = p_user_id and bag_id = p_bag_id
  for update;

  if not found or v_position.shares_raw::numeric < p_shares_burn_raw::numeric then
    raise exception 'INSUFFICIENT_SHARES: user % bag % has % raw shares, tried to burn %',
      p_user_id, p_bag_id, coalesce(v_position.shares_raw, '0'), p_shares_burn_raw;
  end if;

  v_new_shares := v_position.shares_raw::numeric - p_shares_burn_raw::numeric;
  v_new_cost_basis := case
    when v_position.shares_raw::numeric = 0 then 0
    else v_position.cost_basis_quote::numeric * v_new_shares / v_position.shares_raw::numeric
  end;

  v_consumed_cost_basis := v_position.cost_basis_quote::numeric - v_new_cost_basis;
  v_profit := p_redeem_value_quote::numeric - v_consumed_cost_basis;

  update bag_investor_positions
  set shares_raw = v_new_shares::text,
      cost_basis_quote = v_new_cost_basis::text,
      updated_at = now()
  where user_id = p_user_id and bag_id = p_bag_id;

  update bag_share_state
  set total_shares_raw = (total_shares_raw::numeric - p_shares_burn_raw::numeric)::text,
      updated_at = now()
  where bag_id = p_bag_id;

  for h in select * from jsonb_array_elements(p_holdings_sold) loop
    v_chain := h->>'chain';
    v_address := h->>'address';
    v_qty := (h->>'quantity_raw')::numeric;

    update bag_holdings
    set quantity_raw = (quantity_raw::numeric - v_qty)::text, updated_at = now()
    where bag_id = p_bag_id and chain = v_chain and address = v_address
      and quantity_raw::numeric >= v_qty;
    get diagnostics v_row_count = row_count;
    if v_row_count = 0 then
      raise exception 'HOLDINGS_UNDERFLOW: bag % chain % address % cannot sell % (stale allocation)',
        p_bag_id, v_chain, v_address, v_qty;
    end if;

    update bag_investor_holdings
    set quantity_raw = (quantity_raw::numeric - v_qty)::text, updated_at = now()
    where user_id = p_user_id and bag_id = p_bag_id and chain = v_chain and address = v_address
      and quantity_raw::numeric >= v_qty;
    get diagnostics v_row_count = row_count;
    if v_row_count = 0 then
      raise exception 'INVESTOR_HOLDINGS_UNDERFLOW: user % bag % chain % address % cannot sell % (stale allocation)',
        p_user_id, p_bag_id, v_chain, v_address, v_qty;
    end if;
  end loop;

  -- P0 FIX (0018): performance fee no longer touches `portfolios.cash_balance`
  -- — it now gets the SAME atomic creator_reward_settlements treatment
  -- fork royalty already has (0017), using `p_intent_id` directly as
  -- `source_redeem_intent_id` (a real FK this function already holds, no
  -- correlation trick needed — contrast migration 0015's legacy backfill).
  -- Never charged on a loss (v_profit <= 0), never charged to a creator
  -- redeeming their own bag — unchanged from the original rule.
  -- 0033: the fee RATE is the bag's LOCKED rate once the first external
  -- investor exists (always the case when a non-creator is redeeming — a
  -- redeemer holds shares, and holding shares locked the fee). The caller's
  -- p_performance_fee_bps is only a fallback for a never-locked bag, where
  -- no fee-bearing (non-creator) redemption can exist anyway.
  select coalesce(performance_fee_bps_locked, p_performance_fee_bps) into v_fee_bps from bags where id = p_bag_id;

  if p_creator_id is not null and p_creator_id <> p_user_id and v_fee_bps > 0 and v_profit > 0 then
    v_fee_amount := round(v_profit * v_fee_bps / 10000.0, 2);
    if v_fee_amount > 0 then
      insert into activities (user_id, action)
      values (p_creator_id, 'PERFORMANCE_FEE_EARNED:' || v_fee_amount::text || ':' || p_bag_id::text)
      returning id into v_fee_activity_id;

      select wallet_address into v_creator_wallet from users where id = p_creator_id;
      if v_creator_wallet is null then
        raise exception 'PERFORMANCE_FEE_SETTLEMENT_NO_WALLET: creator % has no wallet_address on file — cannot record a settleable fee', p_creator_id;
      end if;

      insert into creator_reward_settlements (
        creator_id, creator_wallet, bag_id, reward_type,
        source_activity_id, source_redeem_intent_id,
        gross_amount_quote, reward_amount_token_raw,
        reward_token_address, reward_token_decimals, reward_chain_id,
        status
      ) values (
        p_creator_id, v_creator_wallet, p_bag_id, 'PERFORMANCE_FEE',
        v_fee_activity_id, p_intent_id,
        v_fee_amount::text, floor(v_fee_amount * 1000000)::text,
        '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', 6, 4663,
        'EARNED'
      );
    end if;
  end if;

  update redeem_intents
  set accounting_applied_at = now()
  where id = p_intent_id;

  insert into activities (user_id, action)
  values (p_user_id, 'REDEEM_EXECUTED:' || p_intent_id::text || ':' || p_bag_id::text);

  select jsonb_build_object(
    'alreadyApplied', false,
    'holdings', coalesce((select jsonb_agg(to_jsonb(bh.*)) from bag_holdings bh where bh.bag_id = p_bag_id), '[]'::jsonb),
    'shareState', (select to_jsonb(s.*) from bag_share_state s where s.bag_id = p_bag_id),
    'investorPosition', (select to_jsonb(p.*) from bag_investor_positions p where p.bag_id = p_bag_id and p.user_id = p_user_id),
    'feeActivityId', v_fee_activity_id,
    'feeAmount', v_fee_amount
  ) into v_result;

  return v_result;
end;
$$;


revoke execute on function apply_redeem_execution(uuid, uuid, jsonb, text, integer, uuid, text, integer, uuid) from public;
grant execute on function apply_redeem_execution(uuid, uuid, jsonb, text, integer, uuid, text, integer, uuid) to service_role;

do $$
declare
  v_sig text;
begin
  foreach v_sig in array array[
    'recipe_performance_fee_bps(jsonb)',
    'lock_performance_fee_on_external_position()',
    'guard_performance_fee_lock_on_bags()',
    'guard_performance_fee_on_versions()',
    'apply_redeem_execution(uuid, uuid, jsonb, text, integer, uuid, text, integer, uuid)'
  ] loop
    execute format('revoke execute on function %s from public', v_sig);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke execute on function %s from anon', v_sig); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke execute on function %s from authenticated', v_sig); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', v_sig); end if;
  end loop;
end $$;

-- 0035_onchain_bag_versioning.sql
--
-- End-to-end MUTABLE Bag versioning for DEPLOYED Bags: a new version is
-- recorded on-chain by the creator's OWN wallet
-- (BagFactory.recordBagVersion → Bag.recordVersion) and only then, after the
-- server has verified the receipt, recorded here atomically.
--
-- Invariants:
--   * A DEPLOYED Bag's versions only ever change through
--     record_onchain_bag_version() — create_bag_version() (off-chain only)
--     refuses a deployed Bag, so the database can never move ahead of the chain.
--   * create_bag_version() and record_onchain_bag_version() both refuse an
--     IMMUTABLE Bag (the application already did; now the database does too).
--   * bag_deployments.on_chain_version mirrors Bag.version() — 1 at deploy,
--     +1 per recorded version — and record_onchain_bag_version() is a
--     compare-and-swap on it (serializes racing updates; the contract's own
--     expectedCurrentVersion guard serializes them on-chain the same way).
--   * One transaction hash records at most one version (unique onchain_tx_hash):
--     a repeated confirm is idempotent (ALREADY_CONFIRMED), never a second row.
--   * The performance-fee lock (0033) still applies: if the fee locked between
--     prepare and confirm, the already-mined on-chain version (which commits to
--     the composition only, never the fee) is recorded with the LOCKED fee and
--     the result says so (feeLockedOverride) — chain and database never diverge.

alter table bag_deployments add column if not exists on_chain_version integer not null default 1;
alter table bag_deployments drop constraint if exists bag_deployments_on_chain_version_positive;
alter table bag_deployments add constraint bag_deployments_on_chain_version_positive check (on_chain_version >= 1);

alter table bag_versions add column if not exists onchain_tx_hash text;
alter table bag_versions add column if not exists onchain_version integer;
alter table bag_versions add column if not exists onchain_composition_hash text;
alter table bag_versions add column if not exists metadata_uri text;
alter table bag_versions drop constraint if exists bag_versions_onchain_tx_hash_format;
alter table bag_versions add constraint bag_versions_onchain_tx_hash_format check (onchain_tx_hash is null or onchain_tx_hash ~ '^0x[0-9a-f]{64}$');
alter table bag_versions drop constraint if exists bag_versions_onchain_fields_together;
alter table bag_versions add constraint bag_versions_onchain_fields_together check (
  (onchain_tx_hash is null and onchain_version is null and onchain_composition_hash is null)
  or (onchain_tx_hash is not null and onchain_version >= 2 and onchain_composition_hash ~ '^0x[0-9a-f]{64}$')
);
create unique index if not exists bag_versions_onchain_tx_hash_key on bag_versions(onchain_tx_hash) where onchain_tx_hash is not null;

-- Off-chain versioning: only for Bags that are NOT deployed, and never for IMMUTABLE ones.
create or replace function create_bag_version(
  p_bag_id uuid,
  p_composition_hash text,
  p_recipe jsonb,
  p_created_by uuid,
  p_reason text
) returns jsonb
language plpgsql
as $$
declare
  v_next_version integer;
  v_mutability text;
  v_version_id uuid;
  v_recipe jsonb;
  v_bag jsonb;
  v_version jsonb;
begin
  select current_version + 1, mutability into v_next_version, v_mutability
  from bags
  where id = p_bag_id
  for update;

  if v_next_version is null then
    raise exception 'bag % not found', p_bag_id;
  end if;
  if v_mutability = 'IMMUTABLE' then
    raise exception 'IMMUTABLE_BAG: bag % composition cannot change', p_bag_id using errcode = 'check_violation';
  end if;
  if exists (select 1 from bag_deployments where bag_id = p_bag_id and status = 'DEPLOYED') then
    raise exception 'DEPLOYED_BAG_REQUIRES_ONCHAIN_VERSION: bag % is deployed; record the version on-chain (record_onchain_bag_version)', p_bag_id
      using errcode = 'check_violation';
  end if;

  v_recipe := p_recipe || jsonb_build_object(
    'version', v_next_version,
    'id', 'recipe_' || p_bag_id::text || '_v' || v_next_version::text
  );

  insert into bag_versions (bag_id, version, composition_hash, recipe, created_by, reason)
  values (p_bag_id, v_next_version, p_composition_hash, v_recipe, p_created_by, p_reason)
  returning id into v_version_id;

  update bags
  set current_version = v_next_version, current_version_id = v_version_id, updated_at = now()
  where id = p_bag_id
  returning to_jsonb(bags.*) into v_bag;

  select to_jsonb(bag_versions.*) into v_version from bag_versions where id = v_version_id;

  return jsonb_build_object('bag', v_bag, 'version', v_version);
end;
$$;

-- Records a version the creator's wallet ALREADY recorded on-chain (the server
-- verified the receipt first). Everything is re-checked here under the Bag's
-- row lock; nothing is written unless every check passes.
create or replace function record_onchain_bag_version(
  p_bag_id uuid,
  p_creator_id uuid,
  p_factory_address text,
  p_contract_address text,
  p_on_chain_bag_id text,
  p_expected_onchain_version integer,
  p_new_onchain_version integer,
  p_composition_hash text,
  p_onchain_composition_hash text,
  p_metadata_uri text,
  p_recipe jsonb,
  p_tx_hash text,
  p_reason text
) returns jsonb
language plpgsql
as $$
declare
  v_tx text := lower(p_tx_hash);
  v_bag bags%rowtype;
  v_dep bag_deployments%rowtype;
  v_existing bag_versions%rowtype;
  v_next_version integer;
  v_recipe jsonb;
  v_fee_override boolean := false;
  v_version_id uuid;
  v_bag_json jsonb;
  v_version_json jsonb;
begin
  if v_tx !~ '^0x[0-9a-f]{64}$' then
    raise exception 'record_onchain_bag_version: malformed tx_hash' using errcode = 'invalid_parameter_value';
  end if;
  if lower(p_onchain_composition_hash) !~ '^0x[0-9a-f]{64}$' then
    raise exception 'record_onchain_bag_version: malformed onchain composition hash' using errcode = 'invalid_parameter_value';
  end if;

  select * into v_bag from bags where id = p_bag_id for update;
  if not found then return jsonb_build_object('outcome', 'BAG_NOT_FOUND'); end if;
  if v_bag.creator_id is distinct from p_creator_id then return jsonb_build_object('outcome', 'FORBIDDEN'); end if;

  -- Idempotency: this transaction already produced a version.
  select * into v_existing from bag_versions where onchain_tx_hash = v_tx;
  if found then
    if v_existing.bag_id = p_bag_id then
      return jsonb_build_object('outcome', 'ALREADY_CONFIRMED', 'bag', to_jsonb(v_bag), 'version', to_jsonb(v_existing));
    end if;
    return jsonb_build_object('outcome', 'TX_ALREADY_USED');
  end if;

  if v_bag.mutability = 'IMMUTABLE' then return jsonb_build_object('outcome', 'IMMUTABLE_BAG'); end if;
  if v_bag.status = 'ARCHIVED' then return jsonb_build_object('outcome', 'BAG_ARCHIVED'); end if;

  select * into v_dep from bag_deployments where bag_id = p_bag_id and status = 'DEPLOYED' for update;
  if not found then return jsonb_build_object('outcome', 'NOT_DEPLOYED'); end if;
  if lower(v_dep.contract_address) is distinct from lower(p_contract_address)
     or lower(v_dep.on_chain_bag_id) is distinct from lower(p_on_chain_bag_id)
     or lower(v_dep.factory_address) is distinct from lower(p_factory_address) then
    return jsonb_build_object('outcome', 'DEPLOYMENT_MISMATCH');
  end if;

  -- Compare-and-swap on the on-chain version counter.
  if v_dep.on_chain_version <> p_expected_onchain_version or p_new_onchain_version <> p_expected_onchain_version + 1 then
    return jsonb_build_object('outcome', 'STALE_VERSION', 'onChainVersion', v_dep.on_chain_version);
  end if;

  v_next_version := v_bag.current_version + 1;
  v_recipe := p_recipe || jsonb_build_object('version', v_next_version, 'id', 'recipe_' || p_bag_id::text || '_v' || v_next_version::text);
  if v_bag.performance_fee_locked_at is not null and recipe_performance_fee_bps(v_recipe) <> v_bag.performance_fee_bps_locked then
    v_recipe := v_recipe || jsonb_build_object('performanceFeeBps', v_bag.performance_fee_bps_locked);
    v_fee_override := true;
  end if;

  insert into bag_versions (bag_id, version, composition_hash, recipe, created_by, reason,
                            onchain_tx_hash, onchain_version, onchain_composition_hash, metadata_uri)
  values (p_bag_id, v_next_version, p_composition_hash, v_recipe, p_creator_id, p_reason,
          v_tx, p_new_onchain_version, lower(p_onchain_composition_hash), p_metadata_uri)
  returning id into v_version_id;

  update bags
     set current_version = v_next_version, current_version_id = v_version_id, updated_at = now()
   where id = p_bag_id
  returning to_jsonb(bags.*) into v_bag_json;

  update bag_deployments set on_chain_version = p_new_onchain_version, updated_at = now() where id = v_dep.id;

  select to_jsonb(bag_versions.*) into v_version_json from bag_versions where id = v_version_id;
  return jsonb_build_object('outcome', 'CONFIRMED', 'bag', v_bag_json, 'version', v_version_json, 'feeLockedOverride', v_fee_override);
end;
$$;

do $$
declare
  v_sig text;
begin
  foreach v_sig in array array[
    'create_bag_version(uuid, text, jsonb, uuid, text)',
    'record_onchain_bag_version(uuid, uuid, text, text, text, integer, integer, text, text, text, jsonb, text, text)'
  ] loop
    execute format('revoke execute on function %s from public', v_sig);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke execute on function %s from anon', v_sig); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke execute on function %s from authenticated', v_sig); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', v_sig); end if;
  end loop;
end $$;

-- 0036_accounting_invariant_guards.sql
--
-- Economic-invariant audit fixes (see docs/PROTOCOL_ECONOMICS.md, section 3).
-- Only clear invariant violations are fixed; no formula is changed for taste.
--
-- A. apply_purchase_execution / apply_redeem_execution /
--    apply_redeem_execution_router_settled accepted ANY intent status: a
--    FAILED / EXPIRED / CANCELLED / PARTIAL_SUCCESS / RECONCILIATION_REQUIRED
--    intent could mint or burn shares if called. Now refused
--    (INTENT_NOT_EXECUTABLE). Accounting is applied while an intent is still
--    SUBMITTED/CONFIRMING (before the COMPLETED transition), so those remain
--    allowed; expiry only ever happens BEFORE execution starts.
-- B. An unknown intent id was accounted with no idempotency row (every retry
--    minted again), and the intent's own user/bag were never compared with
--    the caller's. Now INTENT_NOT_FOUND / INTENT_MISMATCH.
-- C. apply_redeem_execution_router_settled had no share or holdings
--    underflow guard (shares and holdings could go negative). Now the same
--    INSUFFICIENT_SHARES / HOLDINGS_UNDERFLOW guards as the LI.FI path.
-- D. The router path rounded the consumed cost basis to 2 decimals even on a
--    FULL redemption, leaving residual basis on a 0-share position. A full
--    redemption now consumes the whole basis.
-- Also: non-positive share deltas and negative values/holdings deltas are refused.

create or replace function apply_purchase_execution(
  p_intent_id uuid,
  p_bag_id uuid,
  p_holdings jsonb,
  p_shares_delta_raw text,
  p_share_decimals integer,
  p_user_id uuid,
  p_cost_basis_delta text default '0',
  p_fork_royalty_bps integer default 0,
  p_root_creator_id uuid default null
) returns jsonb
language plpgsql
as $$
declare
  v_already_applied timestamptz;
  v_intent_user uuid;
  v_intent_bag uuid;
  v_intent_status text;
  v_result jsonb;
  v_royalty_amount numeric;
  v_royalty_activity_id uuid;
  v_root_creator_wallet text;
begin
  -- 0036: the intent must exist and belong to exactly this (user, bag) — an
  -- unknown id used to be accounted with NO idempotency row, so every retry
  -- minted/burned again.
  select accounting_applied_at, user_id, bag_id, status
    into v_already_applied, v_intent_user, v_intent_bag, v_intent_status
  from purchase_intents
  where id = p_intent_id
  for update;
  if not found then
    raise exception 'INTENT_NOT_FOUND: purchase intent %', p_intent_id using errcode = 'no_data_found';
  end if;
  if v_intent_user is distinct from p_user_id or v_intent_bag is distinct from p_bag_id then
    raise exception 'INTENT_MISMATCH: purchase intent % belongs to user % bag %, not user % bag %',
      p_intent_id, v_intent_user, v_intent_bag, p_user_id, p_bag_id using errcode = 'check_violation';
  end if;

  if v_already_applied is not null then
    select jsonb_build_object(
      'alreadyApplied', true,
      'holdings', coalesce((select jsonb_agg(to_jsonb(bh.*)) from bag_holdings bh where bh.bag_id = p_bag_id), '[]'::jsonb),
      'shareState', (select to_jsonb(s.*) from bag_share_state s where s.bag_id = p_bag_id),
      'investorPosition', (select to_jsonb(p.*) from bag_investor_positions p where p.bag_id = p_bag_id and p.user_id = p_user_id),
      'royaltyActivityId', null,
      'royaltyAmount', null
    ) into v_result;
    return v_result;
  end if;

  -- 0036: a failed / expired / cancelled / partially-executed intent never
  -- produces full accounting (no share mint, no share burn), whatever the caller says.
  if v_intent_status in ('FAILED', 'EXPIRED', 'CANCELLED', 'PARTIAL_SUCCESS', 'RECONCILIATION_REQUIRED') then
    raise exception 'INTENT_NOT_EXECUTABLE: purchase intent % is %', p_intent_id, v_intent_status using errcode = 'check_violation';
  end if;
  if p_shares_delta_raw::numeric <= 0 or p_cost_basis_delta::numeric < 0
     or exists (select 1 from jsonb_array_elements(p_holdings) h where (h->>'delta_raw')::numeric < 0) then
    raise exception 'INVALID_ACCOUNTING_DELTA: shares %, cost basis %, holdings must be positive/non-negative', p_shares_delta_raw, p_cost_basis_delta
      using errcode = 'check_violation';
  end if;

  insert into bag_holdings (bag_id, chain, address, quantity_raw, decimals)
  select
    p_bag_id,
    (h->>'chain')::text,
    (h->>'address')::text,
    (h->>'delta_raw')::text,
    (h->>'decimals')::integer
  from jsonb_array_elements(p_holdings) as h
  on conflict (bag_id, chain, address) do update
    set quantity_raw = (bag_holdings.quantity_raw::numeric + excluded.quantity_raw::numeric)::text,
        updated_at = now();

  insert into bag_investor_holdings (user_id, bag_id, chain, address, quantity_raw, decimals)
  select
    p_user_id,
    p_bag_id,
    (h->>'chain')::text,
    (h->>'address')::text,
    (h->>'delta_raw')::text,
    (h->>'decimals')::integer
  from jsonb_array_elements(p_holdings) as h
  on conflict (user_id, bag_id, chain, address) do update
    set quantity_raw = (bag_investor_holdings.quantity_raw::numeric + excluded.quantity_raw::numeric)::text,
        updated_at = now();

  insert into bag_share_state (bag_id, total_shares_raw, share_decimals)
  values (p_bag_id, p_shares_delta_raw, p_share_decimals)
  on conflict (bag_id) do update
    set total_shares_raw = (bag_share_state.total_shares_raw::numeric + excluded.total_shares_raw::numeric)::text,
        updated_at = now();

  insert into bag_investor_positions (user_id, bag_id, shares_raw, share_decimals, cost_basis_quote)
  values (p_user_id, p_bag_id, p_shares_delta_raw, p_share_decimals, p_cost_basis_delta)
  on conflict (user_id, bag_id) do update
    set shares_raw = (bag_investor_positions.shares_raw::numeric + excluded.shares_raw::numeric)::text,
        cost_basis_quote = (bag_investor_positions.cost_basis_quote::numeric + excluded.cost_basis_quote::numeric)::text,
        updated_at = now();

  if p_root_creator_id is not null and p_root_creator_id <> p_user_id and p_fork_royalty_bps > 0 and p_cost_basis_delta::numeric > 0 then
    v_royalty_amount := round(p_cost_basis_delta::numeric * p_fork_royalty_bps / 10000.0, 2);
    if v_royalty_amount > 0 then
      -- P0 FIX (0018): no `portfolios.cash_balance` mutation here anymore
      -- — see this migration's module doc. The activities row + the
      -- creator_reward_settlements insert below are the ONLY records of
      -- this royalty; CreatorRewardsVault.balanceOf is the only place
      -- it's ever spendable.
      insert into activities (user_id, action)
      values (p_root_creator_id, 'FORK_ROYALTY_EARNED:' || v_royalty_amount::text || ':' || p_bag_id::text)
      returning id into v_royalty_activity_id;

      select wallet_address into v_root_creator_wallet from users where id = p_root_creator_id;
      if v_root_creator_wallet is null then
        raise exception 'FORK_ROYALTY_SETTLEMENT_NO_WALLET: root creator % has no wallet_address on file — cannot record a settleable royalty', p_root_creator_id;
      end if;

      insert into creator_reward_settlements (
        creator_id, creator_wallet, bag_id, reward_type,
        source_activity_id, gross_amount_quote, reward_amount_token_raw,
        reward_token_address, reward_token_decimals, reward_chain_id,
        status
      ) values (
        p_root_creator_id, v_root_creator_wallet, p_bag_id, 'FORK_ROYALTY',
        v_royalty_activity_id, v_royalty_amount::text,
        floor(v_royalty_amount * 1000000)::text,
        '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', 6, 4663,
        'EARNED'
      );
    end if;
  end if;

  update purchase_intents
  set accounting_applied_at = now()
  where id = p_intent_id;

  insert into activities (user_id, action)
  values (p_user_id, 'PURCHASE_EXECUTED:' || p_intent_id::text || ':' || p_bag_id::text);

  select jsonb_build_object(
    'alreadyApplied', false,
    'holdings', coalesce((select jsonb_agg(to_jsonb(bh.*)) from bag_holdings bh where bh.bag_id = p_bag_id), '[]'::jsonb),
    'shareState', (select to_jsonb(s.*) from bag_share_state s where s.bag_id = p_bag_id),
    'investorPosition', (select to_jsonb(p.*) from bag_investor_positions p where p.bag_id = p_bag_id and p.user_id = p_user_id),
    'royaltyActivityId', v_royalty_activity_id,
    'royaltyAmount', v_royalty_amount
  ) into v_result;

  return v_result;
end;
$$;

create or replace function apply_redeem_execution(
  p_intent_id uuid,
  p_bag_id uuid,
  p_holdings_sold jsonb,
  p_shares_burn_raw text,
  p_share_decimals integer,
  p_user_id uuid,
  p_redeem_value_quote text default '0',
  p_performance_fee_bps integer default 0,
  p_creator_id uuid default null
) returns jsonb
language plpgsql
as $$
declare
  v_already_applied timestamptz;
  v_intent_user uuid;
  v_intent_bag uuid;
  v_intent_status text;
  v_position bag_investor_positions%rowtype;
  v_new_shares numeric;
  v_new_cost_basis numeric;
  v_consumed_cost_basis numeric;
  v_profit numeric;
  v_fee_amount numeric;
  v_fee_bps integer;
  v_fee_activity_id uuid;
  v_creator_wallet text;
  v_result jsonb;
  h jsonb;
  v_chain text;
  v_address text;
  v_qty numeric;
  v_row_count integer;
begin
  -- 0036: the intent must exist and belong to exactly this (user, bag) — an
  -- unknown id used to be accounted with NO idempotency row, so every retry
  -- minted/burned again.
  select accounting_applied_at, user_id, bag_id, status
    into v_already_applied, v_intent_user, v_intent_bag, v_intent_status
  from redeem_intents
  where id = p_intent_id
  for update;
  if not found then
    raise exception 'INTENT_NOT_FOUND: redeem intent %', p_intent_id using errcode = 'no_data_found';
  end if;
  if v_intent_user is distinct from p_user_id or v_intent_bag is distinct from p_bag_id then
    raise exception 'INTENT_MISMATCH: redeem intent % belongs to user % bag %, not user % bag %',
      p_intent_id, v_intent_user, v_intent_bag, p_user_id, p_bag_id using errcode = 'check_violation';
  end if;

  if v_already_applied is not null then
    select jsonb_build_object(
      'alreadyApplied', true,
      'holdings', coalesce((select jsonb_agg(to_jsonb(bh.*)) from bag_holdings bh where bh.bag_id = p_bag_id), '[]'::jsonb),
      'shareState', (select to_jsonb(s.*) from bag_share_state s where s.bag_id = p_bag_id),
      'investorPosition', (select to_jsonb(p.*) from bag_investor_positions p where p.bag_id = p_bag_id and p.user_id = p_user_id),
      'feeActivityId', null,
      'feeAmount', null
    ) into v_result;
    return v_result;
  end if;

  -- 0036: a failed / expired / cancelled / partially-executed intent never
  -- produces full accounting (no share mint, no share burn), whatever the caller says.
  if v_intent_status in ('FAILED', 'EXPIRED', 'CANCELLED', 'PARTIAL_SUCCESS', 'RECONCILIATION_REQUIRED') then
    raise exception 'INTENT_NOT_EXECUTABLE: redeem intent % is %', p_intent_id, v_intent_status using errcode = 'check_violation';
  end if;
  if p_shares_burn_raw::numeric <= 0 or p_redeem_value_quote::numeric < 0 then
    raise exception 'INVALID_ACCOUNTING_DELTA: burn %, value % must be positive/non-negative', p_shares_burn_raw, p_redeem_value_quote
      using errcode = 'check_violation';
  end if;

  select * into v_position
  from bag_investor_positions
  where user_id = p_user_id and bag_id = p_bag_id
  for update;

  if not found or v_position.shares_raw::numeric < p_shares_burn_raw::numeric then
    raise exception 'INSUFFICIENT_SHARES: user % bag % has % raw shares, tried to burn %',
      p_user_id, p_bag_id, coalesce(v_position.shares_raw, '0'), p_shares_burn_raw;
  end if;

  v_new_shares := v_position.shares_raw::numeric - p_shares_burn_raw::numeric;
  v_new_cost_basis := case
    when v_position.shares_raw::numeric = 0 then 0
    else v_position.cost_basis_quote::numeric * v_new_shares / v_position.shares_raw::numeric
  end;

  v_consumed_cost_basis := v_position.cost_basis_quote::numeric - v_new_cost_basis;
  v_profit := p_redeem_value_quote::numeric - v_consumed_cost_basis;

  update bag_investor_positions
  set shares_raw = v_new_shares::text,
      cost_basis_quote = v_new_cost_basis::text,
      updated_at = now()
  where user_id = p_user_id and bag_id = p_bag_id;

  update bag_share_state
  set total_shares_raw = (total_shares_raw::numeric - p_shares_burn_raw::numeric)::text,
      updated_at = now()
  where bag_id = p_bag_id;

  for h in select * from jsonb_array_elements(p_holdings_sold) loop
    v_chain := h->>'chain';
    v_address := h->>'address';
    v_qty := (h->>'quantity_raw')::numeric;

    update bag_holdings
    set quantity_raw = (quantity_raw::numeric - v_qty)::text, updated_at = now()
    where bag_id = p_bag_id and chain = v_chain and address = v_address
      and quantity_raw::numeric >= v_qty;
    get diagnostics v_row_count = row_count;
    if v_row_count = 0 then
      raise exception 'HOLDINGS_UNDERFLOW: bag % chain % address % cannot sell % (stale allocation)',
        p_bag_id, v_chain, v_address, v_qty;
    end if;

    update bag_investor_holdings
    set quantity_raw = (quantity_raw::numeric - v_qty)::text, updated_at = now()
    where user_id = p_user_id and bag_id = p_bag_id and chain = v_chain and address = v_address
      and quantity_raw::numeric >= v_qty;
    get diagnostics v_row_count = row_count;
    if v_row_count = 0 then
      raise exception 'INVESTOR_HOLDINGS_UNDERFLOW: user % bag % chain % address % cannot sell % (stale allocation)',
        p_user_id, p_bag_id, v_chain, v_address, v_qty;
    end if;
  end loop;

  -- P0 FIX (0018): performance fee no longer touches `portfolios.cash_balance`
  -- — it now gets the SAME atomic creator_reward_settlements treatment
  -- fork royalty already has (0017), using `p_intent_id` directly as
  -- `source_redeem_intent_id` (a real FK this function already holds, no
  -- correlation trick needed — contrast migration 0015's legacy backfill).
  -- Never charged on a loss (v_profit <= 0), never charged to a creator
  -- redeeming their own bag — unchanged from the original rule.
  -- 0033: the fee RATE is the bag's LOCKED rate once the first external
  -- investor exists (always the case when a non-creator is redeeming — a
  -- redeemer holds shares, and holding shares locked the fee). The caller's
  -- p_performance_fee_bps is only a fallback for a never-locked bag, where
  -- no fee-bearing (non-creator) redemption can exist anyway.
  select coalesce(performance_fee_bps_locked, p_performance_fee_bps) into v_fee_bps from bags where id = p_bag_id;

  if p_creator_id is not null and p_creator_id <> p_user_id and v_fee_bps > 0 and v_profit > 0 then
    v_fee_amount := round(v_profit * v_fee_bps / 10000.0, 2);
    if v_fee_amount > 0 then
      insert into activities (user_id, action)
      values (p_creator_id, 'PERFORMANCE_FEE_EARNED:' || v_fee_amount::text || ':' || p_bag_id::text)
      returning id into v_fee_activity_id;

      select wallet_address into v_creator_wallet from users where id = p_creator_id;
      if v_creator_wallet is null then
        raise exception 'PERFORMANCE_FEE_SETTLEMENT_NO_WALLET: creator % has no wallet_address on file — cannot record a settleable fee', p_creator_id;
      end if;

      insert into creator_reward_settlements (
        creator_id, creator_wallet, bag_id, reward_type,
        source_activity_id, source_redeem_intent_id,
        gross_amount_quote, reward_amount_token_raw,
        reward_token_address, reward_token_decimals, reward_chain_id,
        status
      ) values (
        p_creator_id, v_creator_wallet, p_bag_id, 'PERFORMANCE_FEE',
        v_fee_activity_id, p_intent_id,
        v_fee_amount::text, floor(v_fee_amount * 1000000)::text,
        '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', 6, 4663,
        'EARNED'
      );
    end if;
  end if;

  update redeem_intents
  set accounting_applied_at = now()
  where id = p_intent_id;

  insert into activities (user_id, action)
  values (p_user_id, 'REDEEM_EXECUTED:' || p_intent_id::text || ':' || p_bag_id::text);

  select jsonb_build_object(
    'alreadyApplied', false,
    'holdings', coalesce((select jsonb_agg(to_jsonb(bh.*)) from bag_holdings bh where bh.bag_id = p_bag_id), '[]'::jsonb),
    'shareState', (select to_jsonb(s.*) from bag_share_state s where s.bag_id = p_bag_id),
    'investorPosition', (select to_jsonb(p.*) from bag_investor_positions p where p.bag_id = p_bag_id and p.user_id = p_user_id),
    'feeActivityId', v_fee_activity_id,
    'feeAmount', v_fee_amount
  ) into v_result;

  return v_result;
end;
$$;

create or replace function apply_redeem_execution_router_settled(
  p_intent_id uuid,
  p_bag_id uuid,
  p_holdings_sold jsonb,
  p_shares_burn_raw text,
  p_share_decimals integer,
  p_user_id uuid,
  p_redeem_value_quote text,
  p_creator_id uuid,
  p_creator_wallet text,
  p_fee_amount_quote text,
  p_fee_amount_token_raw text,
  p_onchain_tx_hash text,
  p_redemption_id_hex text
) returns jsonb
language plpgsql
as $$
declare
  v_already_applied timestamptz;
  v_intent_user uuid;
  v_intent_bag uuid;
  v_intent_status text;
  v_position bag_investor_positions%rowtype;
  v_new_shares numeric;
  v_new_cost_basis numeric;
  v_consumed_cost_basis numeric;
  v_profit numeric;
  v_result jsonb;
  h jsonb;
  v_chain text;
  v_address text;
  v_qty numeric;
  v_row_count integer;
begin
  -- 0036: the intent must exist and belong to exactly this (user, bag) — an
  -- unknown id used to be accounted with NO idempotency row, so every retry
  -- minted/burned again.
  select accounting_applied_at, user_id, bag_id, status
    into v_already_applied, v_intent_user, v_intent_bag, v_intent_status
  from redeem_intents
  where id = p_intent_id
  for update;
  if not found then
    raise exception 'INTENT_NOT_FOUND: redeem intent %', p_intent_id using errcode = 'no_data_found';
  end if;
  if v_intent_user is distinct from p_user_id or v_intent_bag is distinct from p_bag_id then
    raise exception 'INTENT_MISMATCH: redeem intent % belongs to user % bag %, not user % bag %',
      p_intent_id, v_intent_user, v_intent_bag, p_user_id, p_bag_id using errcode = 'check_violation';
  end if;

  if v_already_applied is not null then
    select jsonb_build_object(
      'alreadyApplied', true,
      'holdings', coalesce((select jsonb_agg(to_jsonb(bh.*)) from bag_holdings bh where bh.bag_id = p_bag_id), '[]'::jsonb),
      'investorPosition', (select to_jsonb(p.*) from bag_investor_positions p where p.bag_id = p_bag_id and p.user_id = p_user_id)
    ) into v_result;
    return v_result;
  end if;

  -- 0036: a failed / expired / cancelled / partially-executed intent never
  -- produces full accounting (no share mint, no share burn), whatever the caller says.
  if v_intent_status in ('FAILED', 'EXPIRED', 'CANCELLED', 'PARTIAL_SUCCESS', 'RECONCILIATION_REQUIRED') then
    raise exception 'INTENT_NOT_EXECUTABLE: redeem intent % is %', p_intent_id, v_intent_status using errcode = 'check_violation';
  end if;
  if p_shares_burn_raw::numeric <= 0 or p_redeem_value_quote::numeric < 0 or p_fee_amount_quote::numeric < 0 then
    raise exception 'INVALID_ACCOUNTING_DELTA: burn %, value %, fee % must be positive/non-negative', p_shares_burn_raw, p_redeem_value_quote, p_fee_amount_quote
      using errcode = 'check_violation';
  end if;

  -- 0036: same share / holdings underflow guards as apply_redeem_execution —
  -- this path previously let shares and holdings go negative.
  select * into v_position from bag_investor_positions where user_id = p_user_id and bag_id = p_bag_id for update;
  if not found or v_position.shares_raw::numeric < p_shares_burn_raw::numeric then
    raise exception 'INSUFFICIENT_SHARES: user % bag % has % raw shares, tried to burn %',
      p_user_id, p_bag_id, coalesce(v_position.shares_raw, '0'), p_shares_burn_raw;
  end if;

  -- IDENTICAL holdings/shares/cost-basis logic to apply_redeem_execution()
  -- (0018) — this function only diverges in how the FEE is recorded, never
  -- in the position accounting itself. Kept duplicated rather than
  -- factored into a shared helper: PL/pgSQL has no cheap way to share a
  -- code block across two SECURITY-relevant functions without an extra
  -- indirection layer that would make both harder to audit independently.
  for h in select * from jsonb_array_elements(p_holdings_sold)
  loop
    v_chain := h->>'chain';
    v_address := h->>'address';
    v_qty := (h->>'quantity_raw')::numeric;

    update bag_holdings
    set quantity_raw = (quantity_raw::numeric - v_qty)::text, updated_at = now()
    where bag_id = p_bag_id and chain = v_chain and address = v_address
      and quantity_raw::numeric >= v_qty;
    get diagnostics v_row_count = row_count;
    if v_row_count = 0 then
      raise exception 'HOLDINGS_UNDERFLOW: bag % chain % address % cannot sell % (stale allocation)', p_bag_id, v_chain, v_address, v_qty;
    end if;

    update bag_investor_holdings
    set quantity_raw = (quantity_raw::numeric - v_qty)::text, updated_at = now()
    where user_id = p_user_id and bag_id = p_bag_id and chain = v_chain and address = v_address
      and quantity_raw::numeric >= v_qty;
    get diagnostics v_row_count = row_count;
    if v_row_count = 0 then
      raise exception 'INVESTOR_HOLDINGS_UNDERFLOW: user % bag % chain % address % cannot sell % (stale allocation)', p_user_id, p_bag_id, v_chain, v_address, v_qty;
    end if;
  end loop;

  select * into v_position from bag_investor_positions where user_id = p_user_id and bag_id = p_bag_id for update;

  if v_position.shares_raw::numeric = p_shares_burn_raw::numeric then
    -- 0036: a FULL redemption consumes ALL remaining basis — rounding the
    -- consumed amount to 2 decimals used to leave residual basis on 0 shares.
    v_consumed_cost_basis := v_position.cost_basis_quote::numeric;
  elsif v_position.shares_raw::numeric > 0 then
    v_consumed_cost_basis := round(
      v_position.cost_basis_quote::numeric * (p_shares_burn_raw::numeric / v_position.shares_raw::numeric),
      2
    );
  else
    v_consumed_cost_basis := 0;
  end if;

  v_profit := p_redeem_value_quote::numeric - v_consumed_cost_basis;
  v_new_shares := v_position.shares_raw::numeric - p_shares_burn_raw::numeric;
  v_new_cost_basis := v_position.cost_basis_quote::numeric - v_consumed_cost_basis;

  update bag_investor_positions
  set shares_raw = v_new_shares::text,
      cost_basis_quote = v_new_cost_basis::text,
      updated_at = now()
  where user_id = p_user_id and bag_id = p_bag_id;

  update bag_share_state
  set total_shares_raw = (total_shares_raw::numeric - p_shares_burn_raw::numeric)::text,
      updated_at = now()
  where bag_id = p_bag_id;

  -- Audit-only activity row — same PERFORMANCE_FEE_EARNED convention as
  -- the legacy path, so lib/server/creator-rewards-repo.ts's existing
  -- parser keeps working unchanged for a creator's reward history view.
  if p_fee_amount_quote::numeric > 0 then
    insert into activities (user_id, action)
    values (p_creator_id, 'PERFORMANCE_FEE_EARNED:' || p_fee_amount_quote || ':' || p_bag_id::text);

    -- THE key difference from apply_redeem_execution(): inserted directly
    -- at CONFIRMED, with the real on-chain proof, because the fee is
    -- ALREADY settled — never EARNED (which would make the async
    -- settlement worker try to pay it a second time). `source_redeem_intent_id`
    -- carries the SAME unique-index protection 0014 already created, so a
    -- retried call to this function (e.g. a webhook redelivery) can never
    -- insert a second row for the same intent either.
    insert into creator_reward_settlements (
      creator_id, creator_wallet, bag_id, reward_type,
      source_redeem_intent_id, gross_amount_quote, reward_amount_token_raw,
      reward_token_address, reward_token_decimals, reward_chain_id,
      status, settlement_ref_id, onchain_tx_hash, settled_at
    ) values (
      p_creator_id, p_creator_wallet, p_bag_id, 'PERFORMANCE_FEE',
      p_intent_id, p_fee_amount_quote, p_fee_amount_token_raw,
      '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', 6, 4663,
      'CONFIRMED', p_redemption_id_hex, p_onchain_tx_hash, now()
    )
    on conflict (source_redeem_intent_id) where source_redeem_intent_id is not null do nothing;
  end if;

  update redeem_intents
  set accounting_applied_at = now()
  where id = p_intent_id;

  insert into activities (user_id, action)
  values (p_user_id, 'REDEEM_EXECUTED:' || p_intent_id::text || ':' || p_bag_id::text);

  select jsonb_build_object(
    'alreadyApplied', false,
    'consumedCostBasis', v_consumed_cost_basis,
    'profit', v_profit,
    'investorPosition', (select to_jsonb(p.*) from bag_investor_positions p where p.bag_id = p_bag_id and p.user_id = p_user_id)
  ) into v_result;

  return v_result;
end;
$$;

do $$
declare
  v_sig text;
begin
  foreach v_sig in array array[
    'apply_purchase_execution(uuid, uuid, jsonb, text, integer, uuid, text, integer, uuid)',
    'apply_redeem_execution(uuid, uuid, jsonb, text, integer, uuid, text, integer, uuid)',
    'apply_redeem_execution_router_settled(uuid, uuid, jsonb, text, integer, uuid, text, uuid, text, text, text, text, text)'
  ] loop
    execute format('revoke execute on function %s from public', v_sig);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke execute on function %s from anon', v_sig); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke execute on function %s from authenticated', v_sig); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', v_sig); end if;
  end loop;
end $$;

-- 0037_asset_logo_url.sql
--
-- Token logos for the asset picker. Filled by the importers from each
-- source's own field (Robinhood /rhj/assets `logoUrl`, LI.FI `logoURI`);
-- never guessed. https only, so a registry row can never point the app at a
-- plain-http or javascript:/data: URL.

alter table assets add column if not exists logo_url text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'assets_logo_url_https') then
    alter table assets
      add constraint assets_logo_url_https
      check (logo_url is null or (logo_url like 'https://%' and length(logo_url) <= 2048));
  end if;
end $$;

notify pgrst, 'reload schema';

-- 0038_clear_robinhood_stock_logos.sql
--
-- Robinhood's /rhj/assets `logoUrl` turned out to be the same Robinhood
-- feather for every Stock Token, not the company's logo. The importer no
-- longer stores it (robinhood-import.ts); this clears what 0037-era imports
-- wrote, so the asset picker falls back to the ticker.

update assets
set logo_url = null, updated_at = now()
where chain = 'robinhood' and asset_type = 'stock' and logo_url is not null;

-- 0039_user_profile.sql
--
-- Creator profile: a display name (column already existed, now bounded) and a
-- profile photo. Photos are uploaded through POST /api/profile/avatar (server
-- side, service role, content checked by magic bytes) into the public
-- `avatars` Storage bucket; users.avatar_url holds that public https URL.

alter table users add column if not exists avatar_url text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'users_avatar_url_https') then
    alter table users
      add constraint users_avatar_url_https
      check (avatar_url is null or (avatar_url like 'https://%' and length(avatar_url) <= 2048));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'users_display_name_length') then
    alter table users
      add constraint users_display_name_length
      check (display_name is null or char_length(display_name) between 1 and 32);
  end if;
end $$;

-- Public read (the image is shown on public Bag pages); no client write
-- policy — only the server (service role) uploads.
-- Supabase only: plain Postgres (integration tests) has no storage schema.
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('avatars', 'avatars', true, 1048576, array['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
    on conflict (id) do nothing;
  end if;
end $$;

notify pgrst, 'reload schema';

-- 0040_security_hardening.sql
--
-- Security review follow-ups. Safe to run more than once.
--
--   A. intent_tx_claims — a transaction hash can back at most ONE purchase or
--      redeem intent (the same execution could otherwise be reported for a
--      second intent and mint shares twice).
--   B. auth_nonces — several outstanding nonces per wallet; consuming needs
--      BOTH wallet and nonce. A junk "verify" or a new nonce request for
--      someone else's address can no longer wipe their pending sign-in.
--   C. Settlement worker pays FORK_ROYALTY rows only. Performance fees are
--      settled atomically by RedeemFeeRouter (rows arrive CONFIRMED); an
--      EARNED performance-fee row could only come from the legacy LI.FI
--      redeem path, where no fee was ever collected from the user — paying it
--      would have come out of the protocol's own wallet. Those rows are
--      cancelled.
--   D. Row Level Security on every table that still had it off. The app only
--      uses the service-role key (which bypasses RLS); with RLS on and no
--      policies, the anon/authenticated API roles get nothing.

-- ---------------------------------------------------------------------------
-- A. intent_tx_claims
-- ---------------------------------------------------------------------------
create table if not exists intent_tx_claims (
  chain text not null,
  tx_hash text not null,
  intent_kind text not null check (intent_kind in ('PURCHASE', 'REDEEM')),
  intent_id uuid not null,
  claimed_at timestamptz not null default now(),
  primary key (chain, tx_hash)
);

-- true  = the hash now belongs (or already belonged) to this intent
-- false = a different intent already claimed it
create or replace function claim_intent_tx_hash(
  p_chain text,
  p_tx_hash text,
  p_intent_kind text,
  p_intent_id uuid
) returns boolean
language plpgsql
as $$
declare
  v_owner uuid;
begin
  insert into intent_tx_claims (chain, tx_hash, intent_kind, intent_id)
  values (p_chain, lower(p_tx_hash), p_intent_kind, p_intent_id)
  on conflict (chain, tx_hash) do nothing;

  select intent_id into v_owner from intent_tx_claims where chain = p_chain and tx_hash = lower(p_tx_hash);
  return v_owner = p_intent_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- B. auth_nonces: keyed by nonce, several per wallet
-- ---------------------------------------------------------------------------
-- Only an OLD-shape table (one row per wallet, keyed by wallet_address) is
-- replaced; once the table is keyed by nonce, re-running this leaves it and
-- its pending nonces alone. Nonces are 5-minute, single-use challenges, so
-- dropping the old table only means an in-flight sign-in has to be retried.
drop function if exists consume_auth_nonce(text);
do $$
begin
  if to_regclass('auth_nonces') is not null and not exists (
    select 1
    from pg_index i
    join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any (i.indkey)
    where i.indrelid = 'auth_nonces'::regclass and i.indisprimary and a.attname = 'nonce'
  ) then
    drop table auth_nonces;
  end if;
end $$;

create table if not exists auth_nonces (
  nonce text primary key,
  wallet_address text not null,
  message text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists auth_nonces_wallet_idx on auth_nonces (wallet_address);
create index if not exists auth_nonces_expires_idx on auth_nonces (expires_at);

create or replace function consume_auth_nonce(p_wallet_address text, p_nonce text)
returns table(nonce text, message text, expires_at timestamptz)
language plpgsql
as $$
begin
  -- Opportunistic cleanup so abandoned challenges don't accumulate.
  delete from auth_nonces a where a.expires_at < now() - interval '1 hour';

  return query
    delete from auth_nonces a
    where a.wallet_address = p_wallet_address and a.nonce = p_nonce
    returning a.nonce, a.message, a.expires_at;
end;
$$;

-- ---------------------------------------------------------------------------
-- C. Settlement worker: FORK_ROYALTY only
-- ---------------------------------------------------------------------------
create or replace function claim_reward_settlement_batch(p_worker_id text, p_limit integer default 20)
returns setof creator_reward_settlements
language plpgsql
as $$
begin
  return query
    update creator_reward_settlements
    set status = 'PENDING_SETTLEMENT',
        locked_by = p_worker_id,
        locked_at = now(),
        attempt_count = attempt_count + 1,
        updated_at = now()
    where id in (
      select id from creator_reward_settlements
      where status in ('EARNED', 'RETRYABLE')
        and reward_type = 'FORK_ROYALTY'
      order by created_at asc
      limit p_limit
      for update skip locked
    )
    returning *;
end;
$$;

update creator_reward_settlements
set status = 'CANCELLED',
    failure_reason = 'Legacy (non-router) performance fee: never collected from the redeemer, so never payable by the protocol (0040).',
    updated_at = now()
where reward_type = 'PERFORMANCE_FEE'
  and status in ('EARNED', 'RETRYABLE', 'PENDING_SETTLEMENT');

-- ---------------------------------------------------------------------------
-- Function privileges: service_role only (same convention as 0026/0031).
-- ---------------------------------------------------------------------------
do $$
declare
  v_sig text;
begin
  foreach v_sig in array array[
    'claim_intent_tx_hash(text, text, text, uuid)',
    'consume_auth_nonce(text, text)',
    'claim_reward_settlement_batch(text, integer)'
  ] loop
    execute format('revoke execute on function %s from public', v_sig);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke execute on function %s from anon', v_sig); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke execute on function %s from authenticated', v_sig); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', v_sig); end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- D. Row Level Security everywhere
-- ---------------------------------------------------------------------------
do $$
declare
  v_table text;
begin
  foreach v_table in array array[
    'users', 'auth_nonces', 'purchase_intents', 'redeem_intents',
    'bag_investor_positions', 'bag_investor_holdings', 'investment_commits',
    'accessories', 'box_types', 'seasons', 'leaderboard_snapshots', 'intent_tx_claims'
  ] loop
    if to_regclass('public.' || v_table) is not null then
      execute format('alter table public.%I enable row level security', v_table);
    end if;
  end loop;
end $$;

-- =============================================================================
-- 0041_purchase_intent_fallback.sql
--
-- Adds `fallback` (nullable jsonb) to `purchase_intents`: the creator's
-- unroutable-asset policy as it was applied to THIS purchase (see
-- `UNROUTABLE_POLICIES` in types/basket-protocol.ts and
-- lib/domain/basket-protocol/deposit/unroutable.ts):
--
--   { "policy": "HOLD_INPUT" | "REFUND",
--     "assets": [{ "chain", "address", "symbol" }],   -- assets held/refunded
--     "unroutableWeightBps": 1200,
--     "amountScaleBps": 10000 | 8800,                  -- REFUND spends less
--     "requestedAmountRaw": "100000000",               -- what the buyer typed
--     "inputSymbol": "USDG", "inputDecimals": 6 }
--
-- prepareExecution() re-derives the same effective recipe from this record,
-- so the plan fingerprint check keeps working for partial purchases. Null for
-- every purchase where all assets were routable (and every existing row).
-- Safe to run more than once.

alter table purchase_intents
  add column if not exists fallback jsonb;


-- =============================================================================
-- 0042_partial_purchase_shares.sql
--
-- A purchase whose legs only partly executed (the sequential path: some
-- swaps landed, others were never signed or failed) used to credit the
-- Bag's holdings but mint NO shares and create NO investor position — the
-- buyer's swapped tokens sat in their wallet and never showed up in the
-- app. apply_partial_purchase_execution now does the same bookkeeping as a
-- full purchase for the part that actually executed:
--
--   * bag_holdings AND bag_investor_holdings are credited with what the
--     completed legs verifiably received;
--   * shares are minted pro rata to the input actually spent
--     (p_shares_delta_raw, computed by the caller as
--     quoted shares * spent / requested), with the matching cost basis.
--
-- The intent must exist, belong to (p_user_id, p_bag_id) and be
-- PARTIAL_SUCCESS; idempotency stays on reconciliation_applied_at. Fork
-- royalties are not paid on partial purchases. Safe to run more than once.

drop function if exists apply_partial_purchase_execution(uuid, uuid, jsonb, uuid);

create or replace function apply_partial_purchase_execution(
  p_intent_id uuid,
  p_bag_id uuid,
  p_holdings jsonb,        -- [{chain, address, decimals, delta_raw}]
  p_user_id uuid,
  p_shares_delta_raw text default '0',
  p_share_decimals integer default 18,
  p_cost_basis_delta text default '0'
) returns jsonb
language plpgsql
as $$
declare
  v_already_applied timestamptz;
  v_intent_user uuid;
  v_intent_bag uuid;
  v_intent_status text;
  v_result jsonb;
begin
  select reconciliation_applied_at, user_id, bag_id, status
    into v_already_applied, v_intent_user, v_intent_bag, v_intent_status
  from purchase_intents
  where id = p_intent_id
  for update;
  if not found then
    raise exception 'INTENT_NOT_FOUND: purchase intent %', p_intent_id using errcode = 'no_data_found';
  end if;
  if v_intent_user is distinct from p_user_id or v_intent_bag is distinct from p_bag_id then
    raise exception 'INTENT_MISMATCH: purchase intent % belongs to user % bag %, not user % bag %',
      p_intent_id, v_intent_user, v_intent_bag, p_user_id, p_bag_id using errcode = 'check_violation';
  end if;

  if v_already_applied is not null then
    select jsonb_build_object(
      'alreadyApplied', true,
      'holdings', coalesce((select jsonb_agg(to_jsonb(bh.*)) from bag_holdings bh where bh.bag_id = p_bag_id), '[]'::jsonb)
    ) into v_result;
    return v_result;
  end if;

  if v_intent_status <> 'PARTIAL_SUCCESS' then
    raise exception 'INTENT_NOT_PARTIAL: purchase intent % is %', p_intent_id, v_intent_status using errcode = 'check_violation';
  end if;
  if p_shares_delta_raw::numeric < 0 or p_cost_basis_delta::numeric < 0
     or exists (select 1 from jsonb_array_elements(p_holdings) h where (h->>'delta_raw')::numeric < 0) then
    raise exception 'INVALID_ACCOUNTING_DELTA: shares %, cost basis %, holdings must be non-negative', p_shares_delta_raw, p_cost_basis_delta
      using errcode = 'check_violation';
  end if;

  insert into bag_holdings (bag_id, chain, address, quantity_raw, decimals)
  select p_bag_id, (h->>'chain')::text, (h->>'address')::text, (h->>'delta_raw')::text, (h->>'decimals')::integer
  from jsonb_array_elements(p_holdings) as h
  on conflict (bag_id, chain, address) do update
    set quantity_raw = (bag_holdings.quantity_raw::numeric + excluded.quantity_raw::numeric)::text,
        updated_at = now();

  insert into bag_investor_holdings (user_id, bag_id, chain, address, quantity_raw, decimals)
  select p_user_id, p_bag_id, (h->>'chain')::text, (h->>'address')::text, (h->>'delta_raw')::text, (h->>'decimals')::integer
  from jsonb_array_elements(p_holdings) as h
  on conflict (user_id, bag_id, chain, address) do update
    set quantity_raw = (bag_investor_holdings.quantity_raw::numeric + excluded.quantity_raw::numeric)::text,
        updated_at = now();

  if p_shares_delta_raw::numeric > 0 then
    insert into bag_share_state (bag_id, total_shares_raw, share_decimals)
    values (p_bag_id, p_shares_delta_raw, p_share_decimals)
    on conflict (bag_id) do update
      set total_shares_raw = (bag_share_state.total_shares_raw::numeric + excluded.total_shares_raw::numeric)::text,
          updated_at = now();

    insert into bag_investor_positions (user_id, bag_id, shares_raw, share_decimals, cost_basis_quote)
    values (p_user_id, p_bag_id, p_shares_delta_raw, p_share_decimals, p_cost_basis_delta)
    on conflict (user_id, bag_id) do update
      set shares_raw = (bag_investor_positions.shares_raw::numeric + excluded.shares_raw::numeric)::text,
          cost_basis_quote = (bag_investor_positions.cost_basis_quote::numeric + excluded.cost_basis_quote::numeric)::text,
          updated_at = now();
  end if;

  update purchase_intents
  set reconciliation_applied_at = now()
  where id = p_intent_id;

  insert into activities (user_id, action)
  values (p_user_id, 'PURCHASE_PARTIALLY_RECONCILED:' || p_intent_id::text || ':' || p_bag_id::text);

  select jsonb_build_object(
    'alreadyApplied', false,
    'holdings', coalesce((select jsonb_agg(to_jsonb(bh.*)) from bag_holdings bh where bh.bag_id = p_bag_id), '[]'::jsonb),
    'investorPosition', (select to_jsonb(p.*) from bag_investor_positions p where p.bag_id = p_bag_id and p.user_id = p_user_id)
  ) into v_result;
  return v_result;
end;
$$;

revoke execute on function apply_partial_purchase_execution(uuid, uuid, jsonb, uuid, text, integer, text) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke execute on function apply_partial_purchase_execution(uuid, uuid, jsonb, uuid, text, integer, text) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke execute on function apply_partial_purchase_execution(uuid, uuid, jsonb, uuid, text, integer, text) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function apply_partial_purchase_execution(uuid, uuid, jsonb, uuid, text, integer, text) to service_role;
  end if;
end $$;


-- =============================================================================
-- 0043_asset_route_status.sql
--
-- Liquidity status per registry asset, refreshed in the background by
-- /api/cron/refresh-asset-routes (lib/server/asset-route-refresh.ts): a small
-- LI.FI quote from the chain's payment token into the asset.
--
--   route_status      'ROUTABLE' | 'NO_ROUTE' — null until first checked.
--                     Transient provider errors never overwrite it.
--   route_checked_at  when route_status was last confirmed.
--
-- The Create page hides NO_ROUTE assets from the picker by default. Display
-- only: purchases still quote live and apply the Bag's unroutable-asset
-- policy. Safe to run more than once.

alter table assets
  add column if not exists route_status text,
  add column if not exists route_checked_at timestamptz;



-- =============================================================================
-- 0044_bag_nav_snapshots.sql
--
-- Recorded NAV history per Bag, for the Performance chart and the 7D / 30D /
-- YTD figures. One row = the Bag's gross NAV over bag_holdings and its NAV
-- per share at one moment, from the same NAV calculation as purchase/redeem
-- (lib/server/bag-nav.ts). Written server-side only (service role):
--   - when a Bag page is read and the last snapshot is older than 15 minutes
--   - by scripts/snapshot-bag-navs.ts (all ACTIVE Bags; run it on a schedule)
-- Nothing is back-filled or estimated: the history starts at the first
-- snapshot. Safe to run more than once.

create table if not exists bag_nav_snapshots (
  id bigserial primary key,
  bag_id uuid not null references bags(id) on delete cascade,
  captured_at timestamptz not null default now(),
  gross_nav numeric not null,
  nav_per_share numeric not null,
  total_shares_raw numeric not null,
  share_decimals integer not null,
  quote_currency text not null default 'USD'
);

create index if not exists bag_nav_snapshots_bag_time_idx on bag_nav_snapshots (bag_id, captured_at desc);

-- Service role only, like the other server-written tables (0040).
alter table bag_nav_snapshots enable row level security;


-- =============================================================================
-- 0045_bag_nav_summaries.sql
--
-- One query for the Bag listings (Explore, Profile, Creator): per Bag, the
-- latest recorded NAV snapshot (bag_nav_snapshots, 0044) and the NAV per share
-- at or before 7 days ago, 30 days ago and the start of the year (UTC). The
-- listings show TVL = latest gross NAV and 7D / 30D / YTD from these, without
-- pricing every Bag on every request. Null where no snapshot exists yet.
-- Server-only (service role). Safe to run more than once.

create or replace function bag_nav_summaries(p_bag_ids uuid[])
returns table (
  bag_id uuid,
  latest_at timestamptz,
  gross_nav numeric,
  nav_per_share numeric,
  nav_per_share_7d numeric,
  nav_per_share_30d numeric,
  nav_per_share_ytd numeric
)
language sql
stable
security definer
set search_path = public
as $$
  select
    b.id,
    l.captured_at,
    l.gross_nav,
    l.nav_per_share,
    (select s.nav_per_share from bag_nav_snapshots s
      where s.bag_id = b.id and s.captured_at <= now() - interval '7 days'
      order by s.captured_at desc limit 1),
    (select s.nav_per_share from bag_nav_snapshots s
      where s.bag_id = b.id and s.captured_at <= now() - interval '30 days'
      order by s.captured_at desc limit 1),
    (select s.nav_per_share from bag_nav_snapshots s
      where s.bag_id = b.id and s.captured_at <= date_trunc('year', now() at time zone 'utc') at time zone 'utc'
      order by s.captured_at desc limit 1)
  from unnest(p_bag_ids) as b(id)
  left join lateral (
    select s.captured_at, s.gross_nav, s.nav_per_share
    from bag_nav_snapshots s
    where s.bag_id = b.id
    order by s.captured_at desc
    limit 1
  ) l on true;
$$;

revoke all on function bag_nav_summaries(uuid[]) from public, anon, authenticated;
grant execute on function bag_nav_summaries(uuid[]) to service_role;

notify pgrst, 'reload schema';

-- =============================================================================
-- 0046 — fork lineage integrity (see supabase/migrations/0046_bag_lineage_integrity.sql)
-- =============================================================================
create or replace function guard_bag_lineage() returns trigger
language plpgsql
as $$
declare
  v_parent_root uuid;
begin
  if TG_OP = 'INSERT' then
    if NEW.parent_bag_id is null then
      if NEW.root_bag_id is not null then
        raise exception 'BAG_LINEAGE_INVALID: bag % has root_bag_id without parent_bag_id', NEW.id using errcode = 'check_violation';
      end if;
      return NEW;
    end if;
    select root_bag_id into v_parent_root from bags where id = NEW.parent_bag_id;
    if not found then
      raise exception 'BAG_LINEAGE_INVALID: parent bag % does not exist', NEW.parent_bag_id using errcode = 'check_violation';
    end if;
    if NEW.root_bag_id is distinct from coalesce(v_parent_root, NEW.parent_bag_id) then
      raise exception 'BAG_LINEAGE_INVALID: bag % root_bag_id must be its parent''s root', NEW.id using errcode = 'check_violation';
    end if;
    return NEW;
  end if;

  if NEW.parent_bag_id is distinct from OLD.parent_bag_id
     and (NEW.parent_bag_id is not null or exists (select 1 from bags where id = OLD.parent_bag_id)) then
    raise exception 'BAG_LINEAGE_IMMUTABLE: bag % parent_bag_id cannot change', OLD.id using errcode = 'check_violation';
  end if;
  if NEW.root_bag_id is distinct from OLD.root_bag_id
     and (NEW.root_bag_id is not null or exists (select 1 from bags where id = OLD.root_bag_id)) then
    raise exception 'BAG_LINEAGE_IMMUTABLE: bag % root_bag_id cannot change', OLD.id using errcode = 'check_violation';
  end if;
  return NEW;
end;
$$;

drop trigger if exists trg_guard_bag_lineage on bags;
create trigger trg_guard_bag_lineage
  before insert or update of parent_bag_id, root_bag_id on bags
  for each row execute function guard_bag_lineage();

revoke all on function guard_bag_lineage() from public, anon, authenticated;
grant execute on function guard_bag_lineage() to service_role;
