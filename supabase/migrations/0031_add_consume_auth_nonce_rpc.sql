-- 0031_add_consume_auth_nonce_rpc.sql
--
-- Production-hardening P0-7 — atomic nonce consume.
--
-- Why: `lib/auth/nonce.ts`'s `consumeNonce()` used to do a `select` followed
-- by a separate `delete` against `auth_nonces`. Two concurrent verify
-- requests for the SAME wallet could both `select` the still-present row
-- before either `delete` ran, so the same one-time nonce could pass
-- validation twice — a classic TOCTOU race on a one-time token. A single
-- `delete ... returning` is atomic at the statement level (Postgres row
-- locking makes the second of two concurrent deletes against the same row
-- see no row at all), which is exactly what this RPC is.
--
-- Behavior preserved from the old two-step version, on purpose (spec:
-- "başka bir mevcut akışı sessizce değiştirme"): deletes the row for
-- `p_wallet_address` UNCONDITIONALLY (regardless of which nonce value the
-- caller eventually turns out to have supplied) and returns whatever was
-- there — `consumeNonce()` in application code still separately checks the
-- returned `nonce` against what the caller supplied and `expires_at`
-- against `now()`, same as before. This keeps the original anti-replay
-- property ("a nonce is single-use whether or not it ends up matching")
-- while making the read-then-remove itself a single atomic operation.
--
-- service_role only, same convention as check_rate_limit (0027) — this
-- must never be callable via PostgREST with just the anon key.

create or replace function consume_auth_nonce(p_wallet_address text)
returns table(nonce text, message text, expires_at timestamptz)
language sql
as $$
  delete from auth_nonces
  where wallet_address = p_wallet_address
  returning auth_nonces.nonce, auth_nonces.message, auth_nonces.expires_at;
$$;

revoke execute on function consume_auth_nonce(text) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke execute on function consume_auth_nonce(text) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke execute on function consume_auth_nonce(text) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function consume_auth_nonce(text) to service_role;
  end if;
end $$;
