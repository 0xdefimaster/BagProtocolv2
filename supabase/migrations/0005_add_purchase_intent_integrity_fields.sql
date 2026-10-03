-- Phase 18 — Purchase Intent Integrity.
--
-- Adds the fields a `PurchaseIntent` locks in at quote time and re-verifies
-- at execute time (types/purchase-intent.ts's `PurchaseIntent` doc
-- comments): the Bag version + composition hash this intent was quoted
-- against, and a NAV/share-price snapshot for audit/reconciliation.
--
-- `recipe_version`/`composition_hash` supersede the weaker "does the set of
-- output assets still match" check `prepareExecution()` used at execute
-- time before this migration — see lib/server/purchase-execution.ts.
--
-- Backfill note: this table only has Phase 17 rows to migrate (pre-Phase-18
-- launch), all created from a single Bag version each — but the backfill
-- below is written defensively (joins to the Bag's CURRENT version, which
-- may not be the version an old intent was actually quoted against) rather
-- than assuming zero existing rows. A backfilled row's `recipe_version`/
-- `composition_hash` may therefore not exactly reflect what that OLD
-- intent was quoted against; this only matters for intents still sitting
-- in a non-terminal status when this migration runs, which will simply
-- fail closed (ROUTE_CHANGED) on their next `prepareExecution()` call if
-- the backfilled value happens not to match the Bag's current version —
-- the correct, safe outcome for a purchase intent of unknown vintage.

alter table purchase_intents
  add column if not exists recipe_version integer,
  add column if not exists composition_hash text,
  add column if not exists nav_gross text,
  add column if not exists nav_quote_currency text,
  add column if not exists nav_as_of timestamptz,
  add column if not exists share_price_at_quote text;

update purchase_intents pi
set
  recipe_version = coalesce(pi.recipe_version, bv.version, 0),
  composition_hash = coalesce(pi.composition_hash, bv.composition_hash, ''),
  nav_gross = coalesce(pi.nav_gross, '0'),
  nav_quote_currency = coalesce(pi.nav_quote_currency, 'USD'),
  nav_as_of = coalesce(pi.nav_as_of, pi.created_at)
from (
  select distinct on (bag_id) bag_id, version, composition_hash
  from bag_versions
  order by bag_id, version desc
) bv
where bv.bag_id = pi.bag_id
  and (pi.recipe_version is null or pi.composition_hash is null or pi.nav_gross is null);

-- Any row with no matching bag_versions entry at all (shouldn't happen —
-- every purchase_intents.bag_id references bags(id), and a Bag can't
-- reach purchase-intent creation without a published version) still needs
-- a non-null value to satisfy the NOT NULL constraint below.
update purchase_intents
set
  recipe_version = coalesce(recipe_version, 0),
  composition_hash = coalesce(composition_hash, ''),
  nav_gross = coalesce(nav_gross, '0'),
  nav_quote_currency = coalesce(nav_quote_currency, 'USD'),
  nav_as_of = coalesce(nav_as_of, created_at)
where recipe_version is null or composition_hash is null or nav_gross is null or nav_quote_currency is null or nav_as_of is null;

alter table purchase_intents
  alter column recipe_version set not null,
  alter column composition_hash set not null,
  alter column nav_gross set not null,
  alter column nav_quote_currency set not null,
  alter column nav_as_of set not null;
