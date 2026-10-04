-- 0048_ledger_events.sql
--
-- Accounting V2, step A1 (docs/ACCOUNTING_V2_DESIGN.md): an append-only ledger
-- that records every change to an investor's tracked exposure as one immutable
-- event, written in the SAME transaction as the existing accounting tables.
--
--   ledger_events            insert-only; UPDATE / DELETE / TRUNCATE are rejected
--   ledger_append()          the one writer; idempotent on idempotency_key
--   ledger_projection_mismatches()
--                            rebuilds holdings, shares and cost basis from the
--                            events alone and lists every difference from
--                            bag_investor_holdings / bag_investor_positions
--   ledger_backfill_opening_balances()
--                            one OPENING_BALANCE per (user, bag) for state that
--                            predates the ledger: stored state minus whatever
--                            events already exist, so it is correct even if a
--                            fill landed between the function swap and the backfill
--
-- The five accounting RPCs are re-created unchanged except for the ledger
-- writes (marked "Ledger (0048)"). No user or bag foreign keys: the ledger is a
-- historical record and must survive a deleted Bag or user row.
--
-- Safe to run more than once.

create table if not exists ledger_events (
  id uuid primary key default gen_random_uuid(),
  -- Total order of the ledger (events of one transaction share created_at).
  seq bigint generated always as identity unique,
  user_id uuid not null,
  bag_id uuid not null,
  kind text not null check (kind in (
    'OPENING_BALANCE', 'PURCHASE_FILL', 'REDEEM_FILL', 'FEE_CHARGED', 'ROYALTY_ACCRUED',
    'EXTERNAL_OUTFLOW', 'OUTFLOW_CLASSIFIED', 'RECONCILIATION_NOTE'
  )),
  -- [{chain, address, decimals, deltaRaw}] — signed raw quantity change per asset.
  legs jsonb not null default '[]'::jsonb check (jsonb_typeof(legs) = 'array'),
  -- Money and share movements (all decimal strings): sharesDeltaRaw, costBasisDeltaQuote, amountQuote, …
  quote jsonb not null default '{}'::jsonb check (jsonb_typeof(quote) = 'object'),
  -- Where the event comes from: {intentKind, intentId} | {chain, txHash, logIndex} | {migration}.
  source jsonb not null check (jsonb_typeof(source) = 'object'),
  idempotency_key text not null unique,
  strategy_version integer,
  definition_hash text,
  created_at timestamptz not null default now()
);
create index if not exists idx_ledger_events_user_bag on ledger_events(user_id, bag_id, seq);
create index if not exists idx_ledger_events_bag on ledger_events(bag_id, seq);
alter table ledger_events enable row level security;

create or replace function guard_ledger_events_immutable() returns trigger
language plpgsql
as $$
begin
  raise exception 'LEDGER_IMMUTABLE: ledger_events rows cannot be % (append a new event instead)', lower(TG_OP)
    using errcode = 'check_violation';
end;
$$;

drop trigger if exists trg_ledger_events_immutable on ledger_events;
create trigger trg_ledger_events_immutable
  before update or delete on ledger_events
  for each row execute function guard_ledger_events_immutable();

drop trigger if exists trg_ledger_events_no_truncate on ledger_events;
create trigger trg_ledger_events_no_truncate
  before truncate on ledger_events
  for each statement execute function guard_ledger_events_immutable();

revoke all on table ledger_events from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on table ledger_events from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on table ledger_events from authenticated; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on table ledger_events from service_role;
    grant select, insert on table ledger_events to service_role;
  end if;
end $$;

create or replace function ledger_append(
  p_user_id uuid,
  p_bag_id uuid,
  p_kind text,
  p_legs jsonb,
  p_quote jsonb,
  p_source jsonb,
  p_idempotency_key text,
  p_strategy_version integer default null
) returns uuid
language plpgsql
as $$
declare
  v_id uuid;
begin
  insert into ledger_events (user_id, bag_id, kind, legs, quote, source, idempotency_key, strategy_version)
  values (p_user_id, p_bag_id, p_kind, coalesce(p_legs, '[]'::jsonb), coalesce(p_quote, '{}'::jsonb), p_source, p_idempotency_key, p_strategy_version)
  on conflict (idempotency_key) do nothing
  returning id into v_id;
  return v_id;
end;
$$;

-- Kinds that move tracked holdings / shares / cost basis. Fee and royalty events carry money only.
create or replace function ledger_exposure_kinds() returns text[]
language sql immutable
as $$ select array['OPENING_BALANCE', 'PURCHASE_FILL', 'REDEEM_FILL', 'EXTERNAL_OUTFLOW']::text[] $$;

create or replace function ledger_projection_mismatches()
returns table (scope text, user_id uuid, bag_id uuid, chain text, address text, ledger_value numeric, stored_value numeric)
language sql stable
as $$
  with
  lh as (
    select e.user_id, e.bag_id, leg->>'chain' as chain, leg->>'address' as address, sum((leg->>'deltaRaw')::numeric) as v
    from ledger_events e, jsonb_array_elements(e.legs) leg
    where e.kind = any (ledger_exposure_kinds())
    group by 1, 2, 3, 4
  ),
  sh as (select h.user_id, h.bag_id, h.chain, h.address, h.quantity_raw::numeric as v from bag_investor_holdings h),
  lp as (
    select e.user_id, e.bag_id,
           sum(coalesce((e.quote->>'sharesDeltaRaw')::numeric, 0)) as shares,
           sum(coalesce((e.quote->>'costBasisDeltaQuote')::numeric, 0)) as cost
    from ledger_events e
    where e.kind = any (ledger_exposure_kinds())
    group by 1, 2
  ),
  sp as (select p.user_id, p.bag_id, p.shares_raw::numeric as shares, p.cost_basis_quote::numeric as cost from bag_investor_positions p)
  select 'HOLDING', coalesce(lh.user_id, sh.user_id), coalesce(lh.bag_id, sh.bag_id), coalesce(lh.chain, sh.chain), coalesce(lh.address, sh.address),
         coalesce(lh.v, 0), coalesce(sh.v, 0)
  from lh full outer join sh on lh.user_id = sh.user_id and lh.bag_id = sh.bag_id and lh.chain = sh.chain and lh.address = sh.address
  where coalesce(lh.v, 0) <> coalesce(sh.v, 0)
  union all
  select 'SHARES', coalesce(lp.user_id, sp.user_id), coalesce(lp.bag_id, sp.bag_id), null, null, coalesce(lp.shares, 0), coalesce(sp.shares, 0)
  from lp full outer join sp on lp.user_id = sp.user_id and lp.bag_id = sp.bag_id
  where coalesce(lp.shares, 0) <> coalesce(sp.shares, 0)
  union all
  select 'COST_BASIS', coalesce(lp.user_id, sp.user_id), coalesce(lp.bag_id, sp.bag_id), null, null, coalesce(lp.cost, 0), coalesce(sp.cost, 0)
  from lp full outer join sp on lp.user_id = sp.user_id and lp.bag_id = sp.bag_id
  where coalesce(lp.cost, 0) <> coalesce(sp.cost, 0)
$$;

create or replace function ledger_backfill_opening_balances() returns integer
language plpgsql
as $$
declare
  v_count integer;
begin
  -- No accounting write may interleave with the computation below.
  lock table bag_investor_holdings, bag_investor_positions in share row exclusive mode;

  with
  pairs as (
    select h.user_id, h.bag_id from bag_investor_holdings h
    union
    select p.user_id, p.bag_id from bag_investor_positions p
  ),
  todo as (
    select pr.user_id, pr.bag_id from pairs pr
    where not exists (
      select 1 from ledger_events e where e.user_id = pr.user_id and e.bag_id = pr.bag_id and e.kind = 'OPENING_BALANCE'
    )
  ),
  ev_h as (
    select e.user_id, e.bag_id, leg->>'chain' as chain, leg->>'address' as address, sum((leg->>'deltaRaw')::numeric) as v
    from ledger_events e, jsonb_array_elements(e.legs) leg
    where e.kind = any (ledger_exposure_kinds())
    group by 1, 2, 3, 4
  ),
  ev_p as (
    select e.user_id, e.bag_id,
           sum(coalesce((e.quote->>'sharesDeltaRaw')::numeric, 0)) as shares,
           sum(coalesce((e.quote->>'costBasisDeltaQuote')::numeric, 0)) as cost
    from ledger_events e
    where e.kind = any (ledger_exposure_kinds())
    group by 1, 2
  ),
  opening as (
    select t.user_id, t.bag_id,
      coalesce((
        select jsonb_agg(jsonb_build_object('chain', h.chain, 'address', h.address, 'decimals', h.decimals,
                 'deltaRaw', (h.quantity_raw::numeric - coalesce(eh.v, 0))::text) order by h.chain, h.address)
        from bag_investor_holdings h
        left join ev_h eh on eh.user_id = h.user_id and eh.bag_id = h.bag_id and eh.chain = h.chain and eh.address = h.address
        where h.user_id = t.user_id and h.bag_id = t.bag_id and h.quantity_raw::numeric - coalesce(eh.v, 0) <> 0
      ), '[]'::jsonb) as legs,
      coalesce(p.shares_raw::numeric, 0) - coalesce(ep.shares, 0) as shares,
      coalesce(p.cost_basis_quote::numeric, 0) - coalesce(ep.cost, 0) as cost,
      coalesce(p.share_decimals, 18) as share_decimals
    from todo t
    left join bag_investor_positions p on p.user_id = t.user_id and p.bag_id = t.bag_id
    left join ev_p ep on ep.user_id = t.user_id and ep.bag_id = t.bag_id
  )
  insert into ledger_events (user_id, bag_id, kind, legs, quote, source, idempotency_key)
  select o.user_id, o.bag_id, 'OPENING_BALANCE', o.legs,
         jsonb_build_object('sharesDeltaRaw', o.shares::text, 'shareDecimals', o.share_decimals, 'costBasisDeltaQuote', o.cost::text),
         jsonb_build_object('migration', '0048_ledger_events'),
         'OPENING_BALANCE:' || o.user_id::text || ':' || o.bag_id::text
  from opening o
  where jsonb_array_length(o.legs) > 0 or o.shares <> 0 or o.cost <> 0
  on conflict (idempotency_key) do nothing;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

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
  v_intent_user uuid;
  v_intent_bag uuid;
  v_intent_status text;
  v_result jsonb;
  v_royalty_amount numeric;
  v_royalty_activity_id uuid;
  v_root_creator_wallet text;
begin
  -- 0036: the intent must exist and belong to exactly this (user, bag) — an
  -- unknown id used to be accounted with NO idempotency row, so every retry
  -- minted/burned again.
  select accounting_applied_at, user_id, bag_id, status
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
      'holdings', coalesce((select jsonb_agg(to_jsonb(bh.*)) from bag_holdings bh where bh.bag_id = p_bag_id), '[]'::jsonb),
      'shareState', (select to_jsonb(s.*) from bag_share_state s where s.bag_id = p_bag_id),
      'investorPosition', (select to_jsonb(p.*) from bag_investor_positions p where p.bag_id = p_bag_id and p.user_id = p_user_id),
      'royaltyActivityId', null,
      'royaltyAmount', null
    ) into v_result;
    return v_result;
  end if;

  -- 0036: a failed / expired / cancelled / partially-executed intent never
  -- produces full accounting (no share mint, no share burn), whatever the caller says.
  if v_intent_status in ('FAILED', 'EXPIRED', 'CANCELLED', 'PARTIAL_SUCCESS', 'RECONCILIATION_REQUIRED') then
    raise exception 'INTENT_NOT_EXECUTABLE: purchase intent % is %', p_intent_id, v_intent_status using errcode = 'check_violation';
  end if;
  if p_shares_delta_raw::numeric <= 0 or p_cost_basis_delta::numeric < 0
     or exists (select 1 from jsonb_array_elements(p_holdings) h where (h->>'delta_raw')::numeric < 0) then
    raise exception 'INVALID_ACCOUNTING_DELTA: shares %, cost basis %, holdings must be positive/non-negative', p_shares_delta_raw, p_cost_basis_delta
      using errcode = 'check_violation';
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

  -- Ledger (0048): the same facts, as one immutable event, in the same transaction.
  perform ledger_append(
    p_user_id, p_bag_id, 'PURCHASE_FILL',
    (select coalesce(jsonb_agg(jsonb_build_object('chain', bought->>'chain', 'address', bought->>'address', 'decimals', (bought->>'decimals')::integer, 'deltaRaw', bought->>'delta_raw')), '[]'::jsonb)
       from jsonb_array_elements(p_holdings) bought),
    jsonb_build_object('sharesDeltaRaw', p_shares_delta_raw, 'shareDecimals', p_share_decimals, 'costBasisDeltaQuote', p_cost_basis_delta),
    jsonb_build_object('intentKind', 'PURCHASE', 'intentId', p_intent_id),
    'PURCHASE_FILL:' || p_intent_id::text,
    (select recipe_version from purchase_intents where id = p_intent_id)
  );
  if v_royalty_activity_id is not null then
    perform ledger_append(
      p_root_creator_id, p_bag_id, 'ROYALTY_ACCRUED', '[]'::jsonb,
      jsonb_build_object('amountQuote', v_royalty_amount::text, 'baseQuote', p_cost_basis_delta, 'bps', p_fork_royalty_bps, 'payerUserId', p_user_id),
      jsonb_build_object('intentKind', 'PURCHASE', 'intentId', p_intent_id, 'activityId', v_royalty_activity_id),
      'ROYALTY_ACCRUED:' || p_intent_id::text,
      null
    );
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

  -- Ledger (0048). Shares and cost basis only move when shares are minted (same rule as above).
  perform ledger_append(
    p_user_id, p_bag_id, 'PURCHASE_FILL',
    (select coalesce(jsonb_agg(jsonb_build_object('chain', bought->>'chain', 'address', bought->>'address', 'decimals', (bought->>'decimals')::integer, 'deltaRaw', bought->>'delta_raw')), '[]'::jsonb)
       from jsonb_array_elements(p_holdings) bought),
    jsonb_build_object(
      'sharesDeltaRaw', case when p_shares_delta_raw::numeric > 0 then p_shares_delta_raw else '0' end,
      'shareDecimals', p_share_decimals,
      'costBasisDeltaQuote', case when p_shares_delta_raw::numeric > 0 then p_cost_basis_delta else '0' end,
      'partial', true),
    jsonb_build_object('intentKind', 'PURCHASE', 'intentId', p_intent_id, 'partial', true),
    'PURCHASE_PARTIAL_FILL:' || p_intent_id::text,
    (select recipe_version from purchase_intents where id = p_intent_id)
  );

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
  select accounting_applied_at, user_id, bag_id, status
    into v_already_applied, v_intent_user, v_intent_bag, v_intent_status
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
  if p_shares_burn_raw::numeric <= 0 or p_redeem_value_quote::numeric < 0 then
    raise exception 'INVALID_ACCOUNTING_DELTA: burn %, value % must be positive/non-negative', p_shares_burn_raw, p_redeem_value_quote
      using errcode = 'check_violation';
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

  -- Ledger (0048).
  perform ledger_append(
    p_user_id, p_bag_id, 'REDEEM_FILL',
    (select coalesce(jsonb_agg(jsonb_build_object('chain', sold->>'chain', 'address', sold->>'address',
         'decimals', (select ih.decimals from bag_investor_holdings ih where ih.user_id = p_user_id and ih.bag_id = p_bag_id and ih.chain = sold->>'chain' and ih.address = sold->>'address'),
         'deltaRaw', (-((sold->>'quantity_raw')::numeric))::text)), '[]'::jsonb)
       from jsonb_array_elements(p_holdings_sold) sold),
    jsonb_build_object('sharesDeltaRaw', (-(p_shares_burn_raw::numeric))::text, 'shareDecimals', p_share_decimals,
      'costBasisDeltaQuote', (v_new_cost_basis - v_position.cost_basis_quote::numeric)::text,
      'redeemValueQuote', p_redeem_value_quote, 'profitQuote', v_profit::text),
    jsonb_build_object('intentKind', 'REDEEM', 'intentId', p_intent_id),
    'REDEEM_FILL:' || p_intent_id::text,
    null
  );
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

create or replace function apply_partial_redeem_execution(
  p_intent_id uuid,
  p_bag_id uuid,
  p_holdings_sold jsonb,
  p_user_id uuid
) returns jsonb
language plpgsql
as $$
declare
  v_already_applied timestamptz;
  v_result jsonb;
  h jsonb;
  v_chain text;
  v_address text;
  v_qty numeric;
  v_row_count integer;
begin
  select reconciliation_applied_at into v_already_applied
  from redeem_intents
  where id = p_intent_id
  for update;

  if v_already_applied is not null then
    select jsonb_build_object(
      'alreadyApplied', true,
      'holdings', coalesce((select jsonb_agg(to_jsonb(bh.*)) from bag_holdings bh where bh.bag_id = p_bag_id), '[]'::jsonb)
    ) into v_result;
    return v_result;
  end if;

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
      raise exception 'HOLDINGS_UNDERFLOW (partial): bag % chain % address % cannot sell %',
        p_bag_id, v_chain, v_address, v_qty;
    end if;

    update bag_investor_holdings
    set quantity_raw = (quantity_raw::numeric - v_qty)::text, updated_at = now()
    where user_id = p_user_id and bag_id = p_bag_id and chain = v_chain and address = v_address
      and quantity_raw::numeric >= v_qty;
    get diagnostics v_row_count = row_count;
    if v_row_count = 0 then
      raise exception 'INVESTOR_HOLDINGS_UNDERFLOW (partial): user % bag % chain % address % cannot sell %',
        p_user_id, p_bag_id, v_chain, v_address, v_qty;
    end if;
  end loop;

  -- Ledger (0048). A mixed outcome removes only what verifiably sold; shares and cost basis do not move.
  perform ledger_append(
    p_user_id, p_bag_id, 'REDEEM_FILL',
    (select coalesce(jsonb_agg(jsonb_build_object('chain', sold->>'chain', 'address', sold->>'address',
         'decimals', (select ih.decimals from bag_investor_holdings ih where ih.user_id = p_user_id and ih.bag_id = p_bag_id and ih.chain = sold->>'chain' and ih.address = sold->>'address'),
         'deltaRaw', (-((sold->>'quantity_raw')::numeric))::text)), '[]'::jsonb)
       from jsonb_array_elements(p_holdings_sold) sold),
    jsonb_build_object('sharesDeltaRaw', '0', 'costBasisDeltaQuote', '0', 'partial', true),
    jsonb_build_object('intentKind', 'REDEEM', 'intentId', p_intent_id, 'partial', true),
    'REDEEM_PARTIAL_FILL:' || p_intent_id::text,
    null
  );

  update redeem_intents
  set reconciliation_applied_at = now()
  where id = p_intent_id;

  insert into activities (user_id, action)
  values (p_user_id, 'REDEEM_PARTIAL_RECONCILED:' || p_intent_id::text || ':' || p_bag_id::text);

  select jsonb_build_object(
    'alreadyApplied', false,
    'holdings', coalesce((select jsonb_agg(to_jsonb(bh.*)) from bag_holdings bh where bh.bag_id = p_bag_id), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

create or replace function apply_redeem_execution_router_settled(
  p_intent_id uuid,
  p_bag_id uuid,
  p_holdings_sold jsonb,
  p_shares_burn_raw text,
  p_share_decimals integer,
  p_user_id uuid,
  p_redeem_value_quote text,
  p_creator_id uuid,
  p_creator_wallet text,
  p_fee_amount_quote text,
  p_fee_amount_token_raw text,
  p_onchain_tx_hash text,
  p_redemption_id_hex text
) returns jsonb
language plpgsql
as $$
declare
  v_already_applied timestamptz;
  v_intent_user uuid;
  v_intent_bag uuid;
  v_intent_status text;
  v_position bag_investor_positions%rowtype;
  v_new_shares numeric;
  v_new_cost_basis numeric;
  v_consumed_cost_basis numeric;
  v_profit numeric;
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
  select accounting_applied_at, user_id, bag_id, status
    into v_already_applied, v_intent_user, v_intent_bag, v_intent_status
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
      'investorPosition', (select to_jsonb(p.*) from bag_investor_positions p where p.bag_id = p_bag_id and p.user_id = p_user_id)
    ) into v_result;
    return v_result;
  end if;

  -- 0036: a failed / expired / cancelled / partially-executed intent never
  -- produces full accounting (no share mint, no share burn), whatever the caller says.
  if v_intent_status in ('FAILED', 'EXPIRED', 'CANCELLED', 'PARTIAL_SUCCESS', 'RECONCILIATION_REQUIRED') then
    raise exception 'INTENT_NOT_EXECUTABLE: redeem intent % is %', p_intent_id, v_intent_status using errcode = 'check_violation';
  end if;
  if p_shares_burn_raw::numeric <= 0 or p_redeem_value_quote::numeric < 0 or p_fee_amount_quote::numeric < 0 then
    raise exception 'INVALID_ACCOUNTING_DELTA: burn %, value %, fee % must be positive/non-negative', p_shares_burn_raw, p_redeem_value_quote, p_fee_amount_quote
      using errcode = 'check_violation';
  end if;

  -- 0036: same share / holdings underflow guards as apply_redeem_execution —
  -- this path previously let shares and holdings go negative.
  select * into v_position from bag_investor_positions where user_id = p_user_id and bag_id = p_bag_id for update;
  if not found or v_position.shares_raw::numeric < p_shares_burn_raw::numeric then
    raise exception 'INSUFFICIENT_SHARES: user % bag % has % raw shares, tried to burn %',
      p_user_id, p_bag_id, coalesce(v_position.shares_raw, '0'), p_shares_burn_raw;
  end if;

  -- IDENTICAL holdings/shares/cost-basis logic to apply_redeem_execution()
  -- (0018) — this function only diverges in how the FEE is recorded, never
  -- in the position accounting itself. Kept duplicated rather than
  -- factored into a shared helper: PL/pgSQL has no cheap way to share a
  -- code block across two SECURITY-relevant functions without an extra
  -- indirection layer that would make both harder to audit independently.
  for h in select * from jsonb_array_elements(p_holdings_sold)
  loop
    v_chain := h->>'chain';
    v_address := h->>'address';
    v_qty := (h->>'quantity_raw')::numeric;

    update bag_holdings
    set quantity_raw = (quantity_raw::numeric - v_qty)::text, updated_at = now()
    where bag_id = p_bag_id and chain = v_chain and address = v_address
      and quantity_raw::numeric >= v_qty;
    get diagnostics v_row_count = row_count;
    if v_row_count = 0 then
      raise exception 'HOLDINGS_UNDERFLOW: bag % chain % address % cannot sell % (stale allocation)', p_bag_id, v_chain, v_address, v_qty;
    end if;

    update bag_investor_holdings
    set quantity_raw = (quantity_raw::numeric - v_qty)::text, updated_at = now()
    where user_id = p_user_id and bag_id = p_bag_id and chain = v_chain and address = v_address
      and quantity_raw::numeric >= v_qty;
    get diagnostics v_row_count = row_count;
    if v_row_count = 0 then
      raise exception 'INVESTOR_HOLDINGS_UNDERFLOW: user % bag % chain % address % cannot sell % (stale allocation)', p_user_id, p_bag_id, v_chain, v_address, v_qty;
    end if;
  end loop;

  select * into v_position from bag_investor_positions where user_id = p_user_id and bag_id = p_bag_id for update;

  if v_position.shares_raw::numeric = p_shares_burn_raw::numeric then
    -- 0036: a FULL redemption consumes ALL remaining basis — rounding the
    -- consumed amount to 2 decimals used to leave residual basis on 0 shares.
    v_consumed_cost_basis := v_position.cost_basis_quote::numeric;
  elsif v_position.shares_raw::numeric > 0 then
    v_consumed_cost_basis := round(
      v_position.cost_basis_quote::numeric * (p_shares_burn_raw::numeric / v_position.shares_raw::numeric),
      2
    );
  else
    v_consumed_cost_basis := 0;
  end if;

  v_profit := p_redeem_value_quote::numeric - v_consumed_cost_basis;
  v_new_shares := v_position.shares_raw::numeric - p_shares_burn_raw::numeric;
  v_new_cost_basis := v_position.cost_basis_quote::numeric - v_consumed_cost_basis;

  update bag_investor_positions
  set shares_raw = v_new_shares::text,
      cost_basis_quote = v_new_cost_basis::text,
      updated_at = now()
  where user_id = p_user_id and bag_id = p_bag_id;

  update bag_share_state
  set total_shares_raw = (total_shares_raw::numeric - p_shares_burn_raw::numeric)::text,
      updated_at = now()
  where bag_id = p_bag_id;

  -- Audit-only activity row — same PERFORMANCE_FEE_EARNED convention as
  -- the legacy path, so lib/server/creator-rewards-repo.ts's existing
  -- parser keeps working unchanged for a creator's reward history view.
  if p_fee_amount_quote::numeric > 0 then
    insert into activities (user_id, action)
    values (p_creator_id, 'PERFORMANCE_FEE_EARNED:' || p_fee_amount_quote || ':' || p_bag_id::text);

    -- THE key difference from apply_redeem_execution(): inserted directly
    -- at CONFIRMED, with the real on-chain proof, because the fee is
    -- ALREADY settled — never EARNED (which would make the async
    -- settlement worker try to pay it a second time). `source_redeem_intent_id`
    -- carries the SAME unique-index protection 0014 already created, so a
    -- retried call to this function (e.g. a webhook redelivery) can never
    -- insert a second row for the same intent either.
    insert into creator_reward_settlements (
      creator_id, creator_wallet, bag_id, reward_type,
      source_redeem_intent_id, gross_amount_quote, reward_amount_token_raw,
      reward_token_address, reward_token_decimals, reward_chain_id,
      status, settlement_ref_id, onchain_tx_hash, settled_at
    ) values (
      p_creator_id, p_creator_wallet, p_bag_id, 'PERFORMANCE_FEE',
      p_intent_id, p_fee_amount_quote, p_fee_amount_token_raw,
      '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', 6, 4663,
      'CONFIRMED', p_redemption_id_hex, p_onchain_tx_hash, now()
    )
    on conflict (source_redeem_intent_id) where source_redeem_intent_id is not null do nothing;
  end if;

  -- Ledger (0048).
  perform ledger_append(
    p_user_id, p_bag_id, 'REDEEM_FILL',
    (select coalesce(jsonb_agg(jsonb_build_object('chain', sold->>'chain', 'address', sold->>'address',
         'decimals', (select ih.decimals from bag_investor_holdings ih where ih.user_id = p_user_id and ih.bag_id = p_bag_id and ih.chain = sold->>'chain' and ih.address = sold->>'address'),
         'deltaRaw', (-((sold->>'quantity_raw')::numeric))::text)), '[]'::jsonb)
       from jsonb_array_elements(p_holdings_sold) sold),
    jsonb_build_object('sharesDeltaRaw', (-(p_shares_burn_raw::numeric))::text, 'shareDecimals', p_share_decimals,
      'costBasisDeltaQuote', (-v_consumed_cost_basis)::text,
      'redeemValueQuote', p_redeem_value_quote, 'profitQuote', v_profit::text, 'router', true),
    jsonb_build_object('intentKind', 'REDEEM', 'intentId', p_intent_id, 'chain', 'robinhood', 'txHash', p_onchain_tx_hash),
    'REDEEM_FILL:' || p_intent_id::text,
    null
  );
  if p_fee_amount_quote::numeric > 0 then
    perform ledger_append(
      p_user_id, p_bag_id, 'FEE_CHARGED', '[]'::jsonb,
      jsonb_build_object('amountQuote', p_fee_amount_quote, 'amountTokenRaw', p_fee_amount_token_raw, 'creatorId', p_creator_id, 'settledOnchain', true),
      jsonb_build_object('intentKind', 'REDEEM', 'intentId', p_intent_id, 'chain', 'robinhood', 'txHash', p_onchain_tx_hash, 'redemptionId', p_redemption_id_hex),
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
    'consumedCostBasis', v_consumed_cost_basis,
    'profit', v_profit,
    'investorPosition', (select to_jsonb(p.*) from bag_investor_positions p where p.bag_id = p_bag_id and p.user_id = p_user_id)
  ) into v_result;

  return v_result;
end;
$$;

do $$
declare
  v_sig text;
begin
  foreach v_sig in array array[
    'guard_ledger_events_immutable()',
    'ledger_append(uuid, uuid, text, jsonb, jsonb, jsonb, text, integer)',
    'ledger_exposure_kinds()',
    'ledger_projection_mismatches()',
    'ledger_backfill_opening_balances()',
    'apply_purchase_execution(uuid, uuid, jsonb, text, integer, uuid, text, integer, uuid)',
    'apply_partial_purchase_execution(uuid, uuid, jsonb, uuid, text, integer, text)',
    'apply_redeem_execution(uuid, uuid, jsonb, text, integer, uuid, text, integer, uuid)',
    'apply_partial_redeem_execution(uuid, uuid, jsonb, uuid)',
    'apply_redeem_execution_router_settled(uuid, uuid, jsonb, text, integer, uuid, text, uuid, text, text, text, text, text)'
  ] loop
    execute format('revoke execute on function %s from public', v_sig);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke execute on function %s from anon', v_sig); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke execute on function %s from authenticated', v_sig); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', v_sig); end if;
  end loop;
end $$;

-- State that predates the ledger.
select ledger_backfill_opening_balances();
