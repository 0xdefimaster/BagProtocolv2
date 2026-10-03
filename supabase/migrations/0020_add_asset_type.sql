-- 0020_add_asset_type.sql
--
-- Adds `asset_type` ('crypto' | 'stock') to `assets`.
-- `supabase/schema.sql` already reflects this for fresh installs; this
-- migration brings an EXISTING project's `assets` table up to date without
-- dropping/recreating it — same pattern as 0003_add_asset_current_multiplier.sql.
--
-- Why: until now, every row in this table was a Robinhood Stock Token
-- (robinhood-import.ts), so `lib/registry-assets-client.ts`'s
-- `canonicalAssetToUiAsset()` hardcoded `type: 'stock'` when mapping a
-- registry row to the UI's `Asset` shape. `coingecko-import.ts` now also
-- writes crypto (BTC/ETH/SOL/... ERC-20 deployments) into this same table,
-- so the registry needs its own record of which is which — the UI's
-- All/Crypto/Stocks filter tabs (components/create/AssetSelector.tsx) read
-- straight off this, not off any heuristic (e.g. chain) that would be
-- wrong the day a crypto asset and a Stock Token share a chain.
--
-- Backfill: every row that exists before this migration is a Stock Token
-- (the only importer that has ever run), so `default 'stock'` on the
-- `alter table ... add column` backfills existing rows correctly in the
-- same statement — no separate `update` needed.
--
-- Run this BEFORE running `scripts/import-coin-assets.ts --apply`.

alter table assets
  add column if not exists asset_type text not null default 'stock'
    check (asset_type in ('crypto', 'stock'));

create index if not exists idx_assets_type on assets(asset_type);
