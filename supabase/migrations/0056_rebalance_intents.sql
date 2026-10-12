-- 0056_rebalance_intents.sql
--
-- R3 — a user-signed rebalance of one position (docs/ACCOUNTING_V2_DESIGN.md §4.2). The wallet signs ONE LI.FI
-- Composer transaction the server built: the overweight holdings sell, the proceeds buy the underweight ones, all
-- from and back to the user's own wallet. Verification copies what actually left and arrived (receipt Transfer logs)
-- into apply_rebalance_execution.
--
-- Accounting: a rebalance realizes nothing and charges no fee. The basis of what was sold moves to what was bought
-- (split by each buy's share of the proceeds, `weightBps` on its leg), so a gain stays unrealized until the position
-- exits through BAG, where the performance fee applies as before. One REBALANCE_FILL ledger event per intent;
-- holdings move like a sale on the sold legs and a fill on the bought ones; shares and the legacy cost basis do not
-- move.
--
-- Additive and idempotent.

create table if not exists rebalance_intents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  wallet_address text not null,
  bag_id uuid not null references bags(id) on delete cascade,
  target_version integer not null,
  status text not null default 'READY' check (status in ('READY', 'SUBMITTED', 'SUCCEEDED', 'FAILED', 'EXPIRED')),
  -- [{chain, address, decimals, symbol, amountRaw}]
  sells jsonb not null check (jsonb_typeof(sells) = 'array'),
  -- [{chain, address, decimals, symbol, weightBps, expectedOutRaw, minOutRaw}]
  buys jsonb not null check (jsonb_typeof(buys) = 'array'),
  -- {to, data, value, chainId, approvals}
  composer_transaction jsonb not null,
  tx_hash text,
  failure_code text,
  failure_message text,
  -- {sold: [{address, quantityRaw}], bought: [{address, quantityRaw}], blockNumber}
  result jsonb,
  expires_at timestamptz not null,
  submitted_at timestamptz,
  accounting_applied_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists rebalance_intents_user_bag_idx on rebalance_intents (user_id, bag_id, created_at desc);
create index if not exists rebalance_intents_open_idx on rebalance_intents (status, updated_at) where status in ('READY', 'SUBMITTED');
create unique index if not exists rebalance_intents_tx_hash_uniq on rebalance_intents (lower(tx_hash)) where tx_hash is not null;

-- Server-only, like purchase_intents / redeem_intents: every read and write goes through a route that checks the session.
alter table rebalance_intents enable row level security;
revoke all on table rebalance_intents from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on table rebalance_intents from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on table rebalance_intents from authenticated; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on table rebalance_intents from service_role;
    grant select, insert, update on table rebalance_intents to service_role;
  end if;
end $$;

-- The ledger learns the new event kind; it counts towards tracked holdings like the other fills.
alter table ledger_events drop constraint if exists ledger_events_kind_check;
alter table ledger_events add constraint ledger_events_kind_check check (kind in (
  'OPENING_BALANCE', 'PURCHASE_FILL', 'REDEEM_FILL', 'FEE_CHARGED', 'ROYALTY_ACCRUED',
  'EXTERNAL_OUTFLOW', 'OUTFLOW_CLASSIFIED', 'RECONCILIATION_NOTE', 'REBALANCE_FILL'
));

create or replace function ledger_exposure_kinds() returns text[]
language sql immutable
as $$ select array['OPENING_BALANCE', 'PURCHASE_FILL', 'REDEEM_FILL', 'EXTERNAL_OUTFLOW', 'REBALANCE_FILL']::text[] $$;

-- p_sold:   [{chain, address, decimals, quantity_raw}]   what left the wallet, net of any unspent input returned
-- p_bought: [{chain, address, decimals, quantity_raw, weight_bps}]   what arrived
create or replace function apply_rebalance_execution(
  p_intent_id uuid,
  p_user_id uuid,
  p_bag_id uuid,
  p_sold jsonb,
  p_bought jsonb
) returns jsonb
language plpgsql
as $$
declare
  v_intent rebalance_intents%rowtype;
  h jsonb;
  v_qty numeric;
  v_rows integer;
begin
  select * into v_intent from rebalance_intents where id = p_intent_id for update;
  if not found then
    raise exception 'INTENT_NOT_FOUND: rebalance intent %', p_intent_id using errcode = 'no_data_found';
  end if;
  if v_intent.user_id is distinct from p_user_id or v_intent.bag_id is distinct from p_bag_id then
    raise exception 'INTENT_MISMATCH: rebalance intent % belongs to user % bag %', p_intent_id, v_intent.user_id, v_intent.bag_id
      using errcode = 'check_violation';
  end if;
  if v_intent.accounting_applied_at is not null then
    return jsonb_build_object('alreadyApplied', true);
  end if;
  if v_intent.status <> 'SUBMITTED' then
    raise exception 'INTENT_NOT_EXECUTABLE: rebalance intent % is %', p_intent_id, v_intent.status using errcode = 'check_violation';
  end if;
  if jsonb_typeof(p_sold) <> 'array' or jsonb_array_length(p_sold) = 0 or jsonb_typeof(p_bought) <> 'array' or jsonb_array_length(p_bought) = 0 then
    raise exception 'INVALID_ACCOUNTING_DELTA: a rebalance sells and buys something' using errcode = 'check_violation';
  end if;

  for h in select * from jsonb_array_elements(p_sold) loop
    v_qty := (h->>'quantity_raw')::numeric;
    if v_qty <= 0 then
      raise exception 'INVALID_ACCOUNTING_DELTA: sold quantity % must be positive', v_qty using errcode = 'check_violation';
    end if;
    update bag_investor_holdings
    set quantity_raw = (quantity_raw::numeric - v_qty)::text, updated_at = now()
    where user_id = p_user_id and bag_id = p_bag_id and chain = h->>'chain' and address = h->>'address'
      and quantity_raw::numeric >= v_qty;
    get diagnostics v_rows = row_count;
    if v_rows = 0 then
      raise exception 'INVESTOR_HOLDINGS_UNDERFLOW: user % bag % cannot sell % of %', p_user_id, p_bag_id, v_qty, h->>'address';
    end if;
    -- The Bag aggregate follows (never below zero: it may predate per-investor tracking).
    update bag_holdings
    set quantity_raw = greatest(quantity_raw::numeric - v_qty, 0)::text, updated_at = now()
    where bag_id = p_bag_id and chain = h->>'chain' and address = h->>'address';
  end loop;

  for h in select * from jsonb_array_elements(p_bought) loop
    v_qty := (h->>'quantity_raw')::numeric;
    if v_qty <= 0 or (h->>'weight_bps')::integer <= 0 then
      raise exception 'INVALID_ACCOUNTING_DELTA: bought quantity % / weight % must be positive', v_qty, h->>'weight_bps' using errcode = 'check_violation';
    end if;
    insert into bag_investor_holdings (user_id, bag_id, chain, address, quantity_raw, decimals)
    values (p_user_id, p_bag_id, h->>'chain', h->>'address', v_qty::text, (h->>'decimals')::integer)
    on conflict (user_id, bag_id, chain, address) do update
      set quantity_raw = (bag_investor_holdings.quantity_raw::numeric + excluded.quantity_raw::numeric)::text, updated_at = now();
    insert into bag_holdings (bag_id, chain, address, quantity_raw, decimals)
    values (p_bag_id, h->>'chain', h->>'address', v_qty::text, (h->>'decimals')::integer)
    on conflict (bag_id, chain, address) do update
      set quantity_raw = (bag_holdings.quantity_raw::numeric + excluded.quantity_raw::numeric)::text, updated_at = now();
  end loop;

  perform ledger_append(
    p_user_id, p_bag_id, 'REBALANCE_FILL',
    (select coalesce(jsonb_agg(jsonb_build_object('chain', s->>'chain', 'address', s->>'address', 'decimals', (s->>'decimals')::integer,
        'deltaRaw', (-((s->>'quantity_raw')::numeric))::text)), '[]'::jsonb) from jsonb_array_elements(p_sold) s)
    || (select coalesce(jsonb_agg(jsonb_build_object('chain', b->>'chain', 'address', b->>'address', 'decimals', (b->>'decimals')::integer,
        'deltaRaw', b->>'quantity_raw', 'weightBps', (b->>'weight_bps')::integer)), '[]'::jsonb) from jsonb_array_elements(p_bought) b),
    jsonb_build_object('sharesDeltaRaw', '0', 'costBasisDeltaQuote', '0', 'targetVersion', v_intent.target_version),
    jsonb_build_object('intentKind', 'REBALANCE', 'intentId', p_intent_id),
    'REBALANCE_FILL:' || p_intent_id::text,
    v_intent.target_version
  );

  update rebalance_intents
  set status = 'SUCCEEDED', accounting_applied_at = now(), updated_at = now()
  where id = p_intent_id;

  return jsonb_build_object('alreadyApplied', false);
end;
$$;

revoke all on function apply_rebalance_execution(uuid, uuid, uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function apply_rebalance_execution(uuid, uuid, uuid, jsonb, jsonb) to service_role;

-- Wallet reconciliation: a rebalance in flight would read as an outflow of what it sells; settle it first, observe
-- later. Re-created from 0049 with only the in-flight check extended to rebalance intents.
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
  if exists (
    select 1 from rebalance_intents
    where user_id = p_user_id
      and ((status = 'READY' and expires_at > now())
           or (status = 'SUBMITTED' and created_at > now() - interval '1 day'))
  ) then
    return jsonb_build_object('status', 'SKIPPED', 'reason', 'REBALANCE_IN_FLIGHT');
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


notify pgrst, 'reload schema';
