-- 0057_outflow_classification.sql
--
-- A sale that wallet reconciliation already took off a position as an unknown outflow (EXTERNAL_OUTFLOW) is booked as
-- the sale it was, proceeds and realized P&L included, without counting its tokens twice.
--
--   wallet_observation_marks     the last block at which a wallet covered everything BAG tracks for an asset.
--   reconciliation_records.prev_block_number
--                                with block_number, the window (prev_block_number, block_number] in which an outflow
--                                happened. Null on records written before this migration: those are never classified.
--   classify_outflow_for_redeem()
--                                given a verified sale (intent, asset, sold quantity, the sale's block), gives back the
--                                part of each confirmed outflow the sale explains: OUTFLOW_CLASSIFIED events return the
--                                tokens to every Bag the outflow was spread over, so the sale is then booked normally by
--                                apply_redeem_execution. Idempotent per (record, intent, Bag); all or nothing.
--   legacy_outflow_overlaps()    whether a sale may be hidden in an outflow recorded before this migration (no window):
--                                such a sale is not booked automatically.
--
-- One transaction is already accounted at most once: a verified transaction hash is claimed by exactly one intent
-- (intent_tx_claims, 0040; rebalance_intents.tx_hash is unique, 0056), and one intent writes at most one fill event
-- (ledger_events.idempotency_key is unique, 0048, and every fill RPC derives it from the intent id).
--
-- Additive: no existing row is changed or deleted; the only re-created function, apply_wallet_observation, keeps its
-- signature and behaviour and additionally records the observation window.

create table if not exists wallet_observation_marks (
  user_id uuid not null,
  chain text not null,
  address text not null,
  last_ok_block bigint not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, chain, address)
);

alter table reconciliation_records add column if not exists prev_block_number bigint;

alter table wallet_observation_marks enable row level security;
revoke all on table wallet_observation_marks from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on table wallet_observation_marks from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on table wallet_observation_marks from authenticated; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on table wallet_observation_marks from service_role;
    -- Written by apply_wallet_observation, which runs as the caller.
    grant select, insert, update on table wallet_observation_marks to service_role;
  end if;
end $$;

-- ----------------------------------------------------------------------------- reconciliation window

-- Re-created from 0056 with only the observation window added (wallet_observation_marks, prev_block_number).
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
  v_last_ok bigint;
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
    -- 0057: the last block at which the wallet covered everything BAG tracks. Any outflow found later happened after it.
    insert into wallet_observation_marks (user_id, chain, address, last_ok_block)
    values (p_user_id, p_chain, p_address, p_block_number)
    on conflict (user_id, chain, address) do update
      set last_ok_block = greatest(wallet_observation_marks.last_ok_block, excluded.last_ok_block), updated_at = now();
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

  select last_ok_block into v_last_ok from wallet_observation_marks
  where user_id = p_user_id and chain = p_chain and address = p_address;

  -- First sighting, or the earlier sighting is too recent: record the drift only.
  if v_open.id is null or v_open.created_at > now() - reconciliation_confirm_after() then
    if v_open.id is null then
      insert into reconciliation_records (user_id, wallet_address, chain, address, block_number, observed_raw, tracked_total_raw, shortfall_raw, allocation, status, prev_block_number)
      values (p_user_id, v_wallet, p_chain, p_address, p_block_number, v_observed::text, v_tracked::text, v_shortfall::text, v_alloc, 'DRIFT', v_last_ok)
      returning id into v_record_id;
    else
      v_record_id := v_open.id;
    end if;
    return jsonb_build_object('status', 'DRIFT', 'recordId', v_record_id, 'trackedRaw', v_tracked::text, 'observedRaw', v_observed::text,
                              'shortfallRaw', v_shortfall::text, 'allocation', v_alloc);
  end if;

  -- Still short on a later observation: book it. Tracked holdings follow the chain down.
  -- 0057: the outflow happened in (prev_block_number, block_number]: after the last covered observation, by this one.
  insert into reconciliation_records (user_id, wallet_address, chain, address, block_number, observed_raw, tracked_total_raw, shortfall_raw, allocation, status, confirms_record_id, prev_block_number)
  values (p_user_id, v_wallet, p_chain, p_address, p_block_number, v_observed::text, v_tracked::text, v_shortfall::text, v_alloc, 'CONFIRMED_OUTFLOW', v_open.id, coalesce(v_open.prev_block_number, v_last_ok))
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

-- ----------------------------------------------------------------------------- classification

-- OUTFLOW_CLASSIFIED gives tracked tokens back (positive legs), so it counts towards tracked holdings like a fill.
create or replace function ledger_exposure_kinds() returns text[]
language sql immutable
as $$ select array['OPENING_BALANCE', 'PURCHASE_FILL', 'REDEEM_FILL', 'EXTERNAL_OUTFLOW', 'REBALANCE_FILL', 'OUTFLOW_CLASSIFIED']::text[] $$;

-- A verified sale (redeem intent `p_redeem_intent_id`, `p_sold_raw` of one asset, mined in block `p_sale_block` at
-- `p_sale_time`) explains part of every CONFIRMED_OUTFLOW of that asset whose window (prev_block_number, block_number]
-- contains the sale's block and whose allocation includes the sale's Bag. Per such record, oldest first:
--   E = what the record took off (sum of its allocation), C = what earlier sales already explained,
--   M = min(remaining sold, E - C).
-- M goes back to the record's Bags in proportion to their allocation (floor, then the remainder in bag_id order,
-- never more than a Bag's own unexplained allocation), as one OUTFLOW_CLASSIFIED event per Bag. The tokens return to
-- bag_investor_holdings and bag_holdings, so apply_redeem_execution can then book the whole sale from the sale's Bag.
--
-- Records without prev_block_number (written before 0057) are never used. All or nothing; a second call for the same
-- intent and asset returns ALREADY_APPLIED without writing. Refused once the sale is booked (ALREADY_BOOKED).
-- `approximate`: the same asset was bought between the sale and the outflow event, so the outflow's average cost
-- (the basis given back) is not exactly the sale's.
create or replace function classify_outflow_for_redeem(
  p_redeem_intent_id uuid,
  p_chain text,
  p_address text,
  p_sold_raw text,
  p_sale_block bigint,
  p_sale_time timestamptz
) returns jsonb
language plpgsql
as $$
declare
  v_intent redeem_intents%rowtype;
  v_address text := lower(p_address);
  v_remaining numeric;
  v_total numeric := 0;
  v_rec reconciliation_records%rowtype;
  v_e numeric;
  v_c numeric;
  v_m numeric;
  v_left numeric;
  v_share numeric;
  v_decimals integer;
  v_outflow_at timestamptz;
  v_approx boolean;
  v_event uuid;
  v_alloc record;
  v_shares jsonb;
  v_out jsonb := '[]'::jsonb;
begin
  if p_sold_raw !~ '^[0-9]+$' or p_sale_block is null or p_sale_block < 0 then
    raise exception 'INVALID_SALE: sold %, block %', p_sold_raw, p_sale_block using errcode = 'check_violation';
  end if;
  select * into v_intent from redeem_intents where id = p_redeem_intent_id for update;
  if v_intent.id is null then
    raise exception 'INTENT_NOT_FOUND: %', p_redeem_intent_id using errcode = 'no_data_found';
  end if;
  if v_intent.accounting_applied_at is not null then
    return jsonb_build_object('status', 'ALREADY_BOOKED', 'classifiedRaw', '0');
  end if;
  if exists (
    select 1 from ledger_events
    where kind = 'OUTFLOW_CLASSIFIED' and user_id = v_intent.user_id
      and source->>'redeemIntentId' = p_redeem_intent_id::text
      and legs->0->>'chain' = p_chain and lower(legs->0->>'address') = v_address
  ) then
    return jsonb_build_object('status', 'ALREADY_APPLIED', 'classifiedRaw', (
      select coalesce(sum((legs->0->>'deltaRaw')::numeric), 0)::text from ledger_events
      where kind = 'OUTFLOW_CLASSIFIED' and user_id = v_intent.user_id
        and source->>'redeemIntentId' = p_redeem_intent_id::text
        and legs->0->>'chain' = p_chain and lower(legs->0->>'address') = v_address));
  end if;

  v_remaining := p_sold_raw::numeric;
  for v_rec in
    select * from reconciliation_records r
    where r.user_id = v_intent.user_id and r.chain = p_chain and lower(r.address) = v_address
      and r.status = 'CONFIRMED_OUTFLOW'
      and r.prev_block_number is not null
      and r.prev_block_number < p_sale_block and p_sale_block <= r.block_number
      and exists (select 1 from jsonb_array_elements(r.allocation) a where (a->>'bagId')::uuid = v_intent.bag_id and (a->>'allocatedRaw')::numeric > 0)
    order by r.created_at, r.id
    for update
  loop
    exit when v_remaining <= 0;
    select coalesce(sum((a->>'allocatedRaw')::numeric), 0) into v_e from jsonb_array_elements(v_rec.allocation) a;
    select coalesce(sum((e.legs->0->>'deltaRaw')::numeric), 0) into v_c from ledger_events e
    where e.kind = 'OUTFLOW_CLASSIFIED' and e.source->>'reconciliationRecordId' = v_rec.id::text;
    v_m := least(v_remaining, v_e - v_c);
    continue when v_m <= 0;

    -- Per Bag: its allocation, what is still unexplained of it, and its proportional floor share of M.
    select jsonb_agg(jsonb_build_object('bagId', x.bag_id, 'cap', x.cap, 'share', least(floor(v_m * x.alloc / v_e), x.cap)) order by x.bag_id)
    into v_shares
    from (
      select (a->>'bagId')::uuid as bag_id, (a->>'allocatedRaw')::numeric as alloc,
             (a->>'allocatedRaw')::numeric - coalesce((
               select sum((e.legs->0->>'deltaRaw')::numeric) from ledger_events e
               where e.kind = 'OUTFLOW_CLASSIFIED' and e.source->>'reconciliationRecordId' = v_rec.id::text
                 and e.bag_id = (a->>'bagId')::uuid), 0) as cap
      from jsonb_array_elements(v_rec.allocation) a
      where (a->>'allocatedRaw')::numeric > 0
    ) x;

    -- The remainder of M, in bag_id order, up to each Bag's cap.
    v_left := v_m - (select coalesce(sum((s->>'share')::numeric), 0) from jsonb_array_elements(v_shares) s);
    select jsonb_agg(s || jsonb_build_object('share', (s->>'share')::numeric + extra) order by s->>'bagId')
    into v_shares
    from (
      select s, greatest(least((s->>'cap')::numeric - (s->>'share')::numeric,
                               v_left - coalesce(sum((s->>'cap')::numeric - (s->>'share')::numeric) over (order by s->>'bagId' rows between unbounded preceding and 1 preceding), 0)), 0) as extra
      from jsonb_array_elements(v_shares) s
    ) t;

    select min(e.created_at) into v_outflow_at from ledger_events e
    where e.kind = 'EXTERNAL_OUTFLOW' and e.source->>'reconciliationRecordId' = v_rec.id::text;
    v_approx := exists (
      select 1 from ledger_events e, jsonb_array_elements(e.legs) l
      where e.user_id = v_intent.user_id and e.kind in ('PURCHASE_FILL', 'REBALANCE_FILL')
        and l->>'chain' = p_chain and lower(l->>'address') = v_address and (l->>'deltaRaw')::numeric > 0
        and e.created_at > p_sale_time and e.created_at < coalesce(v_outflow_at, now())
    );

    for v_alloc in select (s->>'bagId')::uuid as bag_id, (s->>'share')::numeric as share from jsonb_array_elements(v_shares) s loop
      continue when v_alloc.share <= 0;
      select decimals into v_decimals from bag_investor_holdings
      where user_id = v_intent.user_id and bag_id = v_alloc.bag_id and chain = p_chain and lower(address) = v_address;
      v_event := ledger_append(
        v_intent.user_id, v_alloc.bag_id, 'OUTFLOW_CLASSIFIED',
        jsonb_build_array(jsonb_build_object('chain', p_chain, 'address', v_address, 'decimals', v_decimals, 'deltaRaw', v_alloc.share::text)),
        jsonb_build_object('sharesDeltaRaw', '0', 'costBasisDeltaQuote', '0', 'approximate', v_approx),
        jsonb_build_object('reconciliationRecordId', v_rec.id, 'outflowKey', 'EXTERNAL_OUTFLOW:' || v_rec.id::text || ':' || v_alloc.bag_id::text,
                           'redeemIntentId', p_redeem_intent_id, 'chain', p_chain, 'saleBlock', p_sale_block),
        'OUTFLOW_CLASSIFIED:' || v_rec.id::text || ':' || p_redeem_intent_id::text || ':' || v_alloc.bag_id::text,
        null
      );
      if v_event is null then
        raise exception 'CLASSIFICATION_PARTIAL: record %, intent %, bag %', v_rec.id, p_redeem_intent_id, v_alloc.bag_id using errcode = 'check_violation';
      end if;
      update bag_investor_holdings
      set quantity_raw = (quantity_raw::numeric + v_alloc.share)::text, updated_at = now()
      where user_id = v_intent.user_id and bag_id = v_alloc.bag_id and chain = p_chain and lower(address) = v_address;
      update bag_holdings
      set quantity_raw = (quantity_raw::numeric + v_alloc.share)::text, updated_at = now()
      where bag_id = v_alloc.bag_id and chain = p_chain and lower(address) = v_address;
      v_out := v_out || jsonb_build_array(jsonb_build_object('recordId', v_rec.id, 'bagId', v_alloc.bag_id, 'quantityRaw', v_alloc.share::text, 'approximate', v_approx));
    end loop;

    if v_approx then
      perform ledger_append(
        v_intent.user_id, v_intent.bag_id, 'RECONCILIATION_NOTE', '[]'::jsonb,
        jsonb_build_object('note', 'APPROXIMATE_COST_BASIS', 'chain', p_chain, 'address', v_address),
        jsonb_build_object('reconciliationRecordId', v_rec.id, 'redeemIntentId', p_redeem_intent_id),
        'RECONCILIATION_NOTE:APPROXIMATE:' || v_rec.id::text || ':' || p_redeem_intent_id::text,
        null
      );
    end if;

    v_total := v_total + v_m;
    v_remaining := v_remaining - v_m;
  end loop;

  return jsonb_build_object('status', case when v_total > 0 then 'CLASSIFIED' else 'NONE' end, 'classifiedRaw', v_total::text, 'classifications', v_out);
end;
$$;

-- Records that could hide this sale but cannot be classified (written before 0057): the caller must not book the
-- sale automatically. Same user and asset, confirmed after the intent was created, no window.
create or replace function legacy_outflow_overlaps(p_redeem_intent_id uuid) returns boolean
language sql stable
as $$
  select exists (
    select 1 from redeem_intents i
    join ledger_events e on e.user_id = i.user_id and e.bag_id = i.bag_id and e.kind = 'EXTERNAL_OUTFLOW' and e.created_at >= i.created_at
    join reconciliation_records r on r.id::text = e.source->>'reconciliationRecordId'
    where i.id = p_redeem_intent_id and r.prev_block_number is null
  )
$$;

do $$
declare
  v_sig text;
begin
  foreach v_sig in array array[
    'classify_outflow_for_redeem(uuid, text, text, text, bigint, timestamptz)',
    'legacy_outflow_overlaps(uuid)',
    'apply_wallet_observation(uuid, text, text, bigint, text)'
  ] loop
    execute format('revoke execute on function %s from public', v_sig);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke execute on function %s from anon', v_sig); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke execute on function %s from authenticated', v_sig); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', v_sig); end if;
  end loop;
end $$;

notify pgrst, 'reload schema';
