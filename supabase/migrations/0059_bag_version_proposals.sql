-- 0059 — Pending version proposals, so a version recorded on chain can always be brought into the database.
--
-- Before: prepare was stateless and the new recipe lived only in the creator's browser (localStorage) until confirm.
-- If the database write failed after the chain accepted the version, or the browser lost that state, the chain was
-- at vN+1 with nothing on the server to record: the Bag could not be edited again (prepare: OUT_OF_SYNC).
--
-- Now prepare stores the validated recipe and everything the transaction commits to BEFORE handing out calldata.
-- Recovery (lib/server/bag-version-recovery.ts) finds the version on chain by RPC (Bag.CompositionUpdated, version
-- indexed), verifies that transaction's receipt in full, picks the proposal whose on-chain composition hash and
-- metadata URI match it, and records it through the same idempotent record_onchain_bag_version. Nothing is written
-- without that verification.
--
-- A proposal leaves PENDING only when a version row is inserted (trigger below, in the same transaction): the one
-- that matches becomes RECORDED, every other pending proposal built on the same or an older version becomes
-- SUPERSEDED. A failed database write rolls back with it, so the proposal stays PENDING and recovery can retry.

create table if not exists bag_version_proposals (
  id uuid primary key default gen_random_uuid(),
  bag_id uuid not null references bags(id) on delete cascade,
  creator_id uuid not null references users(id),
  wallet text not null check (wallet ~ '^0x[0-9a-f]{40}$'),
  chain text not null,
  chain_id integer not null,
  factory_address text not null check (factory_address ~ '^0x[0-9a-f]{40}$'),
  contract_address text not null check (contract_address ~ '^0x[0-9a-f]{40}$'),
  on_chain_bag_id text not null check (on_chain_bag_id ~ '^0x[0-9a-f]{64}$'),
  expected_onchain_version integer not null check (expected_onchain_version >= 1),
  new_onchain_version integer not null,
  composition_hash text not null,
  onchain_composition_hash text not null check (onchain_composition_hash ~ '^0x[0-9a-f]{64}$'),
  metadata_uri text not null,
  recipe jsonb not null,
  reason text not null default '',
  -- Chain head when first prepared: the transaction cannot be mined before it, so recovery searches from here.
  prepared_block bigint not null check (prepared_block >= 0),
  status text not null default 'PENDING' check (status in ('PENDING', 'RECORDED', 'SUPERSEDED')),
  tx_hash text check (tx_hash is null or tx_hash ~ '^0x[0-9a-f]{64}$'),
  version_id uuid references bag_versions(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (new_onchain_version = expected_onchain_version + 1),
  check ((status = 'RECORDED') = (version_id is not null and tx_hash is not null))
);

-- One pending proposal per (Bag, base version, on-chain content): preparing the same change again reuses it.
create unique index if not exists uq_bag_version_proposals_pending
  on bag_version_proposals (bag_id, expected_onchain_version, onchain_composition_hash)
  where status = 'PENDING';
create index if not exists idx_bag_version_proposals_bag on bag_version_proposals (bag_id, status, expected_onchain_version);

alter table bag_version_proposals enable row level security;
-- No policies: only the service role (server routes) reads or writes proposals; a browser never sees them.
revoke all on table bag_version_proposals from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on table bag_version_proposals from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on table bag_version_proposals from authenticated; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then grant select, insert, update on table bag_version_proposals to service_role; end if;
end $$;

-- Saves the pending proposal for this change, or returns the existing one when it is EXACTLY the same proposal:
-- same canonical recipe body and same identity (owner, wallet, chain, factory, Bag, versions, hashes, URI). The
-- calldata only commits to the assets, so two different bodies for one on-chain composition could not be told apart
-- later; a different body is therefore refused (BAG_VERSION_PROPOSAL_CONFLICT) and the stored proposal is never
-- changed. The unique index makes concurrent prepares of the same key serialize here: one inserts, the other sees
-- its row and either reuses it (identical) or gets the conflict. The first proposal's reason and prepared_block stay.
create or replace function save_bag_version_proposal(
  p_bag_id uuid,
  p_creator_id uuid,
  p_wallet text,
  p_chain text,
  p_chain_id integer,
  p_factory_address text,
  p_contract_address text,
  p_on_chain_bag_id text,
  p_expected_onchain_version integer,
  p_composition_hash text,
  p_onchain_composition_hash text,
  p_metadata_uri text,
  p_recipe jsonb,
  p_reason text,
  p_prepared_block bigint
) returns uuid
language plpgsql
as $$
declare
  v_id uuid;
begin
  insert into bag_version_proposals (bag_id, creator_id, wallet, chain, chain_id, factory_address, contract_address, on_chain_bag_id,
                                     expected_onchain_version, new_onchain_version, composition_hash, onchain_composition_hash,
                                     metadata_uri, recipe, reason, prepared_block)
  values (p_bag_id, p_creator_id, lower(p_wallet), p_chain, p_chain_id, lower(p_factory_address), lower(p_contract_address), lower(p_on_chain_bag_id),
          p_expected_onchain_version, p_expected_onchain_version + 1, p_composition_hash, lower(p_onchain_composition_hash),
          p_metadata_uri, p_recipe, coalesce(p_reason, ''), p_prepared_block)
  on conflict (bag_id, expected_onchain_version, onchain_composition_hash) where status = 'PENDING'
  do update set updated_at = bag_version_proposals.updated_at
   where bag_version_proposals.recipe = excluded.recipe
     and bag_version_proposals.creator_id = excluded.creator_id
     and bag_version_proposals.wallet = excluded.wallet
     and bag_version_proposals.chain = excluded.chain
     and bag_version_proposals.chain_id = excluded.chain_id
     and bag_version_proposals.factory_address = excluded.factory_address
     and bag_version_proposals.contract_address = excluded.contract_address
     and bag_version_proposals.on_chain_bag_id = excluded.on_chain_bag_id
     and bag_version_proposals.composition_hash = excluded.composition_hash
     and bag_version_proposals.metadata_uri = excluded.metadata_uri
  returning id into v_id;
  if v_id is null then
    raise exception 'BAG_VERSION_PROPOSAL_CONFLICT: a different pending proposal exists for this Bag, version and composition'
      using errcode = 'P0001';
  end if;
  return v_id;
end;
$$;

create or replace function settle_bag_version_proposals() returns trigger
language plpgsql
as $$
begin
  if new.onchain_tx_hash is null or new.onchain_version is null then return new; end if;
  update bag_version_proposals
     set status = 'RECORDED', tx_hash = new.onchain_tx_hash, version_id = new.id, updated_at = now()
   where bag_id = new.bag_id and status = 'PENDING'
     and expected_onchain_version = new.onchain_version - 1
     and onchain_composition_hash = lower(new.onchain_composition_hash)
     and metadata_uri = new.metadata_uri;
  update bag_version_proposals
     set status = 'SUPERSEDED', updated_at = now()
   where bag_id = new.bag_id and status = 'PENDING' and expected_onchain_version <= new.onchain_version - 1;
  return new;
end;
$$;

drop trigger if exists bag_versions_settle_proposals on bag_versions;
create trigger bag_versions_settle_proposals
  after insert on bag_versions
  for each row execute function settle_bag_version_proposals();

do $$
declare
  v_sig text;
begin
  foreach v_sig in array array[
    'save_bag_version_proposal(uuid, uuid, text, text, integer, text, text, text, integer, text, text, text, jsonb, text, bigint)',
    'settle_bag_version_proposals()'
  ] loop
    execute format('revoke execute on function %s from public', v_sig);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke execute on function %s from anon', v_sig); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke execute on function %s from authenticated', v_sig); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', v_sig); end if;
  end loop;
end $$;

notify pgrst, 'reload schema';
