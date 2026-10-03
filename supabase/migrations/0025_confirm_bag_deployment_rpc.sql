-- 0025_confirm_bag_deployment_rpc.sql
--
-- `confirm_bag_deployment(...)` — the ONLY writer of a DEPLOYED row and of the
-- Bag finalization that logically belongs to the same event. Called solely by
-- lib/server/bag-deployment-repo.ts (`confirmUserSignedDeployment`) through
-- the service-role client, AFTER lib/blockchain/evm/adapter.ts's
-- `verifyBagCreation()` independently verified the transaction on-chain.
--
-- ATOMICITY. One database transaction: deployment row (INSERT/UPDATE to
-- DEPLOYED) + `bags.registry_id/contract_address` (first deployment pointer) +
-- `bags.status` DRAFT -> ACTIVE. Either all of it commits or none of it does —
-- there is no window with "deployment = DEPLOYED, Bag = DRAFT". The deferred
-- constraint triggers from 0024 additionally make that state impossible to
-- persist by ANY writer.
--
-- CONCURRENCY. The function first takes `SELECT ... FOR UPDATE` on the BAG
-- row (which always exists, unlike a not-yet-created deployment row), so two
-- simultaneous first confirmations for the same Bag serialize here: the second
-- sees the first's committed DEPLOYED row and returns ALREADY_CONFIRMED (same
-- tx) or CONFLICT (different tx) — never a duplicate row. `createBagVersion`
-- takes the same bag-row lock, so a recipe edit cannot interleave with this
-- transaction. The unique (bag_id, chain) index from 0024/schema.sql remains
-- the last-line guarantee against any writer that bypasses this function.
--
-- STALE RECIPE. The caller passes the bag_versions.id whose composition hash
-- it verified on-chain; if `bags.current_version_id` changed since, this
-- returns STALE_VERSION and writes nothing (the transaction's hash no longer
-- matches the Bag's current composition).
--
-- OUTCOMES (jsonb `outcome`): CONFIRMED | ALREADY_CONFIRMED | CONFLICT |
-- STALE_VERSION | IDENTITY_TAKEN | BAG_NOT_FOUND | FORBIDDEN.
--
-- PRIVILEGES. Execute is revoked from PUBLIC *and explicitly from anon and
-- authenticated* (Supabase's default privileges grant EXECUTE on new public
-- functions to those roles directly, so `revoke ... from public` alone does
-- NOT close it) and granted only to service_role.

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
