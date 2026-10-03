-- 0017_atomic_fork_royalty_settlement_row.sql
--
-- Closes a real crash-window bug in 0016's fix: 0016 made
-- apply_purchase_execution() RETURN the royalty activity id so
-- lib/server/purchase-execution.ts could insert the matching
-- creator_reward_settlements row itself — but that insert happens in a
-- SEPARATE statement, AFTER this function's own transaction (which sets
-- purchase_intents.accounting_applied_at) has already committed. If the
-- process crashes between those two steps, the RPC's own idempotency
-- check (`v_already_applied is not null`) means a retry returns
-- `royaltyActivityId: null` — the settlement row can then NEVER be
-- created via the normal path again, for that specific royalty. (Migration
-- 0015's backfill functions happen to cover this narrow window too, since
-- they find ANY unsettled FORK_ROYALTY_EARNED row regardless of when it
-- was created — but relying on periodically re-running a "legacy backfill"
-- function to patch a live crash-recovery gap is fragile and easy to
-- forget to schedule.)
--
-- The real fix: insert the creator_reward_settlements row INSIDE this
-- function's own transaction, atomically with the activities/portfolios
-- writes it already does. There is no longer a window where the royalty
-- is "earned" in the DB but has no possible path to a settlement row.
--
-- 5th revision of this function (0004 -> 0011 -> 0012 -> 0013 -> 0016 ->
-- here). `royaltyActivityId`/`royaltyAmount` stay in the returned jsonb
-- for observability/logging (lib/server/purchase-execution.ts no longer
-- needs to act on them to create the settlement row, but keeping them
-- costs nothing and lets a caller log "a royalty of $X was earned by
-- creator Y" without a second query).
create or replace function apply_purchase_execution(
  p_intent_id uuid,
  p_bag_id uuid,
  p_holdings jsonb,
  p_shares_delta_raw text,
  p_share_decimals integer,
  p_user_id uuid,
  p_cost_basis_delta text default '0',
  p_fork_royalty_bps integer default 0,
  p_root_creator_id uuid default null
) returns jsonb
language plpgsql
as $$
declare
  v_already_applied timestamptz;
  v_result jsonb;
  v_royalty_amount numeric;
  v_royalty_activity_id uuid;
  v_root_creator_wallet text;
begin
  select accounting_applied_at into v_already_applied
  from purchase_intents
  where id = p_intent_id
  for update;

  if v_already_applied is not null then
    select jsonb_build_object(
      'alreadyApplied', true,
      'holdings', coalesce((select jsonb_agg(to_jsonb(bh.*)) from bag_holdings bh where bh.bag_id = p_bag_id), '[]'::jsonb),
      'shareState', (select to_jsonb(s.*) from bag_share_state s where s.bag_id = p_bag_id),
      'investorPosition', (select to_jsonb(p.*) from bag_investor_positions p where p.bag_id = p_bag_id and p.user_id = p_user_id),
      'royaltyActivityId', null,
      'royaltyAmount', null
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

  insert into bag_investor_holdings (user_id, bag_id, chain, address, quantity_raw, decimals)
  select
    p_user_id,
    p_bag_id,
    (h->>'chain')::text,
    (h->>'address')::text,
    (h->>'delta_raw')::text,
    (h->>'decimals')::integer
  from jsonb_array_elements(p_holdings) as h
  on conflict (user_id, bag_id, chain, address) do update
    set quantity_raw = (bag_investor_holdings.quantity_raw::numeric + excluded.quantity_raw::numeric)::text,
        updated_at = now();

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

  if p_root_creator_id is not null and p_root_creator_id <> p_user_id and p_fork_royalty_bps > 0 and p_cost_basis_delta::numeric > 0 then
    v_royalty_amount := round(p_cost_basis_delta::numeric * p_fork_royalty_bps / 10000.0, 2);
    if v_royalty_amount > 0 then
      update portfolios
      set cash_balance = cash_balance + v_royalty_amount,
          updated_at = now()
      where user_id = p_root_creator_id;

      insert into activities (user_id, action)
      values (p_root_creator_id, 'FORK_ROYALTY_EARNED:' || v_royalty_amount::text || ':' || p_bag_id::text)
      returning id into v_royalty_activity_id;

      -- SAME transaction as the activity row above — this is the actual
      -- fix (see module doc). No creator_reward_settlements row can now
      -- exist without its source activity row, or vice versa: both commit
      -- together or neither does.
      select wallet_address into v_root_creator_wallet from users where id = p_root_creator_id;
      if v_root_creator_wallet is null then
        raise exception 'FORK_ROYALTY_SETTLEMENT_NO_WALLET: root creator % has no wallet_address on file — cannot record a settleable royalty', p_root_creator_id;
      end if;

      insert into creator_reward_settlements (
        creator_id, creator_wallet, bag_id, reward_type,
        source_activity_id, gross_amount_quote, reward_amount_token_raw,
        reward_token_address, reward_token_decimals, reward_chain_id,
        status
      ) values (
        p_root_creator_id, v_root_creator_wallet, p_bag_id, 'FORK_ROYALTY',
        v_royalty_activity_id, v_royalty_amount::text,
        -- USDG, 6 decimals, chain 4663 — same verified constants as
        -- lib/config/robinhood-chain.ts (ROBINHOOD_REWARD_TOKEN /
        -- ROBINHOOD_CHAIN_ID). v_royalty_amount is always already rounded
        -- to <= 2 decimal places above, so floor(amount * 10^6) is exact.
        floor(v_royalty_amount * 1000000)::text,
        '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', 6, 4663,
        'EARNED'
      );
    end if;
  end if;

  update purchase_intents
  set accounting_applied_at = now()
  where id = p_intent_id;

  insert into activities (user_id, action)
  values (p_user_id, 'PURCHASE_EXECUTED:' || p_intent_id::text || ':' || p_bag_id::text);

  select jsonb_build_object(
    'alreadyApplied', false,
    'holdings', coalesce((select jsonb_agg(to_jsonb(bh.*)) from bag_holdings bh where bh.bag_id = p_bag_id), '[]'::jsonb),
    'shareState', (select to_jsonb(s.*) from bag_share_state s where s.bag_id = p_bag_id),
    'investorPosition', (select to_jsonb(p.*) from bag_investor_positions p where p.bag_id = p_bag_id and p.user_id = p_user_id),
    'royaltyActivityId', v_royalty_activity_id,
    'royaltyAmount', v_royalty_amount
  ) into v_result;

  return v_result;
end;
$$;

revoke execute on function apply_purchase_execution from public;
grant execute on function apply_purchase_execution to service_role;
