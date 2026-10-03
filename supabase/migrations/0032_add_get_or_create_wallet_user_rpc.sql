-- 0032_add_get_or_create_wallet_user_rpc.sql
--
-- Production-hardening P1-9 — atomic first-login.
--
-- Why: `app/api/auth/verify/route.ts` used to do
--   select users where wallet_address = X
--   if not found: insert into users; insert into portfolios
-- as three separate round trips. Two concurrent FIRST logins for the SAME
-- wallet (e.g. a double-submitted request, or a race between two tabs)
-- could both see "no existing user" from the select, then both attempt the
-- insert into `users` — the second hits `users_wallet_address_key`'s unique
-- violation and the route surfaced that as a raw, unhandled 500, even
-- though from the caller's point of view "sign in with this wallet" is a
-- perfectly normal, retryable request that should just succeed with the
-- (now-existing) user row. There was also a real partial-failure window:
-- if the process crashed / the request was aborted between the `users`
-- insert and the `portfolios` insert, a user could exist with no portfolio
-- row at all, which `getPortfolio()` (lib/server/trading-repo.ts) has no
-- "create on first read" fallback for.
--
-- `get_or_create_wallet_user()` folds both inserts into ONE statement/
-- transaction using the standard concurrent-safe Postgres upsert pattern:
-- `insert ... on conflict ... do nothing returning id` either wins the race
-- (gets a row back) or loses it and blocks on the unique index until the
-- winning transaction commits, then correctly sees nothing returned —
-- never a raised unique-violation. The immediately-following `select`
-- therefore always finds the row (whichever transaction created it), and
-- the portfolio insert uses the exact same `on conflict do nothing`
-- idempotency so a retried call is always safe.
--
-- `ON CONFLICT ON CONSTRAINT users_wallet_address_key` (the constraint
-- name), not `ON CONFLICT (wallet_address)` (the bare column name): this
-- function's own `RETURNS TABLE(..., wallet_address text, ...)` declares a
-- PL/pgSQL variable named `wallet_address` in scope for the whole function
-- body, which shadows a bare `wallet_address` column reference — including
-- inside `ON CONFLICT (wallet_address)`, which failed with "column
-- reference \"wallet_address\" is ambiguous" every time this ran, caught by
-- this project's own real-Postgres integration test
-- (lib/server/__tests__/integration/get-or-create-wallet-user.integration.test.ts).
-- Referencing the constraint by NAME sidesteps the column-name shadowing
-- entirely.
--
-- service_role only, same convention as every other RPC since migration
-- 0026/0027.

create or replace function get_or_create_wallet_user(p_wallet_address text, p_starting_cash_balance numeric)
returns table(id uuid, wallet_address text, display_name text, was_created boolean)
language plpgsql
as $$
declare
  v_user_id uuid;
  v_created boolean := false;
begin
  insert into users (wallet_address)
  values (p_wallet_address)
  on conflict on constraint users_wallet_address_key do nothing
  returning users.id into v_user_id;

  if v_user_id is not null then
    v_created := true;
  else
    -- Lost the race (or this wallet already existed) — the winning
    -- transaction's insert is guaranteed committed-and-visible by the time
    -- ON CONFLICT DO NOTHING itself resolved (Postgres blocks the second
    -- inserter on the unique index until the first commits/rolls back),
    -- so this select cannot miss it.
    select u.id into v_user_id from users u where u.wallet_address = p_wallet_address;
  end if;

  -- Idempotent either way: a genuinely new user gets seeded here; a
  -- pre-existing one (this call losing the race, or a plain repeat login)
  -- leaves its real, possibly-since-changed balance untouched.
  insert into portfolios (user_id, cash_balance)
  values (v_user_id, p_starting_cash_balance)
  on conflict (user_id) do nothing;

  return query
    select u.id, u.wallet_address, u.display_name, v_created
    from users u
    where u.id = v_user_id;
end;
$$;

revoke execute on function get_or_create_wallet_user(text, numeric) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke execute on function get_or_create_wallet_user(text, numeric) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke execute on function get_or_create_wallet_user(text, numeric) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function get_or_create_wallet_user(text, numeric) to service_role;
  end if;
end $$;
