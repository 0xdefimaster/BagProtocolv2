-- 0045_bag_nav_summaries.sql
--
-- One query for the Bag listings (Explore, Profile, Creator): per Bag, the
-- latest recorded NAV snapshot (bag_nav_snapshots, 0044) and the NAV per share
-- at or before 7 days ago, 30 days ago and the start of the year (UTC). The
-- listings show TVL = latest gross NAV and 7D / 30D / YTD from these, without
-- pricing every Bag on every request. Null where no snapshot exists yet.
-- Server-only (service role). Safe to run more than once.

create or replace function bag_nav_summaries(p_bag_ids uuid[])
returns table (
  bag_id uuid,
  latest_at timestamptz,
  gross_nav numeric,
  nav_per_share numeric,
  nav_per_share_7d numeric,
  nav_per_share_30d numeric,
  nav_per_share_ytd numeric
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
    l.nav_per_share,
    (select s.nav_per_share from bag_nav_snapshots s
      where s.bag_id = b.id and s.captured_at <= now() - interval '7 days'
      order by s.captured_at desc limit 1),
    (select s.nav_per_share from bag_nav_snapshots s
      where s.bag_id = b.id and s.captured_at <= now() - interval '30 days'
      order by s.captured_at desc limit 1),
    (select s.nav_per_share from bag_nav_snapshots s
      where s.bag_id = b.id and s.captured_at <= date_trunc('year', now() at time zone 'utc') at time zone 'utc'
      order by s.captured_at desc limit 1)
  from unnest(p_bag_ids) as b(id)
  left join lateral (
    select s.captured_at, s.gross_nav, s.nav_per_share
    from bag_nav_snapshots s
    where s.bag_id = b.id
    order by s.captured_at desc
    limit 1
  ) l on true;
$$;

revoke all on function bag_nav_summaries(uuid[]) from public, anon, authenticated;
grant execute on function bag_nav_summaries(uuid[]) to service_role;

notify pgrst, 'reload schema';
