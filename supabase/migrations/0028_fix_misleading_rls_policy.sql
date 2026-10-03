-- 0028_fix_misleading_rls_policy.sql
--
-- Fixes a misleading (not exploitable, but confusing) RLS policy flagged
-- in docs/FINAL_PRODUCTION_AUDIT.md's security review:
-- `creator_reward_settlements_select_own` reads
--   using (creator_id = auth.uid())
-- which looks like real per-creator row filtering, but `auth.uid()` is
-- always NULL under this app's actual auth model — every session here is
-- this app's own custom-JWT wallet-signature session
-- (lib/auth/session.ts), never Supabase Auth/GoTrue. `auth.uid() = null`
-- makes this policy silently deny every row to the `authenticated` role
-- rather than actually filtering to "your own settlements" the way its
-- name and comment implied.
--
-- Not a security hole either before or after this migration: nothing in
-- this codebase ever queries `creator_reward_settlements` (or any table)
-- with an `authenticated`-role Supabase client — every read goes through
-- lib/server/creator-rewards-settlement-repo.ts /
-- creator-rewards-reconciliation-repo.ts, both server-only, both using the
-- service_role client (lib/supabase/server.ts's `supabaseAdmin()`), which
-- bypasses RLS entirely. The real access boundary for this data is
-- architectural (the browser never gets a Supabase client/key at all — see
-- the audit's own note), not this policy. This migration just stops the
-- policy from claiming to do something it can't, matching the honest
-- "RLS enabled, zero policies -> service_role only" pattern already used
-- by, e.g., bag_deployments and the new rate_limit_buckets table.

drop policy if exists creator_reward_settlements_select_own on creator_reward_settlements;

-- `authenticated` was only ever granted SELECT to make the (non-functional)
-- policy above look load-bearing; revoke it too so the grants match what
-- RLS actually allows (nothing, to any role but service_role).
revoke select on creator_reward_settlements from authenticated;

-- If this table's data is ever genuinely needed from a browser-side
-- Supabase client in the future (it is not today — see above), the
-- correct fix is wiring this app's session into Postgres's
-- `request.jwt.claims` (or an equivalent custom-claims bridge) so
-- `auth.uid()` — or a purpose-built helper reading this app's own claim
-- shape — resolves to a real value, and THEN re-adding a policy like the
-- one removed here. Re-adding the same policy without that bridge would
-- reintroduce the exact same silent-deny-everything bug this migration
-- fixes.
