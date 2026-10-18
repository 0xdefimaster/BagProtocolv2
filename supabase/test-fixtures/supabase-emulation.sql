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

-- Roles are cluster-wide, so test files setting up databases in parallel can race between the existence check
-- and the create: the loser's duplicate is ignored (duplicate_object, or unique_violation on pg_authid).
do $$ begin
  begin create role anon nologin; exception when duplicate_object or unique_violation then null; end;
  begin create role authenticated nologin; exception when duplicate_object or unique_violation then null; end;
  begin create role service_role nologin bypassrls; exception when duplicate_object or unique_violation then null; end;
end $$;

create schema if not exists auth;
create or replace function auth.uid() returns uuid language sql stable as
$$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

grant usage on schema public, auth to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
