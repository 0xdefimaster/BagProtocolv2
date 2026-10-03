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
-- lib/server/deploy-bag.ts's confirmDeployment() call to
-- setProtocolDeployment()) — not a second source of truth to keep in sync
-- by hand.
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
  status text not null default 'NOT_DEPLOYED' check (status in ('NOT_DEPLOYED', 'DEPLOYING', 'DEPLOYED', 'FAILED')),
  factory_address text,
  contract_address text,
  tx_hash text,
  block_number bigint,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (bag_id, chain)
);

create index if not exists idx_bag_deployments_bag on bag_deployments(bag_id);
create index if not exists idx_bag_deployments_status on bag_deployments(status);

-- ---------------------------------------------------------------------------
-- start_bag_deployment — the one deployment-state transition that genuinely
-- needs to be race-safe: two near-simultaneous deploy requests for the same
-- (bag_id, chain) must not both proceed to send a transaction. `ON CONFLICT
-- ... DO UPDATE ... WHERE status IN ('NOT_DEPLOYED', 'FAILED')` is an atomic
-- compare-and-swap — if the existing row's status is already DEPLOYING or
-- DEPLOYED, the WHERE clause makes Postgres skip the update entirely (same
-- as ON CONFLICT DO NOTHING for that row), so RETURNING yields no row and
-- `v_row` stays unset — the function reports `started: false` with the
-- current state instead. `confirm_bag_deployment`/marking FAILED afterward
-- don't need the same treatment: only whichever caller's `start_bag_
-- deployment` actually returned `started: true` holds the right to
-- transition that deployment further, so those are plain updates in
-- lib/server/bag-deployment-repo.ts, not more RPCs.
-- ---------------------------------------------------------------------------
create or replace function start_bag_deployment(
  p_bag_id uuid,
  p_chain text,
  p_factory_address text
) returns jsonb
language plpgsql
as $$
declare
  v_row bag_deployments;
begin
  insert into bag_deployments (bag_id, chain, status, factory_address)
  values (p_bag_id, p_chain, 'DEPLOYING', p_factory_address)
  on conflict (bag_id, chain) do update
    set status = 'DEPLOYING', factory_address = p_factory_address, error_message = null, updated_at = now()
    where bag_deployments.status in ('NOT_DEPLOYED', 'FAILED')
  returning * into v_row;

  if v_row.id is null then
    select * into v_row from bag_deployments where bag_id = p_bag_id and chain = p_chain;
    return jsonb_build_object('started', false, 'deployment', to_jsonb(v_row));
  end if;

  return jsonb_build_object('started', true, 'deployment', to_jsonb(v_row));
end;
$$;

revoke execute on function start_bag_deployment from public;
grant execute on function start_bag_deployment to service_role;

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
  p_holdings jsonb,        -- [{chain, address, decimals, delta_raw}]
  p_shares_delta_raw text,
  p_share_decimals integer,
  p_user_id uuid,
  p_cost_basis_delta text default '0',
  -- Phase 22 additions — both default so any pre-existing caller keeps
  -- working unchanged. p_root_creator_id is only non-null when p_bag_id
  -- has a root_bag_id (see lib/server/purchase-execution.ts's
  -- applyAccountingIdempotently() for how the caller resolves it).
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

  -- Phase 21 — this depositor's OWN per-asset holdings, same additive
  -- upsert shape as `bag_holdings` immediately above, keyed additionally by
  -- user_id. Read later by `calculateRedeemAllocation()` — never the
  -- bag-level aggregate (see that function's module doc).
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

  -- Phase 22, Layer 3 — fork royalty, same transaction as the mint above.
  -- No royalty when the root creator IS the depositor.
  if p_root_creator_id is not null and p_root_creator_id <> p_user_id and p_fork_royalty_bps > 0 and p_cost_basis_delta::numeric > 0 then
    v_royalty_amount := round(p_cost_basis_delta::numeric * p_fork_royalty_bps / 10000.0, 2);
    if v_royalty_amount > 0 then
      update portfolios
      set cash_balance = cash_balance + v_royalty_amount,
          updated_at = now()
      where user_id = p_root_creator_id;

      insert into activities (user_id, action)
      values (p_root_creator_id, 'FORK_ROYALTY_EARNED:' || v_royalty_amount::text || ':' || p_bag_id::text)
      returning id into v_royalty_activity_id;
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
  -- Phase 22 additions — all default so any pre-existing caller keeps
  -- working unchanged.
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
      'investorPosition', (select to_jsonb(p.*) from bag_investor_positions p where p.bag_id = p_bag_id and p.user_id = p_user_id)
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

  -- Phase 22, Layer 2 — the cost basis THIS redemption consumed (always
  -- >= 0, since v_new_cost_basis is a proportional fraction of the prior
  -- balance). Profit is this redemption's quoted value minus that —
  -- computed BEFORE bag_investor_positions is overwritten below, from the
  -- same locked row this function already took `for update` on.
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

  -- Phase 22, Layer 2 — performance fee, same transaction as the burn
  -- above. Never charged on a loss (v_profit <= 0), never charged to a
  -- creator redeeming their own bag.
  if p_creator_id is not null and p_creator_id <> p_user_id and p_performance_fee_bps > 0 and v_profit > 0 then
    v_fee_amount := round(v_profit * p_performance_fee_bps / 10000.0, 2);
    if v_fee_amount > 0 then
      update portfolios
      set cash_balance = cash_balance + v_fee_amount,
          updated_at = now()
      where user_id = p_creator_id;

      insert into activities (user_id, action)
      values (p_creator_id, 'PERFORMANCE_FEE_EARNED:' || v_fee_amount::text || ':' || p_bag_id::text);
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
    'investorPosition', (select to_jsonb(p.*) from bag_investor_positions p where p.bag_id = p_bag_id and p.user_id = p_user_id)
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
