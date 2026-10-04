-- 0049_wallet_reconciliation.sql
--
-- Accounting V2, step A2 (docs/ACCOUNTING_V2_DESIGN.md §5): compare what the
-- ledger says a user holds through BAG with what their wallet actually holds.
--
--   reconciliation_records   one row per (user, asset) observation that found
--                            a shortfall, or that resolved/confirmed one
--   apply_wallet_observation()
--                            the only writer. Given an observed balance at a
--                            block, it allocates any shortfall pro rata across
--                            the user's positions in that asset (allocation
--                            stored on the record), and:
--                              - first sighting       → DRIFT (no ledger change)
--                              - still short ≥ 2 min later → EXTERNAL_OUTFLOW
--                                ledger events; tracked holdings follow the
--                                chain down (bag + investor tables)
--                              - balance back         → open DRIFT resolved
--                            It never runs while the user has a redemption in
--                            flight (its sale would look like an outflow).
--
-- The function only ever trusts the observed balance it is given; callers read
-- it from the chain (RPC), never from a webhook payload. Shares and cost basis
-- are not touched here: per-asset cost basis arrives in A3, shares retire in A4.
--
-- Safe to run more than once.

create table if not exists reconciliation_records (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  wallet_address text not null,
  chain text not null,
  address text not null,
  block_number bigint not null,
  -- Raw integer amounts as text (as elsewhere): JSON numbers would lose precision.
  observed_raw text not null check (observed_raw ~ '^[0-9]+$'),
  tracked_total_raw text not null check (tracked_total_raw ~ '^[0-9]+$'),
  shortfall_raw text not null check (shortfall_raw ~ '^[0-9]+$'),
  -- [{bagId, trackedRaw, allocatedRaw}] at this block — never recomputed later.
  allocation jsonb not null default '[]'::jsonb,
  status text not null check (status in ('DRIFT', 'CONFIRMED_OUTFLOW', 'RESOLVED')),
  reason text not null default 'UNKNOWN_OUTFLOW',
  confirms_record_id uuid references reconciliation_records(id),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index if not exists idx_reconciliation_user_asset on reconciliation_records(user_id, chain, address, created_at desc);
create index if not exists idx_reconciliation_open on reconciliation_records(user_id) where status = 'DRIFT';
alter table reconciliation_records enable row level security;

revoke all on table reconciliation_records from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on table reconciliation_records from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on table reconciliation_records from authenticated; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on table reconciliation_records from service_role;
    grant select, insert, update on table reconciliation_records to service_role;
  end if;
end $$;

-- How long a shortfall must persist before it is booked as an outflow.
create or replace function reconciliation_confirm_after() returns interval
language sql immutable
as $$ select interval '2 minutes' $$;

create or replace function apply_wallet_observation(
  p_user_id uuid,
  p_chain text,
  p_address text,
  p_block_number bigint,
  p_observed_raw text
) returns jsonb
language plpgsql
as $$
declare
  v_wallet text;
  v_observed numeric;
  v_tracked numeric;
  v_shortfall numeric;
  v_open reconciliation_records%rowtype;
  v_alloc jsonb;
  v_record_id uuid;
  r record;
  v_remaining numeric;
  v_share numeric;
  v_n integer;
  v_i integer := 0;
begin
  if p_observed_raw !~ '^[0-9]+$' or p_block_number < 0 then
    raise exception 'INVALID_OBSERVATION: observed %, block %', p_observed_raw, p_block_number using errcode = 'check_violation';
  end if;
  v_observed := p_observed_raw::numeric;
  select wallet_address into v_wallet from users where id = p_user_id;
  if v_wallet is null then
    raise exception 'UNKNOWN_USER: %', p_user_id using errcode = 'no_data_found';
  end if;

  -- A sale in flight would read as an outflow; settle it first, observe later.
  -- (An unsigned one counts only until it expires; a submitted one for a day, so a stuck intent cannot block forever.)
  if exists (
    select 1 from redeem_intents
    where user_id = p_user_id
      and ((status = 'AWAITING_SIGNATURE' and expires_at > now())
           or (status in ('SUBMITTED', 'CONFIRMING') and created_at > now() - interval '1 day'))
  ) then
    return jsonb_build_object('status', 'SKIPPED', 'reason', 'REDEEM_IN_FLIGHT');
  end if;

  -- Serialize with the accounting RPCs for this user's holdings of this asset.
  perform 1 from bag_investor_holdings
  where user_id = p_user_id and chain = p_chain and address = p_address
  for update;

  -- An older observation must never override a newer one.
  if exists (select 1 from reconciliation_records where user_id = p_user_id and chain = p_chain and address = p_address and block_number > p_block_number) then
    return jsonb_build_object('status', 'SKIPPED', 'reason', 'STALE_BLOCK');
  end if;

  select coalesce(sum(quantity_raw::numeric), 0) into v_tracked
  from bag_investor_holdings
  where user_id = p_user_id and chain = p_chain and address = p_address and quantity_raw::numeric > 0;

  select * into v_open from reconciliation_records
  where user_id = p_user_id and chain = p_chain and address = p_address and status = 'DRIFT'
  order by created_at desc limit 1;

  v_shortfall := greatest(v_tracked - v_observed, 0);

  if v_shortfall = 0 then
    if v_open.id is not null then
      update reconciliation_records set status = 'RESOLVED', resolved_at = now()
      where user_id = p_user_id and chain = p_chain and address = p_address and status = 'DRIFT';
      return jsonb_build_object('status', 'RESOLVED', 'trackedRaw', v_tracked::text, 'observedRaw', v_observed::text);
    end if;
    return jsonb_build_object('status', 'OK', 'trackedRaw', v_tracked::text, 'observedRaw', v_observed::text);
  end if;

  -- Pro rata allocation of the shortfall across this user's positions in the asset (integer raw units;
  -- the last position takes the rounding remainder).
  select count(*) into v_n from bag_investor_holdings
  where user_id = p_user_id and chain = p_chain and address = p_address and quantity_raw::numeric > 0;
  v_alloc := '[]'::jsonb;
  v_remaining := v_shortfall;
  for r in
    select bag_id, quantity_raw::numeric as q from bag_investor_holdings
    where user_id = p_user_id and chain = p_chain and address = p_address and quantity_raw::numeric > 0
    order by bag_id
  loop
    v_i := v_i + 1;
    if v_i = v_n then
      v_share := v_remaining;
    else
      v_share := floor(v_shortfall * r.q / v_tracked);
    end if;
    v_share := least(v_share, r.q);
    v_remaining := v_remaining - v_share;
    v_alloc := v_alloc || jsonb_build_array(jsonb_build_object('bagId', r.bag_id, 'trackedRaw', r.q::text, 'allocatedRaw', v_share::text));
  end loop;

  -- First sighting, or the earlier sighting is too recent: record the drift only.
  if v_open.id is null or v_open.created_at > now() - reconciliation_confirm_after() then
    if v_open.id is null then
      insert into reconciliation_records (user_id, wallet_address, chain, address, block_number, observed_raw, tracked_total_raw, shortfall_raw, allocation, status)
      values (p_user_id, v_wallet, p_chain, p_address, p_block_number, v_observed::text, v_tracked::text, v_shortfall::text, v_alloc, 'DRIFT')
      returning id into v_record_id;
    else
      v_record_id := v_open.id;
    end if;
    return jsonb_build_object('status', 'DRIFT', 'recordId', v_record_id, 'trackedRaw', v_tracked::text, 'observedRaw', v_observed::text,
                              'shortfallRaw', v_shortfall::text, 'allocation', v_alloc);
  end if;

  -- Still short on a later observation: book it. Tracked holdings follow the chain down.
  insert into reconciliation_records (user_id, wallet_address, chain, address, block_number, observed_raw, tracked_total_raw, shortfall_raw, allocation, status, confirms_record_id)
  values (p_user_id, v_wallet, p_chain, p_address, p_block_number, v_observed::text, v_tracked::text, v_shortfall::text, v_alloc, 'CONFIRMED_OUTFLOW', v_open.id)
  returning id into v_record_id;
  update reconciliation_records set status = 'RESOLVED', resolved_at = now() where id = v_open.id;

  for r in select (a->>'bagId')::uuid as bag_id, (a->>'allocatedRaw')::numeric as q from jsonb_array_elements(v_alloc) a loop
    continue when r.q <= 0;
    update bag_investor_holdings
    set quantity_raw = (quantity_raw::numeric - r.q)::text, updated_at = now()
    where user_id = p_user_id and bag_id = r.bag_id and chain = p_chain and address = p_address;
    -- The Bag aggregate follows (never below zero: it may predate per-investor tracking).
    update bag_holdings
    set quantity_raw = greatest(quantity_raw::numeric - r.q, 0)::text, updated_at = now()
    where bag_id = r.bag_id and chain = p_chain and address = p_address;

    perform ledger_append(
      p_user_id, r.bag_id, 'EXTERNAL_OUTFLOW',
      jsonb_build_array(jsonb_build_object('chain', p_chain, 'address', p_address,
        'decimals', (select decimals from bag_investor_holdings where user_id = p_user_id and bag_id = r.bag_id and chain = p_chain and address = p_address),
        'deltaRaw', (-r.q)::text)),
      jsonb_build_object('sharesDeltaRaw', '0', 'costBasisDeltaQuote', '0', 'reason', 'UNKNOWN_OUTFLOW'),
      jsonb_build_object('reconciliationRecordId', v_record_id, 'chain', p_chain, 'blockNumber', p_block_number, 'wallet', v_wallet),
      'EXTERNAL_OUTFLOW:' || v_record_id::text || ':' || r.bag_id::text,
      null
    );
  end loop;

  return jsonb_build_object('status', 'CONFIRMED_OUTFLOW', 'recordId', v_record_id, 'trackedRaw', v_tracked::text, 'observedRaw', v_observed::text,
                            'shortfallRaw', v_shortfall::text, 'allocation', v_alloc);
end;
$$;

-- Rotation for the scheduled pass: who was checked when.
create table if not exists wallet_reconciliation_state (
  user_id uuid primary key,
  last_checked_at timestamptz not null,
  last_block_number bigint
);
alter table wallet_reconciliation_state enable row level security;
revoke all on table wallet_reconciliation_state from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on table wallet_reconciliation_state from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on table wallet_reconciliation_state from authenticated; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on table wallet_reconciliation_state from service_role;
    grant select, insert, update on table wallet_reconciliation_state to service_role;
  end if;
end $$;

-- Users holding anything through BAG, least recently checked first. Each row lists the tracked assets.
create or replace function wallet_reconciliation_due(p_limit integer)
returns table (user_id uuid, wallet_address text, assets jsonb)
language sql stable
as $$
  select h.user_id, u.wallet_address,
         jsonb_agg(distinct jsonb_build_object('chain', h.chain, 'address', h.address, 'decimals', h.decimals)) as assets
  from bag_investor_holdings h
  join users u on u.id = h.user_id
  left join wallet_reconciliation_state s on s.user_id = h.user_id
  where h.quantity_raw::numeric > 0 and u.wallet_address is not null
  group by h.user_id, u.wallet_address, s.last_checked_at
  order by s.last_checked_at nulls first, h.user_id
  limit greatest(least(p_limit, 500), 1)
$$;

create or replace function mark_wallet_reconciled(p_user_id uuid, p_block_number bigint) returns void
language sql
as $$
  insert into wallet_reconciliation_state (user_id, last_checked_at, last_block_number)
  values (p_user_id, now(), p_block_number)
  on conflict (user_id) do update set last_checked_at = now(), last_block_number = excluded.last_block_number
$$;

do $$
declare
  v_sig text;
begin
  foreach v_sig in array array[
    'reconciliation_confirm_after()',
    'apply_wallet_observation(uuid, text, text, bigint, text)',
    'wallet_reconciliation_due(integer)',
    'mark_wallet_reconciled(uuid, bigint)'
  ] loop
    execute format('revoke execute on function %s from public', v_sig);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke execute on function %s from anon', v_sig); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke execute on function %s from authenticated', v_sig); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', v_sig); end if;
  end loop;
end $$;
