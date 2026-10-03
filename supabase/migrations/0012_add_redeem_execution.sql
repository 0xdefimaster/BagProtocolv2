-- 0012_add_redeem_execution.sql
--
-- Phase 21 — Real Redemption. Two things this migration adds, and why both
-- are needed before a redemption can be anything other than fake:
--
-- 1. `bag_investor_holdings` — per-user, per-asset quantities. This
--    protocol has NO pooled custody (lib/blockchain/lifi-purchase-quote.ts:
--    every swap's `toAddress` is the depositor's OWN wallet). `bag_holdings`
--    is only ever an aggregate SUM across every depositor's own, separately
--    -held tokens — there is no shared vault a redemption could sell out of.
--    The only assets a redemption can honestly sell are the ones a SPECIFIC
--    depositor's OWN past deposits actually put in THEIR OWN wallet. Without
--    this table, "redeem" would have to either (a) sell against the bag-wide
--    aggregate, which has nothing to do with what's in any one wallet, or
--    (b) not exist. Credited additively, in `apply_purchase_execution()`,
--    the SAME transaction that already credits `bag_holdings` — so a Bag's
--    aggregate total for an asset and the sum of its investors' own
--    holdings of that asset can never disagree, same invariant
--    `bag_investor_positions` (0011) already gives shares.
--
-- 2. `redeem_intents` + `apply_redeem_execution()` /
--    `apply_partial_purchase_execution()`'s redeem-side twin
--    `apply_partial_redeem_execution()` — the exit-side counterpart to
--    `purchase_intents` + `apply_purchase_execution()`. Same idempotency
--    pattern (row lock + `accounting_applied_at`/`reconciliation_applied_at`
--    checked inside the function), same mixed-outcome handling
--    (PARTIAL_SUCCESS never invents a partial burn amount — see
--    `apply_partial_redeem_execution`'s doc below), plus ONE guarantee a
--    mint never needed: a burn can overdraw. `apply_redeem_execution()`
--    re-validates sufficiency (shares AND every underlying asset quantity)
--    INSIDE a row lock on `bag_investor_positions`, never trusting a
--    snapshot computed moments earlier by the route handler.
create table if not exists bag_investor_holdings (
  user_id uuid not null references users(id) on delete cascade,
  bag_id uuid not null references bags(id) on delete cascade,
  chain text not null check (chain in ('ethereum', 'base', 'arbitrum', 'solana', 'robinhood')),
  address text not null,
  quantity_raw text not null default '0',
  decimals integer not null check (decimals >= 0 and decimals <= 18),
  updated_at timestamptz not null default now(),
  primary key (user_id, bag_id, chain, address)
);

create index if not exists idx_bag_investor_holdings_bag on bag_investor_holdings(bag_id);
create index if not exists idx_bag_investor_holdings_user_bag on bag_investor_holdings(user_id, bag_id);

-- No RLS — same boundary as bag_investor_positions (0011): every read/write
-- goes through a route handler that has already called requireSession()
-- and checked ownership, using the service-role client.

-- ---------------------------------------------------------------------------
-- redeem_intents — exit-side counterpart to `purchase_intents`. No
-- `input_asset`/`recipe_version`/`composition_hash`/`nav_*` columns: a
-- redemption's steps can span several distinct SOURCE assets (however many
-- this depositor's own `bag_investor_holdings` rows hold — see
-- lib/domain/basket-protocol/redeem/allocation.ts's module doc), so there
-- is no single input asset to store, and staleness is checked by
-- re-deriving the allocation from this depositor's CURRENT holdings/shares
-- (which is what can change between quote and execute for a redemption),
-- not by a recipe-composition hash (rebalancing the Bag's target weights
-- doesn't retroactively change what's already sitting in this depositor's
-- own wallet).
-- ---------------------------------------------------------------------------
create table if not exists redeem_intents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  wallet_address text not null,
  bag_id uuid not null references bags(id) on delete cascade,
  shares_raw text not null,
  share_decimals integer not null,
  output_asset_chain text not null,
  output_asset_address text not null,
  output_decimals integer not null,
  route_fingerprint text not null,
  share_price_at_quote text not null,
  redeem_value_quote text not null,
  steps jsonb not null default '[]'::jsonb,
  status text not null default 'DRAFT',
  failure_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null,
  executed_at timestamptz,
  accounting_applied_at timestamptz,
  reconciliation_applied_at timestamptz
);

create index if not exists idx_redeem_intents_user_bag_status on redeem_intents(user_id, bag_id, status);

-- No RLS — same boundary as purchase_intents: every read/write goes through
-- a route handler that has already called requireSession() and checked
-- `redeem_intents.user_id = session.userId`, using the service-role client.

-- ---------------------------------------------------------------------------
-- apply_purchase_execution — replaced a THIRD time (0004 -> 0011 -> here)
-- to additionally credit `bag_investor_holdings`, additively, per holding
-- leg, in the SAME transaction as `bag_holdings` — see this migration's
-- header doc for why this is the prerequisite a real redemption needs.
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

  -- Phase 21 — this depositor's OWN per-asset holdings, same additive
  -- upsert shape as `bag_holdings` immediately above, keyed additionally by
  -- user_id. This is what `calculateRedeemAllocation()` reads from later —
  -- never the bag-level aggregate (see redeem/allocation.ts's module doc).
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

-- ---------------------------------------------------------------------------
-- apply_redeem_execution — the burn-side counterpart to
-- apply_purchase_execution(). Every SWAP step of the redeem intent
-- verified COMPLETED, none FAILED (mixed outcomes go through
-- apply_partial_redeem_execution below instead — never this function).
--
-- Locks `bag_investor_positions` FIRST (not just `redeem_intents`) and
-- RE-VALIDATES `shares_raw >= p_shares_burn_raw` inside that lock — a mint
-- can never overdraw (it only ever adds), but a burn can, if this
-- depositor's position changed between quote and execute (e.g. two
-- redemptions for the same position racing, or a concurrent partial
-- reconciliation). Any other write to this exact (user_id, bag_id) row —
-- including another concurrent `apply_purchase_execution()`/
-- `apply_redeem_execution()` call, via its own UPDATE/UPSERT — blocks on
-- this lock until this transaction commits, so no interleaving can produce
-- a negative position.
--
-- `cost_basis_quote` is reduced PROPORTIONALLY to the fraction of shares
-- burned (`new = old * remaining_shares / shares_before`), not by
-- subtracting `p_redeem_value_quote` — the redeemed VALUE and the
-- redeemed COST BASIS are different numbers whenever the position has a
-- gain or loss, and conflating them here would silently zero out exactly
-- the information Phase 22 (performance fee) needs to compute a
-- gain/loss on this specific redemption.
-- ---------------------------------------------------------------------------
create or replace function apply_redeem_execution(
  p_intent_id uuid,
  p_bag_id uuid,
  p_holdings_sold jsonb,   -- [{chain, address, quantity_raw}] positive quantities being sold/removed
  p_shares_burn_raw text,
  p_share_decimals integer,
  p_user_id uuid
) returns jsonb
language plpgsql
as $$
declare
  v_already_applied timestamptz;
  v_position bag_investor_positions%rowtype;
  v_new_shares numeric;
  v_new_cost_basis numeric;
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
      'investorPosition', (select to_jsonb(p.*) from bag_investor_positions p where p.bag_id = p_bag_id and p.user_id = p_user_id)
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

  update redeem_intents
  set accounting_applied_at = now()
  where id = p_intent_id;

  insert into activities (user_id, action)
  values (p_user_id, 'REDEEM_EXECUTED:' || p_intent_id::text || ':' || p_bag_id::text);

  select jsonb_build_object(
    'alreadyApplied', false,
    'holdings', coalesce((select jsonb_agg(to_jsonb(bh.*)) from bag_holdings bh where bh.bag_id = p_bag_id), '[]'::jsonb),
    'shareState', (select to_jsonb(s.*) from bag_share_state s where s.bag_id = p_bag_id),
    'investorPosition', (select to_jsonb(p.*) from bag_investor_positions p where p.bag_id = p_bag_id and p.user_id = p_user_id)
  ) into v_result;

  return v_result;
end;
$$;

revoke execute on function apply_redeem_execution from public;
grant execute on function apply_redeem_execution to service_role;

-- ---------------------------------------------------------------------------
-- apply_partial_redeem_execution — mixed-outcome twin of
-- apply_partial_purchase_execution() (0008), for a redemption where at
-- least one SWAP leg verified COMPLETED and at least one verified FAILED.
--
-- Removes ONLY the holdings that were verifiably sold (both `bag_holdings`
-- and this depositor's own `bag_investor_holdings`) — deliberately does
-- NOT touch `bag_share_state`/`bag_investor_positions` at all. Burning
-- only a partial share amount here would be inventing a number: this
-- depositor asked to redeem N shares for a full basket of assets, only
-- SOME of which actually sold; deciding how many of those N shares that
-- partial, uneven sale is worth is a real pricing decision (spec 18.3's
-- "Do NOT invent a generic refund mechanism" applies just as much on this
-- side), left for the same follow-up/support process
-- RECONCILIATION_REQUIRED already exists for on the deposit side.
-- ---------------------------------------------------------------------------
create or replace function apply_partial_redeem_execution(
  p_intent_id uuid,
  p_bag_id uuid,
  p_holdings_sold jsonb,   -- [{chain, address, quantity_raw}] — ONLY the verifiably-completed legs
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

revoke execute on function apply_partial_redeem_execution from public;
grant execute on function apply_partial_redeem_execution to service_role;
