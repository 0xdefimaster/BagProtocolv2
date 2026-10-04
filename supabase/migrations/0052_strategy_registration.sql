-- 0052_strategy_registration.sql
--
-- StrategyRegistry app wiring (docs/STRATEGY_REGISTRY_DESIGN.md §8).
--
-- 1. Fork provenance: `bags.parent_bag_version` — the parent's version a fork
--    was made from, recorded at fork time. Same integrity rules as the rest of
--    the lineage (0046): on insert it must name an existing version of the
--    parent; afterwards it never changes. Forks created before this migration
--    keep NULL ("not recorded"): it is not inferred.
--
-- 2. create_bag_with_initial_version takes p_parent_bag_version (re-created
--    with the extra defaulted parameter; the old signature is dropped so there
--    is exactly one function).
--
-- 3. strategy_registrations: what BAG verified on-chain from a creator-signed
--    StrategyRegistry transaction — one row per registered version. Insert-only.
--    The server never signs; it only records what a verified receipt shows.
--
-- Safe to run more than once.

alter table bags add column if not exists parent_bag_version integer;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'bags_parent_bag_version_positive') then
    alter table bags add constraint bags_parent_bag_version_positive check (parent_bag_version is null or parent_bag_version >= 1);
  end if;
end $$;

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
      if NEW.parent_bag_version is not null then
        raise exception 'BAG_LINEAGE_INVALID: bag % has parent_bag_version without parent_bag_id', NEW.id using errcode = 'check_violation';
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
    if NEW.parent_bag_version is not null
       and not exists (select 1 from bag_versions where bag_id = NEW.parent_bag_id and version = NEW.parent_bag_version) then
      raise exception 'BAG_LINEAGE_INVALID: parent bag % has no version %', NEW.parent_bag_id, NEW.parent_bag_version using errcode = 'check_violation';
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
  -- The fork's parent version is a fixed fact: it can be cleared only together with a parent that no longer exists.
  if NEW.parent_bag_version is distinct from OLD.parent_bag_version
     and not (NEW.parent_bag_version is null and NEW.parent_bag_id is null and OLD.parent_bag_id is not null
              and not exists (select 1 from bags where id = OLD.parent_bag_id)) then
    raise exception 'BAG_LINEAGE_IMMUTABLE: bag % parent_bag_version cannot change', OLD.id using errcode = 'check_violation';
  end if;
  return NEW;
end;
$$;

drop trigger if exists trg_guard_bag_lineage on bags;
create trigger trg_guard_bag_lineage
  before insert or update of parent_bag_id, root_bag_id, parent_bag_version on bags
  for each row execute function guard_bag_lineage();

revoke all on function guard_bag_lineage() from public, anon, authenticated;
grant execute on function guard_bag_lineage() to service_role;

drop function if exists create_bag_with_initial_version(uuid, text, text, text, text, uuid, text, text, text, jsonb, text, text, uuid, uuid, text);

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
  p_strategy_type text default 'STATIC_BASKET',
  p_parent_bag_version integer default null
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
    mutability, status, parent_bag_id, root_bag_id, parent_bag_version
  )
  values (
    p_id, p_slug, p_name, p_symbol, p_description, p_creator_id, p_chain,
    p_strategy_type, p_mutability, p_status, p_parent_bag_id, p_root_bag_id, p_parent_bag_version
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

create table if not exists strategy_registrations (
  id uuid primary key default gen_random_uuid(),
  bag_id uuid not null references bags(id),
  version integer not null check (version >= 1),
  chain text not null,
  registry_address text not null,
  registry_strategy_id text not null,
  definition_hash text not null,
  creator_wallet text not null,
  -- Set only on a fork's version-1 row: the registered parent it was forked from.
  fork_of_registry_strategy_id text,
  fork_of_version integer,
  tx_hash text not null,
  block_number bigint not null,
  log_index integer not null,
  verified_at timestamptz not null default now(),
  unique (bag_id, version),
  unique (chain, registry_address, registry_strategy_id, version),
  unique (chain, tx_hash, log_index)
);

create index if not exists idx_strategy_registrations_bag on strategy_registrations(bag_id, version);

alter table strategy_registrations enable row level security;

create or replace function guard_strategy_registrations_immutable() returns trigger
language plpgsql
as $$
begin
  raise exception 'STRATEGY_REGISTRATION_IMMUTABLE: strategy_registrations rows cannot be %', lower(TG_OP) using errcode = 'check_violation';
end;
$$;

drop trigger if exists trg_strategy_registrations_immutable on strategy_registrations;
create trigger trg_strategy_registrations_immutable
  before update or delete on strategy_registrations
  for each row execute function guard_strategy_registrations_immutable();

revoke all on table strategy_registrations from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on table strategy_registrations from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on table strategy_registrations from authenticated'; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'grant select, insert on table strategy_registrations to service_role'; end if;
end $$;

revoke all on function guard_strategy_registrations_immutable() from public;
