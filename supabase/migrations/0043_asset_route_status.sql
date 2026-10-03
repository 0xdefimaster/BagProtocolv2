-- 0043_asset_route_status.sql
--
-- Liquidity status per registry asset, refreshed in the background by
-- /api/cron/refresh-asset-routes (lib/server/asset-route-refresh.ts): a small
-- LI.FI quote from the chain's payment token into the asset.
--
--   route_status      'ROUTABLE' | 'NO_ROUTE' — null until first checked.
--                     Transient provider errors never overwrite it.
--   route_checked_at  when route_status was last confirmed.
--
-- The Create page hides NO_ROUTE assets from the picker by default. Display
-- only: purchases still quote live and apply the Bag's unroutable-asset
-- policy. Safe to run more than once.

alter table assets
  add column if not exists route_status text,
  add column if not exists route_checked_at timestamptz;

notify pgrst, 'reload schema';
