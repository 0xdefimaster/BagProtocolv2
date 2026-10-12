-- 0055_nav_price_index.sql
--
-- Bag returns from a chained price index instead of NAV per share (lib/domain/basket-protocol/nav/price-index.ts).
-- Since Accounting V2 (D1) shares are a mechanical counter: confirmed outflows lower NAV without burning shares and a
-- sale burns a fraction of one investor's shares while removing that investor's own holdings, so NAV per share moved
-- with investor behaviour, not prices. Each snapshot now also stores its holdings and prices (components) and the
-- index chained from the previous snapshot. Additive and idempotent: old rows keep price_index null and are not used
-- for returns (a range reaching before the first indexed snapshot has no figure, as before migration 0044 had any).

alter table bag_nav_snapshots add column if not exists price_index numeric;
alter table bag_nav_snapshots add column if not exists components jsonb;

-- A Bag whose shares reached zero (holdings that outlived them) still has prices to follow.
alter table bag_nav_snapshots alter column nav_per_share drop not null;
alter table bag_nav_snapshots alter column total_shares_raw drop not null;
alter table bag_nav_snapshots alter column share_decimals drop not null;

create index if not exists bag_nav_snapshots_bag_indexed_time_idx
  on bag_nav_snapshots (bag_id, captured_at desc) where price_index is not null;

-- Listing summaries from the index: latest TVL (any snapshot) and the index now / 7 days / 30 days / year start ago.
-- A new function, so a deployment that has not run this migration keeps bag_nav_summaries (0045) working.
create or replace function bag_nav_index_summaries(p_bag_ids uuid[])
returns table (
  bag_id uuid,
  latest_at timestamptz,
  gross_nav numeric,
  price_index text,
  price_index_7d text,
  price_index_30d text,
  price_index_ytd text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    b.id,
    l.captured_at,
    l.gross_nav,
    (select s.price_index::text from bag_nav_snapshots s
      where s.bag_id = b.id and s.price_index is not null
      order by s.captured_at desc limit 1),
    (select s.price_index::text from bag_nav_snapshots s
      where s.bag_id = b.id and s.price_index is not null and s.captured_at <= now() - interval '7 days'
      order by s.captured_at desc limit 1),
    (select s.price_index::text from bag_nav_snapshots s
      where s.bag_id = b.id and s.price_index is not null and s.captured_at <= now() - interval '30 days'
      order by s.captured_at desc limit 1),
    (select s.price_index::text from bag_nav_snapshots s
      where s.bag_id = b.id and s.price_index is not null
        and s.captured_at <= date_trunc('year', now() at time zone 'utc') at time zone 'utc'
      order by s.captured_at desc limit 1)
  from unnest(p_bag_ids) as b(id)
  left join lateral (
    select s.captured_at, s.gross_nav
    from bag_nav_snapshots s
    where s.bag_id = b.id
    order by s.captured_at desc
    limit 1
  ) l on true;
$$;

revoke all on function bag_nav_index_summaries(uuid[]) from public, anon, authenticated;
grant execute on function bag_nav_index_summaries(uuid[]) to service_role;

notify pgrst, 'reload schema';
