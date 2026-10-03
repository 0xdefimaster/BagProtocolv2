-- Test-only bootstrap: makes a plain PostgreSQL behave like the parts of a
-- Supabase project this schema depends on, so migrations and RPC privileges
-- can be tested against a real database WITHOUT a Supabase project or Docker.
--
-- It is an EMULATION of documented Supabase platform behavior, not Supabase
-- itself: the roles (anon / authenticated / service_role), the `auth.uid()`
-- helper that schema.sql's RLS policies reference, and — importantly — the
-- platform's DEFAULT PRIVILEGES that grant EXECUTE on every new public-schema
-- function directly to anon/authenticated/service_role (which is why
-- `revoke ... from public` alone does not lock an RPC down; see migration 0026).
-- Never applied to a real project.

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;

create schema if not exists auth;
create or replace function auth.uid() returns uuid language sql stable as
$$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

grant usage on schema public, auth to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
