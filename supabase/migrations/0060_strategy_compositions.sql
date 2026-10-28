-- 0060_strategy_compositions.sql
--
-- StrategyCompositions app wiring (docs/STRATEGY_COMPOSITIONS_DESIGN.md).
--
-- strategy_compositions: what BAG verified from a creator-signed
-- StrategyCompositions.publishComposition transaction — one row per version
-- whose allocations (chainId, token, weightBps) are on-chain. Insert-only, like
-- strategy_registrations (0052). The server never signs; it records a row only
-- when the event's allocations equal the version's bag.json definition.
--
-- Safe to run more than once.

create table if not exists strategy_compositions (
  id uuid primary key default gen_random_uuid(),
  bag_id uuid not null references bags(id),
  version integer not null check (version >= 1),
  chain text not null,
  compositions_address text not null,
  registry_strategy_id text not null,
  composition_hash text not null,
  -- [{ "chainId": "4663", "token": "0x…", "weightBps": 6000 }, …] in contract order, as the event emitted it.
  allocations jsonb not null check (jsonb_typeof(allocations) = 'array'),
  creator_wallet text not null,
  tx_hash text not null,
  block_number bigint not null,
  log_index integer not null,
  verified_at timestamptz not null default now(),
  unique (bag_id, version),
  unique (chain, compositions_address, registry_strategy_id, version),
  unique (chain, tx_hash, log_index)
);

create index if not exists idx_strategy_compositions_bag on strategy_compositions(bag_id, version);

alter table strategy_compositions enable row level security;

create or replace function guard_strategy_compositions_immutable() returns trigger
language plpgsql
as $$
begin
  raise exception 'STRATEGY_COMPOSITION_IMMUTABLE: strategy_compositions rows cannot be %', lower(TG_OP) using errcode = 'check_violation';
end;
$$;

drop trigger if exists trg_strategy_compositions_immutable on strategy_compositions;
create trigger trg_strategy_compositions_immutable
  before update or delete on strategy_compositions
  for each row execute function guard_strategy_compositions_immutable();

revoke all on table strategy_compositions from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on table strategy_compositions from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on table strategy_compositions from authenticated'; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'grant select, insert on table strategy_compositions to service_role'; end if;
end $$;

revoke all on function guard_strategy_compositions_immutable() from public;
