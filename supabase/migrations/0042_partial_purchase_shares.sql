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

notify pgrst, 'reload schema';
