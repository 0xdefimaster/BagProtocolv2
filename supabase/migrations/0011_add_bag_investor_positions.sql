-- 0011_add_bag_investor_positions.sql
--
-- Layer 0 — per-investor share ledger. `bag_share_state` (0004) only ever
-- tracked a Bag's TOTAL outstanding shares; nothing anywhere recorded which
-- user holds how much of that total. That's the hard blocker for both
-- planned reward mechanisms (fork royalty needs "whose deposit is this",
-- performance fee needs "this depositor's own cost basis vs their own
-- current value") and for any correct per-user P&L on the profile page —
-- `purchase_intents` is an append-only transaction log, not a live
-- balance, and deriving a live balance from it per read would be both slow
-- and wrong the moment a redemption/burn path exists.
--
-- ONE ROW PER (user_id, bag_id) — same "current state, not history" shape
-- `bag_share_state` already uses for the bag-level total; this is that
-- table's per-depositor breakdown, not a replacement for it. Both are
-- updated together, additively, inside the same `apply_purchase_execution()`
-- transaction, so they can never drift apart (a Bag's total shares must
-- always equal the sum of its investor positions' shares).
--
-- `cost_basis_quote` is additive, in the SAME quote-currency units as
-- `purchase_intents.deposit_amount` (added below) — i.e. `DepositQuote
-- .depositAmount`, the human decimal deposit amount the Purchase Preview
-- already showed the user, locked at quote time. This is deliberately NOT
-- derived from `share_price_at_quote * shares_raw`: that field is null for
-- every bootstrap (first-depositor, zero-share-supply) purchase, which
-- would make a derived cost basis undefined for exactly the deposits that
-- most need one. `deposit_amount` has no such gap — a deposit's own
-- quoted amount is well-defined regardless of whether shares existed yet.
create table if not exists bag_investor_positions (
  user_id uuid not null references users(id) on delete cascade,
  bag_id uuid not null references bags(id) on delete cascade,
  shares_raw text not null default '0',
  share_decimals integer not null default 18 check (share_decimals >= 0 and share_decimals <= 18),
  cost_basis_quote text not null default '0',
  updated_at timestamptz not null default now(),
  primary key (user_id, bag_id)
);

create index if not exists idx_bag_investor_positions_bag on bag_investor_positions(bag_id);

-- No RLS policies — same boundary as `purchase_intents`/`trades`: every
-- read and write goes through a route handler that calls requireSession()
-- first and filters by `auth.session.userId`, using the service-role
-- client. This table holds per-user financial data (cost basis), so it is
-- deliberately NOT given `bag_share_state`'s public-read policy — a user's
-- own position is theirs to read via an authenticated route, never a
-- public/anon query.

-- `purchase_intents.deposit_amount` — see `bag_investor_positions.
-- cost_basis_quote` doc above for why this is the value threaded through
-- as the per-investor cost-basis delta. Backfilled '0' for any pre-existing
-- row (none of which have `accounting_applied_at` unset, so none of them
-- will ever be re-applied through the updated function below anyway).
alter table purchase_intents add column if not exists deposit_amount text not null default '0';

-- ---------------------------------------------------------------------------
-- apply_purchase_execution — replaced to additionally upsert the per-user
-- `bag_investor_positions` row alongside the existing bag-level
-- `bag_share_state` write, inside the SAME transaction (this is still one
-- plpgsql function body — the same atomicity guarantee the 0004 version's
-- own doc comment describes now also covers "a Bag's total shares and the
-- sum of its investors' shares can never disagree").
--
-- New `p_cost_basis_delta` param mirrors `p_shares_delta_raw`: an additive
-- delta, in quote-currency units, added to the depositor's running
-- `cost_basis_quote` — never an absolute value, for the same
-- double-application reason `p_shares_delta_raw` already documents.
-- Defaults to '0' only so an old caller recompiled against this signature
-- before its call site is updated doesn't fail outright; every real caller
-- (lib/server/purchase-execution.ts) always passes a real value.
-- ---------------------------------------------------------------------------
create or replace function apply_purchase_execution(
  p_intent_id uuid,
  p_bag_id uuid,
  p_holdings jsonb,        -- [{chain, address, decimals, delta_raw}]
  p_shares_delta_raw text,
  p_share_decimals integer,
  p_user_id uuid,
  p_cost_basis_delta text default '0'
) returns jsonb
language plpgsql
as $$
declare
  v_already_applied timestamptz;
  v_result jsonb;
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
      'investorPosition', (select to_jsonb(p.*) from bag_investor_positions p where p.bag_id = p_bag_id and p.user_id = p_user_id)
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

  insert into bag_share_state (bag_id, total_shares_raw, share_decimals)
  values (p_bag_id, p_shares_delta_raw, p_share_decimals)
  on conflict (bag_id) do update
    set total_shares_raw = (bag_share_state.total_shares_raw::numeric + excluded.total_shares_raw::numeric)::text,
        updated_at = now();

  -- Per-investor share ledger — same additive upsert shape as
  -- `bag_share_state` immediately above, keyed by (user_id, bag_id)
  -- instead of just bag_id.
  insert into bag_investor_positions (user_id, bag_id, shares_raw, share_decimals, cost_basis_quote)
  values (p_user_id, p_bag_id, p_shares_delta_raw, p_share_decimals, p_cost_basis_delta)
  on conflict (user_id, bag_id) do update
    set shares_raw = (bag_investor_positions.shares_raw::numeric + excluded.shares_raw::numeric)::text,
        cost_basis_quote = (bag_investor_positions.cost_basis_quote::numeric + excluded.cost_basis_quote::numeric)::text,
        updated_at = now();

  update purchase_intents
  set accounting_applied_at = now()
  where id = p_intent_id;

  insert into activities (user_id, action)
  values (p_user_id, 'PURCHASE_EXECUTED:' || p_intent_id::text || ':' || p_bag_id::text);

  select jsonb_build_object(
    'alreadyApplied', false,
    'holdings', coalesce((select jsonb_agg(to_jsonb(bh.*)) from bag_holdings bh where bh.bag_id = p_bag_id), '[]'::jsonb),
    'shareState', (select to_jsonb(s.*) from bag_share_state s where s.bag_id = p_bag_id),
    'investorPosition', (select to_jsonb(p.*) from bag_investor_positions p where p.bag_id = p_bag_id and p.user_id = p_user_id)
  ) into v_result;

  return v_result;
end;
$$;

revoke execute on function apply_purchase_execution from public;
grant execute on function apply_purchase_execution to service_role;
