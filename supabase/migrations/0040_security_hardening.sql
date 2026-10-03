-- 0040_security_hardening.sql
--
-- Security review follow-ups. Safe to run more than once.
--
--   A. intent_tx_claims — a transaction hash can back at most ONE purchase or
--      redeem intent (the same execution could otherwise be reported for a
--      second intent and mint shares twice).
--   B. auth_nonces — several outstanding nonces per wallet; consuming needs
--      BOTH wallet and nonce. A junk "verify" or a new nonce request for
--      someone else's address can no longer wipe their pending sign-in.
--   C. Settlement worker pays FORK_ROYALTY rows only. Performance fees are
--      settled atomically by RedeemFeeRouter (rows arrive CONFIRMED); an
--      EARNED performance-fee row could only come from the legacy LI.FI
--      redeem path, where no fee was ever collected from the user — paying it
--      would have come out of the protocol's own wallet. Those rows are
--      cancelled.
--   D. Row Level Security on every table that still had it off. The app only
--      uses the service-role key (which bypasses RLS); with RLS on and no
--      policies, the anon/authenticated API roles get nothing.

-- ---------------------------------------------------------------------------
-- A. intent_tx_claims
-- ---------------------------------------------------------------------------
create table if not exists intent_tx_claims (
  chain text not null,
  tx_hash text not null,
  intent_kind text not null check (intent_kind in ('PURCHASE', 'REDEEM')),
  intent_id uuid not null,
  claimed_at timestamptz not null default now(),
  primary key (chain, tx_hash)
);

-- true  = the hash now belongs (or already belonged) to this intent
-- false = a different intent already claimed it
create or replace function claim_intent_tx_hash(
  p_chain text,
  p_tx_hash text,
  p_intent_kind text,
  p_intent_id uuid
) returns boolean
language plpgsql
as $$
declare
  v_owner uuid;
begin
  insert into intent_tx_claims (chain, tx_hash, intent_kind, intent_id)
  values (p_chain, lower(p_tx_hash), p_intent_kind, p_intent_id)
  on conflict (chain, tx_hash) do nothing;

  select intent_id into v_owner from intent_tx_claims where chain = p_chain and tx_hash = lower(p_tx_hash);
  return v_owner = p_intent_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- B. auth_nonces: keyed by nonce, several per wallet
-- ---------------------------------------------------------------------------
-- Only an OLD-shape table (one row per wallet, keyed by wallet_address) is
-- replaced; once the table is keyed by nonce, re-running this leaves it and
-- its pending nonces alone. Nonces are 5-minute, single-use challenges, so
-- dropping the old table only means an in-flight sign-in has to be retried.
drop function if exists consume_auth_nonce(text);
do $$
begin
  if to_regclass('auth_nonces') is not null and not exists (
    select 1
    from pg_index i
    join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any (i.indkey)
    where i.indrelid = 'auth_nonces'::regclass and i.indisprimary and a.attname = 'nonce'
  ) then
    drop table auth_nonces;
  end if;
end $$;

create table if not exists auth_nonces (
  nonce text primary key,
  wallet_address text not null,
  message text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists auth_nonces_wallet_idx on auth_nonces (wallet_address);
create index if not exists auth_nonces_expires_idx on auth_nonces (expires_at);

create or replace function consume_auth_nonce(p_wallet_address text, p_nonce text)
returns table(nonce text, message text, expires_at timestamptz)
language plpgsql
as $$
begin
  -- Opportunistic cleanup so abandoned challenges don't accumulate.
  delete from auth_nonces a where a.expires_at < now() - interval '1 hour';

  return query
    delete from auth_nonces a
    where a.wallet_address = p_wallet_address and a.nonce = p_nonce
    returning a.nonce, a.message, a.expires_at;
end;
$$;

-- ---------------------------------------------------------------------------
-- C. Settlement worker: FORK_ROYALTY only
-- ---------------------------------------------------------------------------
create or replace function claim_reward_settlement_batch(p_worker_id text, p_limit integer default 20)
returns setof creator_reward_settlements
language plpgsql
as $$
begin
  return query
    update creator_reward_settlements
    set status = 'PENDING_SETTLEMENT',
        locked_by = p_worker_id,
        locked_at = now(),
        attempt_count = attempt_count + 1,
        updated_at = now()
    where id in (
      select id from creator_reward_settlements
      where status in ('EARNED', 'RETRYABLE')
        and reward_type = 'FORK_ROYALTY'
      order by created_at asc
      limit p_limit
      for update skip locked
    )
    returning *;
end;
$$;

update creator_reward_settlements
set status = 'CANCELLED',
    failure_reason = 'Legacy (non-router) performance fee: never collected from the redeemer, so never payable by the protocol (0040).',
    updated_at = now()
where reward_type = 'PERFORMANCE_FEE'
  and status in ('EARNED', 'RETRYABLE', 'PENDING_SETTLEMENT');

-- ---------------------------------------------------------------------------
-- Function privileges: service_role only (same convention as 0026/0031).
-- ---------------------------------------------------------------------------
do $$
declare
  v_sig text;
begin
  foreach v_sig in array array[
    'claim_intent_tx_hash(text, text, text, uuid)',
    'consume_auth_nonce(text, text)',
    'claim_reward_settlement_batch(text, integer)'
  ] loop
    execute format('revoke execute on function %s from public', v_sig);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke execute on function %s from anon', v_sig); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke execute on function %s from authenticated', v_sig); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', v_sig); end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- D. Row Level Security everywhere
-- ---------------------------------------------------------------------------
do $$
declare
  v_table text;
begin
  foreach v_table in array array[
    'users', 'auth_nonces', 'purchase_intents', 'redeem_intents',
    'bag_investor_positions', 'bag_investor_holdings', 'investment_commits',
    'accessories', 'box_types', 'seasons', 'leaderboard_snapshots', 'intent_tx_claims'
  ] loop
    if to_regclass('public.' || v_table) is not null then
      execute format('alter table public.%I enable row level security', v_table);
    end if;
  end loop;
end $$;

notify pgrst, 'reload schema';
