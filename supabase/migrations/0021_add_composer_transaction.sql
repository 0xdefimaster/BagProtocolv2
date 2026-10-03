-- 0021_add_composer_transaction.sql
--
-- Adds `composer_transaction` (nullable jsonb) to `purchase_intents`.
--
-- Why: lib/blockchain/lifi-composer-adapter.ts + lifi-purchase-quote.ts's
-- `tryBuildComposerSteps()` can now build a deposit's SWAP steps as ONE
-- shared LI.FI Composer transaction (single signature for N target
-- assets) instead of N independent LI.FI routes. That one transaction's
-- { to, data, value, chainId, userProxy } needs somewhere to live between
-- intent creation and the client actually signing it — this column, read
-- by the SAME route (`app/api/bags/[id]/purchase-intent`) that already
-- returns `steps`, not a new endpoint.
--
-- Deliberately NOT a new table / NOT normalized into `steps` jsonb itself:
-- this is ONE transaction shared across potentially several SWAP step
-- rows, not a per-step value, so it doesn't belong inside any single
-- step's own JSON the way `lifiStep` (needed as: it IS the value)
-- historically has.
--
-- Null for every existing row and for every future non-Composer intent
-- (redemptions always; deposits whenever Composer wasn't eligible or
-- wasn't configured) — `tryBuildComposerSteps()` returning null already
-- means "use the sequential path", and this column mirrors that: null
-- here is the normal case, not a migration gap to backfill.

alter table purchase_intents
  add column if not exists composer_transaction jsonb;
