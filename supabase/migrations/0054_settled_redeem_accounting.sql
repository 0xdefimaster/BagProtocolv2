-- 0054_settled_redeem_accounting.sql
--
-- §9 — accounting for a fee-paying sale settled through RedeemSettlement
-- (docs/LIFI_COMPOSER_FEE_SETTLEMENT_FEASIBILITY.md). The contract computed the fee and paid it to the creator in the
-- same transaction; its Settled event is the source of truth and verification copies it into
-- redeem_intents.settlement_plan.result before calling this function.
--
-- The one change from the 0051 definition: for an intent with an attested settlement plan, no database fee is booked
-- (no PERFORMANCE_FEE_EARNED activity, no EARNED creator_reward_settlements row — either would pay the creator a
-- second time), the on-chain fee is written to the ledger as FEE_CHARGED with settledOnchain = true, and the function
-- refuses to run without the event result. The legs' proceeds are the gross amount that reached the settlement (the
-- event's `received`), so realized P&L and the high-water mark are on the same footing as the fee the contract
-- computed; the fee itself is the separate FEE_CHARGED entry, exactly like the database-booked fee before it.
-- Signature unchanged. Everything else is byte-for-byte the 0051 definition.

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
  v_intent_user uuid;
  v_intent_bag uuid;
  v_intent_status text;
  v_settlement jsonb;
  v_onchain_fee_raw numeric;
  v_position bag_investor_positions%rowtype;
  v_new_shares numeric;
  v_new_cost_basis numeric;
  v_consumed_cost_basis numeric;
  v_profit numeric;
  v_fee_amount numeric;
  v_fee_bps integer;
  v_fee_activity_id uuid;
  v_creator_wallet text;
  v_result jsonb;
  h jsonb;
  v_chain text;
  v_address text;
  v_qty numeric;
  v_row_count integer;
begin
  -- 0036: the intent must exist and belong to exactly this (user, bag) — an
  -- unknown id used to be accounted with NO idempotency row, so every retry
  -- minted/burned again.
  select accounting_applied_at, user_id, bag_id, status, settlement_plan
    into v_already_applied, v_intent_user, v_intent_bag, v_intent_status, v_settlement
  from redeem_intents
  where id = p_intent_id
  for update;
  if not found then
    raise exception 'INTENT_NOT_FOUND: redeem intent %', p_intent_id using errcode = 'no_data_found';
  end if;
  if v_intent_user is distinct from p_user_id or v_intent_bag is distinct from p_bag_id then
    raise exception 'INTENT_MISMATCH: redeem intent % belongs to user % bag %, not user % bag %',
      p_intent_id, v_intent_user, v_intent_bag, p_user_id, p_bag_id using errcode = 'check_violation';
  end if;

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

  -- 0036: a failed / expired / cancelled / partially-executed intent never
  -- produces full accounting (no share mint, no share burn), whatever the caller says.
  if v_intent_status in ('FAILED', 'EXPIRED', 'CANCELLED', 'PARTIAL_SUCCESS', 'RECONCILIATION_REQUIRED') then
    raise exception 'INTENT_NOT_EXECUTABLE: redeem intent % is %', p_intent_id, v_intent_status using errcode = 'check_violation';
  end if;
  -- 0051 (A4): shares are no longer an economic quantity. A sale is a fraction of the holdings, and the legacy
  -- share burn may be 0 when no shares are left (holdings that outlived them). It must never be negative, and a
  -- full-accounting call must still remove something.
  if p_shares_burn_raw::numeric < 0 or p_redeem_value_quote::numeric < 0 then
    raise exception 'INVALID_ACCOUNTING_DELTA: burn %, value % must be non-negative', p_shares_burn_raw, p_redeem_value_quote
      using errcode = 'check_violation';
  end if;
  if p_shares_burn_raw::numeric = 0 and jsonb_array_length(coalesce(p_holdings_sold, '[]'::jsonb)) = 0 then
    raise exception 'INVALID_ACCOUNTING_DELTA: nothing sold and nothing burned' using errcode = 'check_violation';
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
  -- 0033: the fee RATE is the bag's LOCKED rate once the first external
  -- investor exists (always the case when a non-creator is redeeming — a
  -- redeemer holds shares, and holding shares locked the fee). The caller's
  -- p_performance_fee_bps is only a fallback for a never-locked bag, where
  -- no fee-bearing (non-creator) redemption can exist anyway.
  select coalesce(performance_fee_bps_locked, p_performance_fee_bps) into v_fee_bps from bags where id = p_bag_id;

  -- 0054: a sale settled through RedeemSettlement (an attested settlement plan) already paid its fee on-chain,
  -- straight to the creator. Its record is the contract's Settled event, copied into settlement_plan.result by
  -- verification before this runs. Booking a database fee (activity + EARNED settlement row) as well would pay the
  -- creator twice, so none is booked; the ledger gets the on-chain fee instead (FEE_CHARGED, settledOnchain), and
  -- without that event result nothing is applied at all.
  if v_settlement ? 'attestedAt' then
    if not (v_settlement ? 'result') or coalesce(v_settlement->'result'->>'fee', '') !~ '^[0-9]+$' then
      raise exception 'SETTLEMENT_RESULT_MISSING: redeem intent % was settled on-chain but has no Settled event result', p_intent_id
        using errcode = 'check_violation';
    end if;
    v_onchain_fee_raw := (v_settlement->'result'->>'fee')::numeric;
    v_fee_bps := 0;
  end if;

  if p_creator_id is not null and p_creator_id <> p_user_id and v_fee_bps > 0 and v_profit > 0 then
    v_fee_amount := round(v_profit * v_fee_bps / 10000.0, 2);
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

  -- Ledger (0048).
  perform ledger_append(
    p_user_id, p_bag_id, 'REDEEM_FILL',
    (select coalesce(jsonb_agg(jsonb_build_object('chain', sold->>'chain', 'address', sold->>'address',
         'decimals', (select ih.decimals from bag_investor_holdings ih where ih.user_id = p_user_id and ih.bag_id = p_bag_id and ih.chain = sold->>'chain' and ih.address = sold->>'address'),
         'deltaRaw', (-((sold->>'quantity_raw')::numeric))::text, 'proceedsQuote', sold->>'proceeds_quote')), '[]'::jsonb)
       from jsonb_array_elements(p_holdings_sold) sold),
    jsonb_build_object('sharesDeltaRaw', (-(p_shares_burn_raw::numeric))::text, 'shareDecimals', p_share_decimals,
      'costBasisDeltaQuote', (v_new_cost_basis - v_position.cost_basis_quote::numeric)::text,
      'redeemValueQuote', p_redeem_value_quote, 'profitQuote', v_profit::text),
    jsonb_build_object('intentKind', 'REDEEM', 'intentId', p_intent_id),
    'REDEEM_FILL:' || p_intent_id::text,
    null
  );
  if v_onchain_fee_raw is not null and v_onchain_fee_raw > 0 then
    perform ledger_append(
      p_user_id, p_bag_id, 'FEE_CHARGED', '[]'::jsonb,
      jsonb_build_object('amountQuote', round(v_onchain_fee_raw / 1000000, 6)::text,
        'baseQuote', round((v_settlement->'result'->>'feeBase')::numeric / 1000000, 6)::text,
        'bps', (v_settlement->>'feeRateBps')::integer, 'creatorId', p_creator_id, 'settledOnchain', true,
        'feeRaw', v_onchain_fee_raw::text, 'txHash', v_settlement->'result'->>'txHash'),
      jsonb_build_object('intentKind', 'REDEEM', 'intentId', p_intent_id),
      'FEE_CHARGED:' || p_intent_id::text,
      null
    );
  end if;
  if v_fee_activity_id is not null then
    perform ledger_append(
      p_user_id, p_bag_id, 'FEE_CHARGED', '[]'::jsonb,
      jsonb_build_object('amountQuote', v_fee_amount::text, 'baseQuote', v_profit::text, 'bps', v_fee_bps, 'creatorId', p_creator_id, 'settledOnchain', false),
      jsonb_build_object('intentKind', 'REDEEM', 'intentId', p_intent_id, 'activityId', v_fee_activity_id),
      'FEE_CHARGED:' || p_intent_id::text,
      null
    );
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
