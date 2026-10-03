-- 0027_add_rate_limiting.sql
--
-- Adds a minimal, Postgres-backed rate limiter for the user-facing routes
-- that were flagged (docs/FINAL_PRODUCTION_AUDIT.md's general review) as
-- having NO throttling at all: POST /api/auth/nonce, POST
-- /api/bags/:id/purchase-intent, POST /api/bags/:id/redeem-intent.
--
-- Why Postgres, not in-memory: this app is expected to run as multiple
-- serverless function instances (Vercel), each with its own memory — an
-- in-memory counter would only ever see a fraction of a given caller's
-- requests and would not actually bound abuse. Every other piece of
-- cross-request shared state in this codebase already goes through
-- Supabase (sessions, nonces, intents); this follows the same convention
-- rather than introducing a new kind of shared state (e.g. Redis) for one
-- feature.
--
-- Fixed-window counter, not a sliding window or token bucket: simpler,
-- cheaper (one upsert per check), and the tradeoff — a caller could send
-- up to ~2x max_requests across a window boundary — is acceptable for
-- abuse-prevention/availability protection, which is what this is for.
-- This is NOT a security boundary: every route it's applied to already has
-- its own real enforcement (session auth, ownership checks, on-chain
-- verification, EIP-712 attestation) independent of this table. A missing
-- or failed rate-limit check should never be able to authorize something
-- those other checks wouldn't already allow — see lib/server/rate-limit.ts's
-- own module doc for the corresponding "fail open, not closed" choice this
-- implies.

create table if not exists rate_limit_buckets (
  bucket_key text not null,
  window_start timestamptz not null,
  request_count integer not null default 0,
  primary key (bucket_key, window_start)
);

create index if not exists idx_rate_limit_buckets_window on rate_limit_buckets(window_start);

alter table rate_limit_buckets enable row level security;
-- Deliberately zero policies: RLS enabled + no policies means anon/authenticated
-- can neither read nor write this table at all (same "no client-side access,
-- period" posture as every other server-only table in this schema).
-- service_role bypasses RLS entirely, which is the only client that ever
-- touches this table (see lib/server/rate-limit.ts).

create or replace function check_rate_limit(
  p_bucket_key text,
  p_window_seconds integer,
  p_max_requests integer
) returns table(allowed boolean, retry_after_seconds integer) as $$
declare
  v_window_start timestamptz;
  v_count integer;
begin
  if p_window_seconds <= 0 or p_max_requests <= 0 then
    raise exception 'check_rate_limit: p_window_seconds and p_max_requests must be positive.';
  end if;

  -- Floor `now()` down to the start of the current p_window_seconds-wide
  -- bucket — e.g. a 60s window buckets every request within the same
  -- minute together, regardless of exactly when in that minute it arrived.
  v_window_start := to_timestamp(floor(extract(epoch from clock_timestamp()) / p_window_seconds) * p_window_seconds);

  -- Opportunistic cleanup of old buckets on ~1% of calls, rather than a
  -- separate cron job for one small table — keeps this migration
  -- self-contained. Safe to run concurrently with the insert below (no
  -- shared row).
  if random() < 0.01 then
    delete from rate_limit_buckets where window_start < clock_timestamp() - interval '1 day';
  end if;

  insert into rate_limit_buckets as b (bucket_key, window_start, request_count)
  values (p_bucket_key, v_window_start, 1)
  on conflict (bucket_key, window_start)
  do update set request_count = b.request_count + 1
  returning b.request_count into v_count;

  if v_count > p_max_requests then
    return query select false, greatest(0, ceil(p_window_seconds - extract(epoch from clock_timestamp() - v_window_start)))::integer;
  else
    return query select true, 0;
  end if;
end;
$$ language plpgsql security definer set search_path = public;

revoke execute on function check_rate_limit(text, integer, integer) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke execute on function check_rate_limit(text, integer, integer) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke execute on function check_rate_limit(text, integer, integer) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function check_rate_limit(text, integer, integer) to service_role;
  end if;
end $$;
