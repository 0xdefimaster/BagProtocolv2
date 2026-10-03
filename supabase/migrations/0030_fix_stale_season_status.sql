-- 0030_fix_stale_season_status.sql
--
-- Production-hardening P0-6 — one-time data fix for `seasons.status`.
--
-- Why: `lib/server/season-repo.ts`'s `getCurrentSeason()` now derives
-- status from `start_date`/`end_date` vs `now()` on every read and never
-- trusts this column — so this migration is not required for correctness
-- going forward. It exists anyway because a stale `status = 'ACTIVE'` sitting
-- in the table for a season whose `end_date` has already passed is
-- misleading to anyone who queries `seasons` directly (support, an admin
-- tool, a future migration), and the original seed row
-- ('season-genesis-01', ends 2026-04-01) is such a case as of this
-- revision. Recomputes every row's `status` from its own dates, once.
--
-- Safe to re-run: idempotent, and reflects whatever `now()` is at the time
-- it runs (a season that was UPCOMING when this first ran and has since
-- started would need this re-applied to reflect that — this migration
-- fixes the CURRENT stale row, it does not make the column self-updating;
-- `getCurrentSeason()` is what makes the column's value stop mattering).

update seasons
set status = case
  when now() < start_date then 'UPCOMING'
  when now() < end_date then 'ACTIVE'
  else 'ENDED'
end;
