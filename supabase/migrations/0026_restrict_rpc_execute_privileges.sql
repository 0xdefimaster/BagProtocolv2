-- 0026_restrict_rpc_execute_privileges.sql
--
-- Every server-side RPC in this schema follows the convention
--   revoke execute on function X from public;  grant execute on function X to service_role;
-- On Supabase that is NOT sufficient: the platform's default privileges grant
-- EXECUTE on new public-schema functions DIRECTLY to `anon` and
-- `authenticated`, and `REVOKE ... FROM PUBLIC` does not remove a direct grant.
-- PostgREST exposes public-schema functions as /rest/v1/rpc/<name>, so any of
-- these RPCs (apply_purchase_execution, commit_investment_transaction,
-- confirm_bag_deployment, …) would be callable with just the public anon key.
-- Only table RLS (enabled, no write policies) would then stand between a
-- browser and the function body — and these functions are NOT security
-- definer, so that is the ONLY barrier. This migration removes the direct
-- grants so the intended model (service_role only) actually holds.
--
-- Scope: every non-extension function/procedure in schema `public`. Nothing in
-- the application calls an RPC with the anon/authenticated client (all
-- `.rpc(` calls go through the service-role client, lib/supabase/server.ts).
-- Trigger functions are unaffected (EXECUTE is not checked when a trigger
-- fires). Also changes the default so FUTURE functions are not granted to
-- anon/authenticated. Idempotent; roles that do not exist (plain Postgres)
-- are skipped.

do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as sig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prokind in ('f', 'p')
       and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
  loop
    execute format('revoke execute on function %s from public', r.sig);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke execute on function %s from anon', r.sig);
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke execute on function %s from authenticated', r.sig);
    end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('grant execute on function %s to service_role', r.sig);
    end if;
  end loop;

  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'alter default privileges in schema public revoke execute on functions from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'alter default privileges in schema public revoke execute on functions from authenticated';
  end if;
end $$;
