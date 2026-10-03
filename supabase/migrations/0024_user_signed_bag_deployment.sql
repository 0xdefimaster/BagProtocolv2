-- 0024_user_signed_bag_deployment.sql
--
-- Schema half of the USER-SIGNED Bag deployment flow (prepare -> the person's
-- own wallet signs `BagFactory.createBag` -> confirm). Companion migrations:
--   0025_confirm_bag_deployment_rpc.sql   — the one atomic finalization function
--   0026_restrict_rpc_execute_privileges.sql — RPC execute lockdown
--
-- WHY. Under the old backend-signed flow the backend chose the on-chain bag
-- id itself (the UUID as bytes32) and a DEPLOYING row existed while it sent
-- the transaction. In the user-signed flow the creator's wallet is
-- `msg.sender`, and the factory derives the id as
-- keccak256(abi.encode(creator, offChainRef)) — so the REAL on-chain id is only
-- known from the confirmed `BagCreated` event. It is persisted here
-- (`on_chain_bag_id`), and execution reads THAT value; nothing re-derives it.
-- There is no DEPLOYING state any more: prepare writes nothing, and confirm is
-- a single atomic hop to DEPLOYED.
--
-- What this migration does (all idempotent):
--   1. adds `on_chain_bag_id` / `on_chain_creator`;
--   2. canonicalises `tx_hash` to lowercase and backfills legacy DEPLOYED rows
--      with the legacy UUID-as-bytes32 id (`on_chain_creator` stays NULL: the
--      old flow had no creator-bound id);
--   3. FAILS LOUDLY (rather than silently deduplicating) if existing rows
--      would violate the new uniqueness rules, listing them;
--   4. guarantees `unique (bag_id, chain)` — "one Bag + one chain = one
--      deployment" — exists as a real index/constraint, adds
--      unique (chain, tx_hash) and unique (chain, on_chain_bag_id);
--   5. adds format checks, and "DEPLOYED => has an on-chain id";
--   6. installs the cross-table invariant "a Bag with a DEPLOYED deployment
--      is never DRAFT" as deferred constraint triggers (checked at COMMIT, so
--      the atomic RPC can set both in one transaction), and repairs any
--      pre-existing DEPLOYED + DRAFT rows;
--   7. drops the legacy `start_bag_deployment()` (nothing calls it any more).

-- 1. Columns ------------------------------------------------------------------
alter table bag_deployments
  add column if not exists on_chain_bag_id text,
  add column if not exists on_chain_creator text;

-- 2. Canonicalise + backfill --------------------------------------------------
update bag_deployments set tx_hash = lower(tx_hash) where tx_hash is not null and tx_hash <> lower(tx_hash);
update bag_deployments set contract_address = lower(contract_address) where contract_address is not null and contract_address <> lower(contract_address);
update bag_deployments set factory_address = lower(factory_address) where factory_address is not null and factory_address <> lower(factory_address);

update bag_deployments
   set on_chain_bag_id = '0x' || lpad(replace(bag_id::text, '-', ''), 64, '0')
 where status = 'DEPLOYED' and on_chain_bag_id is null;

-- 3. Fail loudly on pre-existing violations -----------------------------------
do $$
declare
  v_dupes text;
  v_bad text;
begin
  select string_agg(format('bag_id=%s chain=%s (%s rows)', bag_id, chain, n), '; ')
    into v_dupes
    from (select bag_id, chain, count(*) n from bag_deployments group by 1, 2 having count(*) > 1) d;
  if v_dupes is not null then
    raise exception 'bag_deployments has duplicate (bag_id, chain) rows — resolve manually before applying 0024: %', v_dupes;
  end if;

  select string_agg(format('chain=%s tx_hash=%s (%s rows)', chain, tx_hash, n), '; ')
    into v_dupes
    from (select chain, tx_hash, count(*) n from bag_deployments where tx_hash is not null group by 1, 2 having count(*) > 1) d;
  if v_dupes is not null then
    raise exception 'bag_deployments has duplicate (chain, tx_hash) rows — resolve manually before applying 0024: %', v_dupes;
  end if;

  select string_agg(format('chain=%s on_chain_bag_id=%s (%s rows)', chain, on_chain_bag_id, n), '; ')
    into v_dupes
    from (select chain, on_chain_bag_id, count(*) n from bag_deployments where on_chain_bag_id is not null group by 1, 2 having count(*) > 1) d;
  if v_dupes is not null then
    raise exception 'bag_deployments has duplicate (chain, on_chain_bag_id) rows — resolve manually before applying 0024: %', v_dupes;
  end if;

  select string_agg(id::text, ', ')
    into v_bad
    from bag_deployments
   where (tx_hash is not null and tx_hash !~ '^0x[0-9a-f]{64}$')
      or (contract_address is not null and contract_address !~ '^0x[0-9a-f]{40}$' and status = 'DEPLOYED');
  if v_bad is not null then
    raise exception 'bag_deployments rows with a malformed tx_hash/contract_address — inspect before applying 0024: %', v_bad;
  end if;
end $$;

-- 4. Uniqueness ---------------------------------------------------------------
-- `unique (bag_id, chain)` is already declared inline by schema.sql's CREATE
-- TABLE. Re-assert it defensively (an environment bootstrapped some other
-- way must not silently lack the one-deployment-per-bag-per-chain guarantee),
-- creating it only if NO unique index on exactly (bag_id, chain) exists.
do $$
begin
  if not exists (
    select 1
      from pg_index i
     where i.indrelid = 'bag_deployments'::regclass
       and i.indisunique
       and i.indpred is null
       and (select array_agg(a.attname::text order by a.attname::text)
              from pg_attribute a
             where a.attrelid = i.indrelid and a.attnum = any (i.indkey)) = array['bag_id', 'chain']
  ) then
    create unique index uq_bag_deployments_bag_chain on bag_deployments (bag_id, chain);
  end if;
end $$;

create unique index if not exists uq_bag_deployments_chain_tx_hash
  on bag_deployments (chain, tx_hash) where tx_hash is not null;
create unique index if not exists uq_bag_deployments_chain_on_chain_bag_id
  on bag_deployments (chain, on_chain_bag_id) where on_chain_bag_id is not null;

-- 5. Checks -------------------------------------------------------------------
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

-- 6. Cross-table invariant: DEPLOYED deployment => Bag is not DRAFT ------------
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

-- Repair pre-existing DEPLOYED + DRAFT rows (the failure window the old
-- two-step finalization could leave behind) BEFORE the triggers exist.
do $$
declare v_fixed integer;
begin
  with fixed as (
    update bags b set status = 'ACTIVE', updated_at = now()
     where b.status = 'DRAFT'
       and exists (select 1 from bag_deployments d where d.bag_id = b.id and d.status = 'DEPLOYED')
    returning 1
  )
  select count(*) into v_fixed from fixed;
  if v_fixed > 0 then
    raise notice '0024: repaired % bag(s) that had a DEPLOYED deployment but were still DRAFT', v_fixed;
  end if;
end $$;

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

-- 7. Legacy backend-signed transition -----------------------------------------
drop function if exists start_bag_deployment(uuid, text, text);
