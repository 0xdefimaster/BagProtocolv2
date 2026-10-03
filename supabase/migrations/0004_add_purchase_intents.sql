-- 0004_add_purchase_intents.sql
--
-- Phase 17 — Real Wallet + LI.FI Execution.
--
-- `purchase_intents` is the server-side canonical record between a quoted
-- `ExecutionPlan` (Phase 10/14, quote-only) and a real, user-signed
-- on-chain execution (types/purchase-intent.ts's `PurchaseIntent`). Same
-- conventions as every other table in this project (see schema.sql):
-- server-only writes through the service-role client, ownership enforced
-- in the API route via the session cookie (lib/auth/require-session.ts),
-- never via RLS (the service-role key bypasses it entirely, same
-- documented boundary `trades`/`portfolios` already have).
--
-- `steps` is a jsonb array of `PurchaseIntentStepRecord` — same "structured
-- data as jsonb" convention `bag_versions.recipe` already uses. Each
-- element's `lifiStep` sub-field is an opaque LI.FI route payload (public
-- route/calldata data, never a credential) that the CLIENT replays back to
-- LI.FI's own SDK to actually execute — this column is never interpreted
-- for business logic beyond what's read back into
-- `PurchaseIntentStepRecord`'s typed fields.
--
-- No private key, seed phrase, or wallet signature is ever a column on
-- this table.

create table if not exists purchase_intents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  -- Denormalized copy of the session's wallet address at intent-creation
  -- time — never trusted from the client on any subsequent request; every
  -- route re-reads `users.wallet_address` (via the session) and compares.
  wallet_address text not null,
  bag_id uuid not null references bags(id) on delete cascade,

  input_asset_chain text not null check (input_asset_chain in ('ethereum', 'base', 'arbitrum', 'solana', 'robinhood')),
  input_asset_address text not null,
  input_amount_raw text not null,
  -- Locked in at quote time from the same DepositQuote the Purchase
  -- Preview already showed the user — minted verbatim on completion, never
  -- recomputed against NAV at execution time.
  shares_raw text not null,
  share_decimals integer not null default 18,

  route_fingerprint text not null,
  steps jsonb not null,

  status text not null check (status in (
    'DRAFT', 'QUOTED', 'READY', 'AWAITING_SIGNATURE', 'SUBMITTED',
    'CONFIRMING', 'COMPLETED', 'FAILED', 'EXPIRED', 'CANCELLED'
  )),
  failure_code text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null,
  executed_at timestamptz,
  -- Non-null once bag_holdings/bag_share_state accounting has been applied
  -- for this intent — the idempotency guard for spec Aşama 11. Checked
  -- BEFORE calling apply_purchase_execution() below, never after.
  accounting_applied_at timestamptz
);

create index if not exists idx_purchase_intents_user on purchase_intents(user_id, created_at desc);
create index if not exists idx_purchase_intents_bag on purchase_intents(bag_id);

-- No RLS policies — same boundary as `trades` (schema.sql): every read and
-- write goes through a route handler that calls `requireSession()` first
-- and always filters by `auth.session.userId`, using the service-role
-- client. There is no anon/authenticated-role access path to this table at
-- all, so RLS would be redundant defense that's easy to mistakenly rely on
-- instead of the route-level check that's actually authoritative here.

-- ---------------------------------------------------------------------------
-- apply_purchase_execution — atomically applies ONE verified PurchaseIntent's
-- effect on a Bag's holdings and share supply (spec Aşama 11: "1. purchase
-- accounting 2. allocation accounting 3. BAG share update 4. transaction
-- record 5. audit event ... idempotent şekilde uygulanmalı"). Runs as a
-- single Postgres function call — same atomicity guarantee
-- `replace_bag_holdings`/`create_bag_with_initial_version` already rely on
-- — so a Bag can never end up with holdings updated but shares not minted
-- (or vice versa).
--
-- IDEMPOTENCY: `accounting_applied_at` is checked and set INSIDE this same
-- function, under a row lock (`for update`) on the `purchase_intents` row,
-- so two concurrent calls for the same intent can't both pass the check
-- before either commits — the second caller always observes the first
-- caller's write and returns `alreadyApplied: true` without writing again.
-- `total_shares_raw`/`quantity_raw` are additive deltas, not absolute
-- values, so applying this twice would double-mint if the guard were ever
-- bypassed — it must stay the only entry point for this accounting.
-- ---------------------------------------------------------------------------
create or replace function apply_purchase_execution(
  p_intent_id uuid,
  p_bag_id uuid,
  p_holdings jsonb,        -- [{chain, address, decimals, delta_raw}]
  p_shares_delta_raw text,
  p_share_decimals integer,
  p_user_id uuid
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
      'shareState', (select to_jsonb(s.*) from bag_share_state s where s.bag_id = p_bag_id)
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

  update purchase_intents
  set accounting_applied_at = now()
  where id = p_intent_id;

  insert into activities (user_id, action)
  values (p_user_id, 'PURCHASE_EXECUTED:' || p_intent_id::text || ':' || p_bag_id::text);

  select jsonb_build_object(
    'alreadyApplied', false,
    'holdings', coalesce((select jsonb_agg(to_jsonb(bh.*)) from bag_holdings bh where bh.bag_id = p_bag_id), '[]'::jsonb),
    'shareState', (select to_jsonb(s.*) from bag_share_state s where s.bag_id = p_bag_id)
  ) into v_result;

  return v_result;
end;
$$;

revoke execute on function apply_purchase_execution from public;
grant execute on function apply_purchase_execution to service_role;
