-- 0044_bag_nav_snapshots.sql
--
-- Recorded NAV history per Bag, for the Performance chart and the 7D / 30D /
-- YTD figures. One row = the Bag's gross NAV over bag_holdings and its NAV
-- per share at one moment, from the same NAV calculation as purchase/redeem
-- (lib/server/bag-nav.ts). Written server-side only (service role):
--   - when a Bag page is read and the last snapshot is older than 15 minutes
--   - by scripts/snapshot-bag-navs.ts (all ACTIVE Bags; run it on a schedule)
-- Nothing is back-filled or estimated: the history starts at the first
-- snapshot. Safe to run more than once.

create table if not exists bag_nav_snapshots (
  id bigserial primary key,
  bag_id uuid not null references bags(id) on delete cascade,
  captured_at timestamptz not null default now(),
  gross_nav numeric not null,
  nav_per_share numeric not null,
  total_shares_raw numeric not null,
  share_decimals integer not null,
  quote_currency text not null default 'USD'
);

create index if not exists bag_nav_snapshots_bag_time_idx on bag_nav_snapshots (bag_id, captured_at desc);

-- Service role only, like the other server-written tables (0040).
alter table bag_nav_snapshots enable row level security;

notify pgrst, 'reload schema';
