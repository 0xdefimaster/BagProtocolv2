-- Phase 18.7 — Real database transaction atomicity for investment commits.
--
-- Phase 18.6 closed the "silent partial basket" bug by validating every
-- composition leg up front (planInvestment(), pure/in-memory, unchanged by
-- this migration). What it explicitly did NOT close — called out in its own
-- doc comment in app/api/trades/route.ts — is the DB-level gap: the commit
-- loop called persistPortfolio() and insertTrade() as separate Supabase
-- REST calls per leg, so a network error / timeout / connection drop
-- between two of those calls could leave the portfolio row updated but a
-- trade row missing (or vice versa), or leg 1 written and leg 2 not.
--
-- This migration closes that gap the same way apply_purchase_execution() /
-- buy_box() already do for their own multi-row writes: ONE Postgres
-- function, ONE transaction (implicit — a plpgsql function body is
-- transactional; any exception aborts the whole call, nothing partial is
-- ever visible to another session). commit_investment_transaction() is the
-- ONLY path allowed to apply a priced/validated investment plan's effect on
-- portfolios/positions/trades (and, for symmetry with executeSingleTrade's
-- SELL path, user_points/point_transactions) — trading-repo.ts's
-- persistPortfolio()/insertTrade() remain in place for other callers
-- (app/api/portfolio, tests) but app/api/trades/route.ts's commit phase no
-- longer calls them directly for either invest() or a single BUY/SELL.
--
-- CONCURRENCY: `select ... from portfolios where user_id = p_user_id for
-- update` is taken FIRST, before anything else in the function. This
-- serializes every commit for a given user behind that one row lock — two
-- concurrent requests for the SAME user (double-click, retry-while-inflight)
-- physically cannot interleave their writes, which is also what makes the
-- idempotency check below race-free without a separate advisory lock: by
-- the time a second concurrent call reaches the `investment_commits` lookup,
-- the first call has either committed (and inserted its row) or rolled back
-- entirely.
--
-- IDEMPOTENCY: `p_investment_id` is a client-supplied (or route-generated)
-- key for the WHOLE basket — one key per invest()/trade request, not one
-- per leg (per-leg dedup already exists via trades.client_trade_id). A
-- retried call with the same (user_id, investment_id) — e.g. client retry
-- after a dropped response — returns the FIRST call's recorded result and
-- performs zero writes, never a second portfolio mutation, trades insert,
-- or points award.
--
-- STALE-PLAN DETECTION: `p_expected_cash_balance` is the cash_balance the
-- caller's plan (planInvestment(), in-memory) was computed against. Under
-- the row lock, this function compares it to the ACTUAL current
-- cash_balance. A mismatch means some other commit (a different
-- investment_id) touched this portfolio between planning and committing —
-- the plan's legs (quantities, allocatedUsd) were computed against a
-- balance that's no longer current, so this function raises
-- PORTFOLIO_STALE rather than silently applying a plan that may no longer
-- be affordable/correct. The caller re-plans against a fresh portfolio read
-- and retries with a new commit call (same investment_id is fine — this
-- function hasn't recorded anything for it yet).
create table if not exists investment_commits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  investment_id text not null,
  bag_id text,
  trade_ids jsonb not null default '[]'::jsonb,
  final_cash_balance numeric(18, 2) not null,
  final_realized_pnl numeric(18, 2) not null,
  points_awarded integer not null default 0,
  created_at timestamptz not null default now(),
  unique (user_id, investment_id)
);

create index if not exists idx_investment_commits_user on investment_commits(user_id, created_at desc);

-- No RLS policies — same boundary as `trades`/`purchase_intents`: every
-- read and write goes through a route handler that calls requireSession()
-- first, using the service-role client. There is no anon/authenticated-role
-- access path to this table.

create or replace function commit_investment_transaction(
  p_user_id uuid,
  p_investment_id text,
  p_bag_id text,
  p_expected_cash_balance numeric,
  p_final_cash_balance numeric,
  p_final_realized_pnl numeric,
  p_positions jsonb,          -- full final position set: [{symbol, quantity, avg_cost}]
  p_trades jsonb,             -- every leg to insert: [{id, symbol, side, quantity, price, total_value, realized_pnl, client_trade_id}]
  p_season_id text default null,      -- non-null only when points accounting applies (a SELL leg changed realized PnL)
  p_current_bag_points integer default 0,
  p_current_points_spent integer default 0
) returns jsonb
language plpgsql
as $$
declare
  v_actual_cash_balance numeric;
  v_existing investment_commits%rowtype;
  v_trade_ids jsonb := '[]'::jsonb;
  v_new_bag_points integer;
  v_points_delta integer := 0;
  v_points_available integer;
begin
  -- Row lock FIRST — see the CONCURRENCY note above. This is the single
  -- serialization point every other guarantee in this function relies on.
  select cash_balance into v_actual_cash_balance
  from portfolios
  where user_id = p_user_id
  for update;

  if v_actual_cash_balance is null then
    raise exception 'PORTFOLIO_NOT_FOUND';
  end if;

  -- Idempotency: safe to check now that we hold the per-user lock (see
  -- CONCURRENCY above) — no other commit for this user can be in flight.
  select * into v_existing
  from investment_commits
  where user_id = p_user_id and investment_id = p_investment_id;

  if found then
    return jsonb_build_object(
      'alreadyApplied', true,
      'tradeIds', v_existing.trade_ids,
      'finalCashBalance', v_existing.final_cash_balance,
      'finalRealizedPnl', v_existing.final_realized_pnl,
      'pointsAwarded', v_existing.points_awarded
    );
  end if;

  if abs(v_actual_cash_balance - p_expected_cash_balance) > 0.005 then
    raise exception 'PORTFOLIO_STALE';
  end if;

  -- 1. portfolio mutation
  update portfolios
  set cash_balance = p_final_cash_balance,
      realized_pnl = p_final_realized_pnl,
      updated_at = now()
  where user_id = p_user_id;

  -- 2. positions — full reconciliation against the plan's final set,
  -- same semantics as trading-repo.ts's persistPortfolio(): delete symbols
  -- no longer held, upsert the rest.
  delete from positions
  where user_id = p_user_id
    and symbol not in (
      select (elem->>'symbol')::text
      from jsonb_array_elements(p_positions) as elem
    );

  insert into positions (user_id, symbol, quantity, avg_cost)
  select
    p_user_id,
    (elem->>'symbol')::text,
    (elem->>'quantity')::numeric,
    (elem->>'avg_cost')::numeric
  from jsonb_array_elements(p_positions) as elem
  on conflict (user_id, symbol) do update
    set quantity = excluded.quantity,
        avg_cost = excluded.avg_cost;

  -- 3. all trade inserts
  insert into trades (id, user_id, symbol, side, quantity, price, total_value, realized_pnl, bag_id, client_trade_id)
  select
    (elem->>'id')::uuid,
    p_user_id,
    (elem->>'symbol')::text,
    (elem->>'side')::text,
    (elem->>'quantity')::numeric,
    (elem->>'price')::numeric,
    (elem->>'total_value')::numeric,
    (elem->>'realized_pnl')::numeric,
    p_bag_id,
    (elem->>'client_trade_id')::text
  from jsonb_array_elements(p_trades) as elem
  on conflict (user_id, client_trade_id) do nothing;

  select coalesce(jsonb_agg(elem->>'id'), '[]'::jsonb) into v_trade_ids
  from jsonb_array_elements(p_trades) as elem;

  -- 4. points / related accounting — only when this commit's caller says
  -- points accounting applies (a SELL leg changed realized PnL; every-BUY
  -- invest() baskets pass p_season_id = null and this whole block is a
  -- no-op, matching today's behaviour where invest() never awards points).
  -- Same derivation rule as points-repo.ts's syncPointsFromRealizedPnL:
  -- BAG Points are always recomputed from total realized PnL, never
  -- accumulated — $10 of net realized profit = 1 point.
  if p_season_id is not null then
    v_new_bag_points := greatest(floor(p_final_realized_pnl / 10), 0)::integer;
    v_points_delta := v_new_bag_points - p_current_bag_points;
    v_points_available := v_new_bag_points - p_current_points_spent;

    insert into user_points (user_id, season_id, total_realized_pnl, bag_points, points_spent, points_available)
    values (p_user_id, p_season_id, p_final_realized_pnl, v_new_bag_points, p_current_points_spent, v_points_available)
    on conflict (user_id, season_id) do update
      set total_realized_pnl = excluded.total_realized_pnl,
          bag_points = excluded.bag_points,
          points_available = excluded.points_available;

    if v_points_delta > 0 then
      insert into point_transactions (user_id, season_id, type, amount, reference_id)
      values (p_user_id, p_season_id, 'TRADE_PROFIT', v_points_delta, p_investment_id);
    end if;
  end if;

  -- 5. investment/audit record — also this commit's idempotency guard for
  -- every future replay of this same investment_id.
  insert into investment_commits (user_id, investment_id, bag_id, trade_ids, final_cash_balance, final_realized_pnl, points_awarded)
  values (p_user_id, p_investment_id, p_bag_id, v_trade_ids, p_final_cash_balance, p_final_realized_pnl, greatest(v_points_delta, 0));

  insert into activities (user_id, action)
  values (p_user_id, 'INVESTMENT_COMMITTED:' || p_investment_id);

  -- 6. commit — implicit: returning here ends the function successfully,
  -- and Postgres commits the transaction the function body ran in. Any
  -- exception raised above (including the unique-constraint conflicts and
  -- explicit `raise exception` calls) unwinds ALL of the above — no partial
  -- write is ever observable, by design of a single plpgsql function body.
  return jsonb_build_object(
    'alreadyApplied', false,
    'tradeIds', v_trade_ids,
    'finalCashBalance', p_final_cash_balance,
    'finalRealizedPnl', p_final_realized_pnl,
    'pointsAwarded', greatest(v_points_delta, 0)
  );
end;
$$;

revoke execute on function commit_investment_transaction from public;
grant execute on function commit_investment_transaction to service_role;
