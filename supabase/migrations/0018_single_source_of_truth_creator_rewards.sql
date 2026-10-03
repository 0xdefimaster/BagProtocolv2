-- 0018_single_source_of_truth_creator_rewards.sql
--
-- P0 fix (V10 hardening brief): creator rewards were representable in TWO
-- places at once — `portfolios.cash_balance` (spendable paper trading
-- cash) AND `creator_reward_settlements`/`CreatorRewardsVault` (the real
-- on-chain claim path). A creator's fork royalty was being credited to
-- BOTH; their performance fee was being credited to cash_balance ONLY,
-- with no on-chain path at all. Fixes both:
--
-- 1. `apply_purchase_execution()` (6th revision: 0004 -> 0011 -> 0012 ->
--    0013 -> 0016 -> 0017 -> here): stops crediting
--    `portfolios.cash_balance` for fork royalty. The `activities` row and
--    the atomic `creator_reward_settlements` insert (0017's real fix)
--    stay exactly as they were — only the redundant cash mutation is
--    removed. `CreatorRewardsVault.balanceOf(creatorWallet)` (via the
--    settlement worker) is now the ONLY place this money is spendable.
--
-- 2. `apply_redeem_execution()` (2nd revision of the Phase 22 fee logic):
--    same fix, PLUS gains what fork royalty already had — a
--    `creator_reward_settlements` row inserted atomically, in the SAME
--    transaction as the fee calculation, so performance fee now has a
--    real settlement path via the SAME cron worker
--    (`runSettlementBatch()`) fork royalty already uses. This is
--    deliberately the "settlement wallet as fallback/async mechanism"
--    model the V10 brief explicitly allows for cases where a fully
--    atomic at-transaction-time settlement isn't achievable — redemption
--    here still goes through the legacy multi-step accounting RPC, not
--    RedeemFeeRouter (see docs/FINAL_PRODUCTION_AUDIT.md's B.1 for why
--    that's still blocked on an unverified swap-target address), so this
--    is the correct interim source of truth: EARNED in
--    creator_reward_settlements, settled for real by the same worker
--    that already handles fork royalty, NEVER as spendable cash.
--
-- Uses `p_intent_id` directly as `source_redeem_intent_id` — a real
-- foreign key to `redeem_intents.id` that this function already has in
-- hand, unlike migration 0015's legacy backfill, which had to CORRELATE a
-- pre-0014 activity row to its redeem_intents.id via a same-transaction
-- timestamp trick because it never had the real id available. New rows
-- created by this function need no such correlation.

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
      -- P0 FIX (0018): no `portfolios.cash_balance` mutation here anymore
      -- — see this migration's module doc. The activities row + the
      -- creator_reward_settlements insert below are the ONLY records of
      -- this royalty; CreatorRewardsVault.balanceOf is the only place
      -- it's ever spendable.
      insert into activities (user_id, action)
      values (p_root_creator_id, 'FORK_ROYALTY_EARNED:' || v_royalty_amount::text || ':' || p_bag_id::text)
      returning id into v_royalty_activity_id;

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

-- Explicit signature (not just the bare name) to avoid "function name is
-- not unique" — earlier migrations (0004 onward) left older-signature
-- overloads of this function un-dropped, and a bare `revoke ... on
-- function apply_purchase_execution` fails ambiguously when more than one
-- overload exists. This was a real latent bug in 0016/0017's own revoke
-- statements too (confirmed: it silently aborted the rest of the script
-- under `psql -v ON_ERROR_STOP=1`, meaning nothing after that line in
-- those files ran when applied strictly) — fixed here going forward
-- rather than editing already-shipped migration files.
revoke execute on function apply_purchase_execution(uuid, uuid, jsonb, text, integer, uuid, text, integer, uuid) from public;
grant execute on function apply_purchase_execution(uuid, uuid, jsonb, text, integer, uuid, text, integer, uuid) to service_role;

create or replace function apply_redeem_execution(
  p_intent_id uuid,
  p_bag_id uuid,
  p_holdings_sold jsonb,
  p_shares_burn_raw text,
  p_share_decimals integer,
  p_user_id uuid,
  p_redeem_value_quote text default '0',
  p_performance_fee_bps integer default 0,
  p_creator_id uuid default null
) returns jsonb
language plpgsql
as $$
declare
  v_already_applied timestamptz;
  v_position bag_investor_positions%rowtype;
  v_new_shares numeric;
  v_new_cost_basis numeric;
  v_consumed_cost_basis numeric;
  v_profit numeric;
  v_fee_amount numeric;
  v_fee_activity_id uuid;
  v_creator_wallet text;
  v_result jsonb;
  h jsonb;
  v_chain text;
  v_address text;
  v_qty numeric;
  v_row_count integer;
begin
  select accounting_applied_at into v_already_applied
  from redeem_intents
  where id = p_intent_id
  for update;

  if v_already_applied is not null then
    select jsonb_build_object(
      'alreadyApplied', true,
      'holdings', coalesce((select jsonb_agg(to_jsonb(bh.*)) from bag_holdings bh where bh.bag_id = p_bag_id), '[]'::jsonb),
      'shareState', (select to_jsonb(s.*) from bag_share_state s where s.bag_id = p_bag_id),
      'investorPosition', (select to_jsonb(p.*) from bag_investor_positions p where p.bag_id = p_bag_id and p.user_id = p_user_id),
      'feeActivityId', null,
      'feeAmount', null
    ) into v_result;
    return v_result;
  end if;

  select * into v_position
  from bag_investor_positions
  where user_id = p_user_id and bag_id = p_bag_id
  for update;

  if not found or v_position.shares_raw::numeric < p_shares_burn_raw::numeric then
    raise exception 'INSUFFICIENT_SHARES: user % bag % has % raw shares, tried to burn %',
      p_user_id, p_bag_id, coalesce(v_position.shares_raw, '0'), p_shares_burn_raw;
  end if;

  v_new_shares := v_position.shares_raw::numeric - p_shares_burn_raw::numeric;
  v_new_cost_basis := case
    when v_position.shares_raw::numeric = 0 then 0
    else v_position.cost_basis_quote::numeric * v_new_shares / v_position.shares_raw::numeric
  end;

  v_consumed_cost_basis := v_position.cost_basis_quote::numeric - v_new_cost_basis;
  v_profit := p_redeem_value_quote::numeric - v_consumed_cost_basis;

  update bag_investor_positions
  set shares_raw = v_new_shares::text,
      cost_basis_quote = v_new_cost_basis::text,
      updated_at = now()
  where user_id = p_user_id and bag_id = p_bag_id;

  update bag_share_state
  set total_shares_raw = (total_shares_raw::numeric - p_shares_burn_raw::numeric)::text,
      updated_at = now()
  where bag_id = p_bag_id;

  for h in select * from jsonb_array_elements(p_holdings_sold) loop
    v_chain := h->>'chain';
    v_address := h->>'address';
    v_qty := (h->>'quantity_raw')::numeric;

    update bag_holdings
    set quantity_raw = (quantity_raw::numeric - v_qty)::text, updated_at = now()
    where bag_id = p_bag_id and chain = v_chain and address = v_address
      and quantity_raw::numeric >= v_qty;
    get diagnostics v_row_count = row_count;
    if v_row_count = 0 then
      raise exception 'HOLDINGS_UNDERFLOW: bag % chain % address % cannot sell % (stale allocation)',
        p_bag_id, v_chain, v_address, v_qty;
    end if;

    update bag_investor_holdings
    set quantity_raw = (quantity_raw::numeric - v_qty)::text, updated_at = now()
    where user_id = p_user_id and bag_id = p_bag_id and chain = v_chain and address = v_address
      and quantity_raw::numeric >= v_qty;
    get diagnostics v_row_count = row_count;
    if v_row_count = 0 then
      raise exception 'INVESTOR_HOLDINGS_UNDERFLOW: user % bag % chain % address % cannot sell % (stale allocation)',
        p_user_id, p_bag_id, v_chain, v_address, v_qty;
    end if;
  end loop;

  -- P0 FIX (0018): performance fee no longer touches `portfolios.cash_balance`
  -- — it now gets the SAME atomic creator_reward_settlements treatment
  -- fork royalty already has (0017), using `p_intent_id` directly as
  -- `source_redeem_intent_id` (a real FK this function already holds, no
  -- correlation trick needed — contrast migration 0015's legacy backfill).
  -- Never charged on a loss (v_profit <= 0), never charged to a creator
  -- redeeming their own bag — unchanged from the original rule.
  if p_creator_id is not null and p_creator_id <> p_user_id and p_performance_fee_bps > 0 and v_profit > 0 then
    v_fee_amount := round(v_profit * p_performance_fee_bps / 10000.0, 2);
    if v_fee_amount > 0 then
      insert into activities (user_id, action)
      values (p_creator_id, 'PERFORMANCE_FEE_EARNED:' || v_fee_amount::text || ':' || p_bag_id::text)
      returning id into v_fee_activity_id;

      select wallet_address into v_creator_wallet from users where id = p_creator_id;
      if v_creator_wallet is null then
        raise exception 'PERFORMANCE_FEE_SETTLEMENT_NO_WALLET: creator % has no wallet_address on file — cannot record a settleable fee', p_creator_id;
      end if;

      insert into creator_reward_settlements (
        creator_id, creator_wallet, bag_id, reward_type,
        source_activity_id, source_redeem_intent_id,
        gross_amount_quote, reward_amount_token_raw,
        reward_token_address, reward_token_decimals, reward_chain_id,
        status
      ) values (
        p_creator_id, v_creator_wallet, p_bag_id, 'PERFORMANCE_FEE',
        v_fee_activity_id, p_intent_id,
        v_fee_amount::text, floor(v_fee_amount * 1000000)::text,
        '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', 6, 4663,
        'EARNED'
      );
    end if;
  end if;

  update redeem_intents
  set accounting_applied_at = now()
  where id = p_intent_id;

  insert into activities (user_id, action)
  values (p_user_id, 'REDEEM_EXECUTED:' || p_intent_id::text || ':' || p_bag_id::text);

  select jsonb_build_object(
    'alreadyApplied', false,
    'holdings', coalesce((select jsonb_agg(to_jsonb(bh.*)) from bag_holdings bh where bh.bag_id = p_bag_id), '[]'::jsonb),
    'shareState', (select to_jsonb(s.*) from bag_share_state s where s.bag_id = p_bag_id),
    'investorPosition', (select to_jsonb(p.*) from bag_investor_positions p where p.bag_id = p_bag_id and p.user_id = p_user_id),
    'feeActivityId', v_fee_activity_id,
    'feeAmount', v_fee_amount
  ) into v_result;

  return v_result;
end;
$$;

revoke execute on function apply_redeem_execution(uuid, uuid, jsonb, text, integer, uuid, text, integer, uuid) from public;
grant execute on function apply_redeem_execution(uuid, uuid, jsonb, text, integer, uuid, text, integer, uuid) to service_role;
