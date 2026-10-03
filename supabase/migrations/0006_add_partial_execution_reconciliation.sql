-- Phase 18 — LI.FI Partial Execution + Reconciliation.
--
-- Adds the two new terminal-path statuses a multi-step on-chain execution
-- needs once it's no longer pretended to be atomic (see
-- lib/server/purchase-execution.ts's verifyExecution()/
-- reconcilePartialExecution(), and types/purchase-intent.ts's
-- PURCHASE_INTENT_STATUSES doc for the full reasoning), the matching
-- column, and the apply_partial_purchase_execution() RPC that credits
-- verified-only holdings without ever minting shares for a
-- partially-fulfilled deposit.

alter table purchase_intents
  drop constraint if exists purchase_intents_status_check;

alter table purchase_intents
  add constraint purchase_intents_status_check check (status in (
    'DRAFT', 'QUOTED', 'READY', 'AWAITING_SIGNATURE', 'SUBMITTED',
    'CONFIRMING', 'COMPLETED', 'PARTIAL_SUCCESS', 'RECONCILIATION_REQUIRED',
    'FAILED', 'EXPIRED', 'CANCELLED'
  ));

alter table purchase_intents
  add column if not exists reconciliation_applied_at timestamptz;

create or replace function apply_partial_purchase_execution(
  p_intent_id uuid,
  p_bag_id uuid,
  p_holdings jsonb,
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
