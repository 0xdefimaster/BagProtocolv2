-- 0037_asset_logo_url.sql
--
-- Token logos for the asset picker. Filled by the importers from each
-- source's own field (Robinhood /rhj/assets `logoUrl`, LI.FI `logoURI`);
-- never guessed. https only, so a registry row can never point the app at a
-- plain-http or javascript:/data: URL.

alter table assets add column if not exists logo_url text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'assets_logo_url_https') then
    alter table assets
      add constraint assets_logo_url_https
      check (logo_url is null or (logo_url like 'https://%' and length(logo_url) <= 2048));
  end if;
end $$;

notify pgrst, 'reload schema';
