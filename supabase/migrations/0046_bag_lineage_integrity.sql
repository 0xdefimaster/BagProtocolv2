-- 0046_bag_lineage_integrity.sql
--
-- Fork lineage is economic state, not display: `root_bag_id` decides who is
-- paid the fork royalty (purchase-execution.ts -> apply_purchase_execution's
-- p_root_creator_id). The application derives lineage server-side only
-- (createForkBag in lib/server/bag-repo.ts); this trigger is defense in depth:
--
--   INSERT: parent_bag_id must exist, and root_bag_id must be the parent's
--           root (or the parent itself). No root without a parent.
--   UPDATE: lineage is immutable. The only change allowed is the foreign
--           key's ON DELETE SET NULL clearing a reference to a Bag that no
--           longer exists.
--
-- Existing rows are not rewritten or re-checked. Safe to run more than once.

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
