-- 0038_clear_robinhood_stock_logos.sql
--
-- Robinhood's /rhj/assets `logoUrl` turned out to be the same Robinhood
-- feather for every Stock Token, not the company's logo. The importer no
-- longer stores it (robinhood-import.ts); this clears what 0037-era imports
-- wrote, so the asset picker falls back to the ticker.

update assets
set logo_url = null, updated_at = now()
where chain = 'robinhood' and asset_type = 'stock' and logo_url is not null;
