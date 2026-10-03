-- Phase 18.9 — conflict safety + full stale recovery for
-- commit_investment_transaction() (0008_add_investment_commit_transaction.sql).
--
-- Two real gaps Phase 18.8's real-Postgres verification of 0008 surfaced:
--
-- 1. STALE DETECTION WAS CASH-ONLY. `p_expected_cash_balance` only caught
--    staleness when cash_balance itself had moved. Two commits that left
--    cash_balance unchanged but changed `positions` (e.g. a BUY of $50 and
--    an unrelated SELL that returns $50, net cash delta zero) were wrongly
--    accepted as still-fresh, silently overwriting `positions` to a plan
--    computed against a portfolio state that no longer existed — this is
--    the "stale positions silently deleted" bug from Phase 18.8's report.
--    Fixed by `portfolio_version`: a plain integer, incremented by exactly
--    1 on every successful commit (idempotent replays don't increment it —
--    they're not a new commit). A plan's `expectedPortfolioVersion` must
--    equal the CURRENT row's version under lock, full stop — no partial
--    "well the cash matched" leniency.
--
-- 2. `on conflict (user_id, client_trade_id) do nothing` was a silent
--    no-op: if a leg's client_trade_id already existed in `trades` — same
--    id reused across two different investment_ids — that ONE insert
--    quietly skipped while portfolio/positions/points for the REST of the
--    commit still applied, using a `finalPortfolio`/`p_trades` computed
--    assuming every leg was being freshly written. Fixed by a pre-write
--    check (see the loop below): every incoming leg's client_trade_id is
--    looked up against `trades` BEFORE any mutation.
--      - No existing row -> proceeds normally.
--      - Existing row, IDENTICAL content (symbol/side/quantity/price) -> a
--        different investment_id replaying the same logical trade; this
--        function returns the ORIGINAL commit's full result (looked up via
--        investment_commits.trade_ids, which contains that trade's id) and
--        performs NO write of any kind — same "zero new writes" guarantee
--        an investment_id replay already gets, just reached from the
--        trade-id side instead.
--      - Existing row, DIFFERENT content -> raises CLIENT_TRADE_ID_CONFLICT
--        and the transaction rolls back completely (nothing above this
--        check has written anything yet).
--
-- Both checks happen strictly AFTER the `for update` row lock is taken (see
-- 0008's own CONCURRENCY note — that lock is still the one serialization
-- point everything else here relies on being race-free) and strictly
-- BEFORE the first write, so every rejection path in this function is a
-- true no-op: raise, and Postgres unwinds the whole call.

alter table portfolios
  add column if not exists portfolio_version integer not null default 0;

alter table investment_commits
  add column if not exists portfolio_version integer not null default 0;

-- `create or replace function` cannot change an existing parameter's TYPE
-- in place (p_expected_cash_balance numeric -> p_expected_portfolio_version
-- integer, at the same position) — Postgres would treat that as a
-- different signature and create a second, ambiguous overload alongside
-- 0008's original instead of truly replacing it. Drop the exact old
-- signature first.
drop function if exists commit_investment_transaction(
  uuid, text, text, numeric, numeric, numeric, jsonb, jsonb, text, integer, integer
);

create or replace function commit_investment_transaction(
  p_user_id uuid,
  p_investment_id text,
  p_bag_id text,
  p_expected_portfolio_version integer,
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
  v_actual_portfolio_version integer;
  v_existing investment_commits%rowtype;
  v_trade_ids jsonb := '[]'::jsonb;
  v_new_bag_points integer;
  v_points_delta integer := 0;
  v_points_available integer;
  v_new_version integer;
  -- Phase 18.9 additions:
  v_leg jsonb;
  v_leg_client_trade_id text;
  v_existing_trade trades%rowtype;
  v_prior_commit investment_commits%rowtype;
begin
  -- Row lock FIRST — see 0008's CONCURRENCY note. This is the single
  -- serialization point every other guarantee in this function relies on.
  select cash_balance, portfolio_version into v_actual_cash_balance, v_actual_portfolio_version
  from portfolios
  where user_id = p_user_id
  for update;

  if v_actual_portfolio_version is null then
    raise exception 'PORTFOLIO_NOT_FOUND';
  end if;

  -- Idempotency (whole-commit, by investment_id): safe to check now that we
  -- hold the per-user lock — no other commit for this user can be in flight.
  select * into v_existing
  from investment_commits
  where user_id = p_user_id and investment_id = p_investment_id;

  if found then
    return jsonb_build_object(
      'alreadyApplied', true,
      'tradeIds', v_existing.trade_ids,
      'finalCashBalance', v_existing.final_cash_balance,
      'finalRealizedPnl', v_existing.final_realized_pnl,
      'pointsAwarded', v_existing.points_awarded,
      'portfolioVersion', v_existing.portfolio_version
    );
  end if;

  -- Phase 18.9 — staleness is now judged on portfolio_version, not
  -- cash_balance: catches "positions changed but cash happened to net out"
  -- too. See this migration's module doc above.
  if v_actual_portfolio_version != p_expected_portfolio_version then
    raise exception 'PORTFOLIO_STALE';
  end if;

  -- Phase 18.9 — client_trade_id conflict pre-check, BEFORE any write.
  -- Every leg is checked; a genuine conflict aborts the whole function via
  -- `raise exception` before anything below this loop has run.
  for v_leg in select * from jsonb_array_elements(p_trades)
  loop
    v_leg_client_trade_id := v_leg->>'client_trade_id';

    select * into v_existing_trade
    from trades
    where user_id = p_user_id and client_trade_id = v_leg_client_trade_id;

    if found then
      if v_existing_trade.symbol = (v_leg->>'symbol')
         and v_existing_trade.side = (v_leg->>'side')
         and v_existing_trade.quantity = (v_leg->>'quantity')::numeric
         and v_existing_trade.price = (v_leg->>'price')::numeric
      then
        -- Same logical trade, reached via a DIFFERENT investment_id (the
        -- investment_id lookup above already missed, or we wouldn't be
        -- here). Whichever commit originally wrote this trade already
        -- applied its full effect — replay THAT commit's result verbatim
        -- and write nothing new, rather than guessing how to merge.
        select * into v_prior_commit
        from investment_commits
        where user_id = p_user_id
          and trade_ids @> to_jsonb(v_existing_trade.id::text);

        if found then
          return jsonb_build_object(
            'alreadyApplied', true,
            'tradeIds', v_prior_commit.trade_ids,
            'finalCashBalance', v_prior_commit.final_cash_balance,
            'finalRealizedPnl', v_prior_commit.final_realized_pnl,
            'pointsAwarded', v_prior_commit.points_awarded,
            'portfolioVersion', v_prior_commit.portfolio_version
          );
        else
          -- Defensive only: every write path to `trades` goes through this
          -- function, so an orphaned trade with no owning investment_commits
          -- row should not be reachable. Treat conservatively as a
          -- conflict rather than silently guessing.
          raise exception 'CLIENT_TRADE_ID_CONFLICT: %', v_leg_client_trade_id;
        end if;
      else
        -- Same client_trade_id, genuinely different trade content.
        raise exception 'CLIENT_TRADE_ID_CONFLICT: %', v_leg_client_trade_id;
      end if;
    end if;
  end loop;

  v_new_version := v_actual_portfolio_version + 1;

  -- 1. portfolio mutation
  update portfolios
  set cash_balance = p_final_cash_balance,
      realized_pnl = p_final_realized_pnl,
      portfolio_version = v_new_version,
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

  -- 3. all trade inserts. `on conflict do nothing` remains here only as a
  -- defensive belt-and-suspenders — the pre-check loop above has already
  -- ruled out every possible collision under the row lock we're still
  -- holding, so this should never actually fire in practice.
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
  -- every future replay of this same investment_id (or, via the trade-id
  -- lookup above, of any of its individual trades under a different id).
  insert into investment_commits (
    user_id, investment_id, bag_id, trade_ids, final_cash_balance, final_realized_pnl, points_awarded, portfolio_version
  )
  values (
    p_user_id, p_investment_id, p_bag_id, v_trade_ids, p_final_cash_balance, p_final_realized_pnl, greatest(v_points_delta, 0), v_new_version
  );

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
    'pointsAwarded', greatest(v_points_delta, 0),
    'portfolioVersion', v_new_version
  );
end;
$$;

revoke execute on function commit_investment_transaction from public;
grant execute on function commit_investment_transaction to service_role;
