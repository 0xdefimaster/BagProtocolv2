-- 0003_add_asset_current_multiplier.sql
--
-- Adds `current_multiplier` (nullable decimal-string column) to `assets`.
-- `supabase/schema.sql` already reflects this for fresh installs; this
-- migration brings an EXISTING project's `assets` table up to date without
-- dropping/recreating it.
--
-- Why: Robinhood Stock Tokens carry a corporate-action multiplier
-- (ERC-8056 `uiMultiplier()` — docs.robinhood.com/chain/building-with-
-- stock-tokens) that the registry importer
-- (lib/domain/basket-protocol/registry/robinhood-import.ts) needs
-- somewhere to persist it. Nullable and chain-agnostic: only
-- chain='robinhood' rows populate it today, every other chain's assets
-- keep this null.
--
-- Run this BEFORE running `scripts/import-robinhood-assets.ts --apply` —
-- same ordering requirement as 0002_add_robinhood_chain.sql.

alter table assets
  add column if not exists current_multiplier text;
