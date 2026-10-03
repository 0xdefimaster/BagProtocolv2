-- 0002_add_robinhood_chain.sql
--
-- Adds 'robinhood' (Robinhood Chain, chain id 4663 — docs.robinhood.com/chain)
-- to ChainId. `supabase/schema.sql` already reflects this for fresh
-- installs; this migration brings an EXISTING project's `chain in (...)`
-- check constraints up to date without dropping/recreating the tables.
--
-- Run this BEFORE running `scripts/import-robinhood-assets.ts --apply` —
-- every insert into `assets` with chain='robinhood' will fail the check
-- constraint until this is applied.
--
-- Constraint names below are Postgres' default names for the unnamed
-- inline `check (...)` clauses in schema.sql (`<table>_<column>_check`).
-- If you've since renamed them, adjust accordingly — `\d <table>` in psql
-- (or the Supabase Table Editor's "Constraints" tab) will show the actual
-- name.

alter table bags
  drop constraint if exists bags_chain_check,
  add constraint bags_chain_check check (chain in ('ethereum', 'base', 'arbitrum', 'solana', 'robinhood'));

alter table bag_deployments
  drop constraint if exists bag_deployments_chain_check,
  add constraint bag_deployments_chain_check check (chain in ('ethereum', 'base', 'arbitrum', 'solana', 'robinhood'));

alter table assets
  drop constraint if exists assets_chain_check,
  add constraint assets_chain_check check (chain in ('ethereum', 'base', 'arbitrum', 'solana', 'robinhood'));

alter table bag_holdings
  drop constraint if exists bag_holdings_chain_check,
  add constraint bag_holdings_chain_check check (chain in ('ethereum', 'base', 'arbitrum', 'solana', 'robinhood'));
