-- 0058 — Bag names are unique across the project, so two Bags can't be told apart only by their address.
--
-- Two names are the same when they match after lowercasing, trimming and collapsing inner whitespace
-- ("My  Bag " = "my bag"). Every Bag that is not ARCHIVED holds its name, drafts included: a draft is what gets
-- deployed, and refusing a name only at deploy time would come after the creator has paid the fee.
-- Names already duplicated before this migration are left as they are; only new names and renames are checked.
--
-- A trigger (not a unique index) because the existing duplicates must stay valid. The advisory lock makes two
-- concurrent inserts of the same name wait for each other, so both cannot pass the check. The error message starts
-- with BAG_NAME_TAKEN (SQLSTATE P0001, not 23505, which the app reads as a taken slug).

create or replace function normalize_bag_name(p_name text) returns text
language sql immutable
as $$
  select lower(regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g'))
$$;

create index if not exists idx_bags_normalized_name on bags (normalize_bag_name(name)) where status <> 'ARCHIVED';

create or replace function enforce_unique_bag_name() returns trigger
language plpgsql
as $$
declare
  v_key text := normalize_bag_name(new.name);
begin
  if new.status = 'ARCHIVED' then return new; end if;
  if tg_op = 'UPDATE' and normalize_bag_name(old.name) = v_key and old.status <> 'ARCHIVED' then return new; end if;
  perform pg_advisory_xact_lock(hashtext('bag_name:' || v_key));
  if exists (
    select 1 from bags b
    where b.id <> new.id and b.status <> 'ARCHIVED' and normalize_bag_name(b.name) = v_key
  ) then
    raise exception 'BAG_NAME_TAKEN: a Bag named "%" already exists', btrim(new.name) using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists bags_unique_name on bags;
create trigger bags_unique_name
  before insert or update of name, status on bags
  for each row execute function enforce_unique_bag_name();

-- Whether a name is free (same rule as the trigger), for the Create page's check. Read-only.
create or replace function bag_name_available(p_name text) returns boolean
language sql stable
as $$
  select not exists (
    select 1 from bags b where b.status <> 'ARCHIVED' and normalize_bag_name(b.name) = normalize_bag_name(p_name)
  )
$$;

do $$
declare
  v_sig text;
begin
  foreach v_sig in array array['bag_name_available(text)', 'normalize_bag_name(text)', 'enforce_unique_bag_name()'] loop
    execute format('revoke execute on function %s from public', v_sig);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke execute on function %s from anon', v_sig); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke execute on function %s from authenticated', v_sig); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', v_sig); end if;
  end loop;
end $$;

notify pgrst, 'reload schema';
