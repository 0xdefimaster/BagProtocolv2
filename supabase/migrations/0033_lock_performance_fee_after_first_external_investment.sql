-- 0033_lock_performance_fee_after_first_external_investment.sql
--
-- ECONOMIC INVARIANT (MVP, deliberately simple): a Bag's performance fee is
-- IMMUTABLE once the first EXTERNAL investor (anyone other than the Bag's
-- creator) holds a position. Before that, the creator may set or change it
-- freely (a new version with a different `recipe.performanceFeeBps`).
--
-- Why: apply_redeem_execution() charged whatever `performanceFeeBps` the
-- Bag's CURRENT version carried at redemption time, so a creator could raise
-- the fee on a later version and apply it retroactively to investors who
-- bought under the old one. A lot-by-lot historical fee snapshot would fix
-- that too, but nothing else in this schema is lot-based (a position is one
-- aggregate row with proportional cost basis), so "locked after first
-- external investment" is the invariant that fits the existing model.
--
-- Enforcement is DATABASE-AUTHORITATIVE (no API/RPC/script can bypass it):
--   * bags.performance_fee_locked_at / performance_fee_bps_locked — set ONCE,
--     by trigger, when a non-creator position first holds shares > 0; the
--     locked rate is the current version's fee at that moment.
--   * bag_versions insert/update — a locked Bag can never get a version (or
--     a fee edit) whose fee differs from the locked rate; any version's fee
--     must be an integer 0..3000 bps (MAX_PERFORMANCE_FEE_BPS).
--   * bags update — the lock can never be cleared or altered, and
--     current_version_id can never be pointed at a version with another fee.
--   * apply_redeem_execution() — uses the LOCKED rate, not the caller's.
-- Creator-only activity (the creator buying into their own Bag) never locks.
-- The lock is permanent: it does not lift if every external investor later
-- redeems (simplest safe rule — no "unlock window" to reason about).
-- Forks are new Bags with their own, independent lock (see fork route).

alter table bags add column if not exists performance_fee_locked_at timestamptz;
alter table bags add column if not exists performance_fee_bps_locked integer;
alter table bags drop constraint if exists bags_performance_fee_lock_consistent;
alter table bags add constraint bags_performance_fee_lock_consistent check (
  (performance_fee_locked_at is null and performance_fee_bps_locked is null)
  or (performance_fee_locked_at is not null and performance_fee_bps_locked between 0 and 3000)
);

-- The ONE reader of a recipe's fee in SQL. Missing/null = 0 (the TS default).
-- Anything else must be an integer 0..3000 — the same bounds as
-- validateBasketRecipe() (MAX_PERFORMANCE_FEE_BPS), enforced here too so a
-- direct write cannot store a fee the application would refuse.
create or replace function recipe_performance_fee_bps(p_recipe jsonb) returns integer
language plpgsql
immutable
as $$
declare
  v_raw jsonb := p_recipe->'performanceFeeBps';
  v_num numeric;
begin
  if v_raw is null or jsonb_typeof(v_raw) = 'null' then
    return 0;
  end if;
  if jsonb_typeof(v_raw) <> 'number' then
    raise exception 'INVALID_PERFORMANCE_FEE: % is not a number', v_raw using errcode = 'check_violation';
  end if;
  v_num := (v_raw #>> '{}')::numeric;
  if v_num <> trunc(v_num) or v_num < 0 or v_num > 3000 then
    raise exception 'INVALID_PERFORMANCE_FEE: % (must be an integer 0..3000 bps)', v_num using errcode = 'check_violation';
  end if;
  return v_num::integer;
end;
$$;

-- Locks the fee the first time a NON-creator position holds shares.
create or replace function lock_performance_fee_on_external_position() returns trigger
language plpgsql
as $$
declare
  v_bag bags%rowtype;
  v_fee integer;
begin
  if NEW.shares_raw::numeric <= 0 then
    return NEW;
  end if;
  -- Row lock first (serializes with create_bag_version / direct version writes),
  -- THEN read the current version in a separate statement so it sees the latest
  -- committed current_version_id.
  select * into v_bag from bags where id = NEW.bag_id for update;
  if not found or v_bag.creator_id = NEW.user_id or v_bag.performance_fee_locked_at is not null then
    return NEW;
  end if;
  select recipe_performance_fee_bps(v.recipe) into v_fee from bag_versions v where v.id = v_bag.current_version_id;
  update bags
     set performance_fee_locked_at = now(),
         performance_fee_bps_locked = coalesce(v_fee, 0)
   where id = NEW.bag_id;
  return NEW;
end;
$$;

drop trigger if exists trg_lock_performance_fee_on_external_position on bag_investor_positions;
create trigger trg_lock_performance_fee_on_external_position
  after insert or update of shares_raw on bag_investor_positions
  for each row execute function lock_performance_fee_on_external_position();

create or replace function guard_performance_fee_lock_on_bags() returns trigger
language plpgsql
as $$
declare
  v_fee integer;
begin
  if OLD.performance_fee_locked_at is not null
     and (NEW.performance_fee_locked_at is distinct from OLD.performance_fee_locked_at
          or NEW.performance_fee_bps_locked is distinct from OLD.performance_fee_bps_locked) then
    raise exception 'PERFORMANCE_FEE_LOCKED: bag % performance fee lock is permanent', OLD.id using errcode = 'check_violation';
  end if;
  if NEW.performance_fee_locked_at is not null
     and (OLD.performance_fee_locked_at is null or NEW.current_version_id is distinct from OLD.current_version_id)
     and NEW.current_version_id is not null then
    select recipe_performance_fee_bps(recipe) into v_fee from bag_versions where id = NEW.current_version_id;
    if v_fee is distinct from NEW.performance_fee_bps_locked then
      raise exception 'PERFORMANCE_FEE_LOCKED: bag % fee is locked at % bps; version % carries % bps',
        NEW.id, NEW.performance_fee_bps_locked, NEW.current_version_id, v_fee using errcode = 'check_violation';
    end if;
  end if;
  return NEW;
end;
$$;

drop trigger if exists trg_guard_performance_fee_lock_on_bags on bags;
create trigger trg_guard_performance_fee_lock_on_bags
  before update on bags
  for each row execute function guard_performance_fee_lock_on_bags();

create or replace function guard_performance_fee_on_versions() returns trigger
language plpgsql
as $$
declare
  v_bag bags%rowtype;
  v_fee integer;
begin
  v_fee := recipe_performance_fee_bps(NEW.recipe); -- also validates the range
  select * into v_bag from bags where id = NEW.bag_id for update;
  if found and v_bag.performance_fee_locked_at is not null and v_fee <> v_bag.performance_fee_bps_locked then
    if TG_OP = 'INSERT' or recipe_performance_fee_bps(OLD.recipe) <> v_fee then
      raise exception 'PERFORMANCE_FEE_LOCKED: bag % fee is locked at % bps (an external investor exists); refusing % bps',
        NEW.bag_id, v_bag.performance_fee_bps_locked, v_fee using errcode = 'check_violation';
    end if;
  end if;
  return NEW;
end;
$$;

drop trigger if exists trg_guard_performance_fee_on_versions on bag_versions;
create trigger trg_guard_performance_fee_on_versions
  before insert or update on bag_versions
  for each row execute function guard_performance_fee_on_versions();

-- Backfill: any Bag that ALREADY has a non-creator position with shares is locked
-- at its current version's fee (an external investment already happened).
update bags b
   set performance_fee_locked_at = now(),
       performance_fee_bps_locked = coalesce((select recipe_performance_fee_bps(v.recipe) from bag_versions v where v.id = b.current_version_id), 0)
 where b.performance_fee_locked_at is null
   and exists (
     select 1 from bag_investor_positions p
      where p.bag_id = b.id and p.user_id <> b.creator_id and p.shares_raw::numeric > 0
   );

-- apply_redeem_execution: 0018's body, with the fee rate taken from the lock.
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
  -- 0033: the fee RATE is the bag's LOCKED rate once the first external
  -- investor exists (always the case when a non-creator is redeeming — a
  -- redeemer holds shares, and holding shares locked the fee). The caller's
  -- p_performance_fee_bps is only a fallback for a never-locked bag, where
  -- no fee-bearing (non-creator) redemption can exist anyway.
  select coalesce(performance_fee_bps_locked, p_performance_fee_bps) into v_fee_bps from bags where id = p_bag_id;

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

do $$
declare
  v_sig text;
begin
  foreach v_sig in array array[
    'recipe_performance_fee_bps(jsonb)',
    'lock_performance_fee_on_external_position()',
    'guard_performance_fee_lock_on_bags()',
    'guard_performance_fee_on_versions()',
    'apply_redeem_execution(uuid, uuid, jsonb, text, integer, uuid, text, integer, uuid)'
  ] loop
    execute format('revoke execute on function %s from public', v_sig);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke execute on function %s from anon', v_sig); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke execute on function %s from authenticated', v_sig); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', v_sig); end if;
  end loop;
end $$;
