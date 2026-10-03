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
