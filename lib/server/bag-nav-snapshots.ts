import { SupabaseClient } from '@supabase/supabase-js';
import { calculateNavPerShare } from '@/lib/domain/basket-protocol/nav/nav';
import { indexComponentsFromNav, nextPriceIndex, type IndexComponent } from '@/lib/domain/basket-protocol/nav/price-index';
import { getBagNavSafe } from '@/lib/server/bag-nav';
import { getShareSupply } from '@/lib/server/bag-share-state-repo';
import { getDisplayPriceProvider } from '@/lib/server/price-provider';
import type { NavResult } from '@/types/basket-protocol';
import type { BagPerformance, NavSnapshotPoint } from '@/types';

// -----------------------------------------------------------------------------
// Recorded NAV history (bag_nav_snapshots, migrations 0044 + 0055) and the
// returns computed from it. Returns come from the chained price index
// (price-index.ts): purchases, sales and tokens leaving a wallet never read as
// gain or loss. Only real, indexed snapshots are used: a range whose start lies
// before the first indexed snapshot has no figure (null) instead of an estimate.
// A database without migration 0055 keeps recording NAV (no index) and reports
// no returns.
// -----------------------------------------------------------------------------

/** A Bag page read records a new snapshot only when the last one is at least this old. */
export const SNAPSHOT_MIN_INTERVAL_MS = 15 * 60 * 1000;

interface SnapshotRow {
  captured_at: string;
  gross_nav: string | number;
  nav_per_share: string | number | null;
  price_index?: string | null;
}

const toPoint = (r: SnapshotRow): NavSnapshotPoint => ({
  capturedAt: r.captured_at,
  grossNav: String(r.gross_nav),
  navPerShare: r.nav_per_share === null ? null : String(r.nav_per_share),
  priceIndex: r.price_index ?? null,
});

/** Snapshots for one Bag, oldest first. */
export async function getNavSnapshots(admin: SupabaseClient, bagId: string, limit = 2000): Promise<NavSnapshotPoint[]> {
  const read = (columns: string) =>
    admin.from('bag_nav_snapshots').select(columns).eq('bag_id', bagId).order('captured_at', { ascending: false }).limit(limit);
  let { data, error } = await read('captured_at,gross_nav,nav_per_share,price_index::text');
  if (error) ({ data, error } = await read('captured_at,gross_nav,nav_per_share')); // before migration 0055
  if (error) throw new Error(error.message);
  return ((data ?? []) as unknown as SnapshotRow[]).map(toPoint).reverse();
}

export type SnapshotOutcome = 'recorded' | 'recent' | 'no-holdings' | 'no-shares' | 'no-nav';

/** The Bag's latest indexed snapshot (index + holdings), or null on its first / before migration 0055. */
async function latestIndexed(admin: SupabaseClient, bagId: string): Promise<{ index: string; components: IndexComponent[] } | null> {
  const { data, error } = await admin
    .from('bag_nav_snapshots')
    .select('price_index::text,components')
    .eq('bag_id', bagId)
    .not('price_index', 'is', null)
    .order('captured_at', { ascending: false })
    .limit(1);
  if (error) return null;
  const row = (data ?? [])[0] as { price_index: string | null; components: IndexComponent[] | null } | undefined;
  if (!row?.price_index) return null;
  return { index: row.price_index, components: Array.isArray(row.components) ? row.components : [] };
}

/**
 * Prices the Bag now and stores one snapshot: NAV, the holdings and prices behind it, and the chained price index.
 * Skips when a snapshot newer than `minIntervalMs` exists, when the Bag holds nothing, or when NAV cannot be priced:
 * never stores a guessed value. NAV per share is still stored where shares exist (legacy display only).
 */
export async function recordNavSnapshot(
  admin: SupabaseClient,
  bagId: string,
  /** `nav`: an already-computed NAV for this Bag (e.g. the one the Bag page just priced), so it is not priced twice. */
  options: { minIntervalMs?: number; now?: number; nav?: NavResult } = {}
): Promise<SnapshotOutcome> {
  const now = options.now ?? Date.now();
  const minInterval = options.minIntervalMs ?? SNAPSHOT_MIN_INTERVAL_MS;
  if (minInterval > 0) {
    const { data, error } = await admin
      .from('bag_nav_snapshots')
      .select('captured_at')
      .eq('bag_id', bagId)
      .order('captured_at', { ascending: false })
      .limit(1);
    if (error) throw new Error(error.message);
    const last = data?.[0]?.captured_at as string | undefined;
    if (last && now - Date.parse(last) < minInterval) return 'recent';
  }

  let nav = options.nav;
  if (!nav) {
    const outcome = await getBagNavSafe(admin, bagId, getDisplayPriceProvider());
    if (!outcome.ok) return 'no-nav';
    nav = outcome.nav;
  }
  if (nav.components.length === 0) return 'no-holdings';

  const supply = await getShareSupply(admin, bagId);
  const hasShares = BigInt(supply.totalSharesRaw) > BigInt(0);
  const components = indexComponentsFromNav(nav);
  const base = {
    bag_id: bagId,
    captured_at: new Date(now).toISOString(),
    gross_nav: nav.grossNav,
    quote_currency: nav.quoteCurrency,
  };
  const legacy = hasShares
    ? {
        nav_per_share: calculateNavPerShare(nav, supply.totalSharesRaw, supply.shareDecimals),
        total_shares_raw: supply.totalSharesRaw,
        share_decimals: supply.shareDecimals,
      }
    : { nav_per_share: null, total_shares_raw: null, share_decimals: null };

  const { error } = await admin.from('bag_nav_snapshots').insert({
    ...base,
    ...legacy,
    price_index: nextPriceIndex(await latestIndexed(admin, bagId), components),
    components,
  });
  if (!error) return 'recorded';

  // Before migration 0055 (no price_index/components columns, NAV per share required): the old row.
  if (!hasShares) return 'no-shares';
  const { error: legacyError } = await admin.from('bag_nav_snapshots').insert({ ...base, ...legacy });
  if (legacyError) throw new Error(legacyError.message);
  return 'recorded';
}

const DAY_MS = 24 * 60 * 60 * 1000;

const indexed = (points: NavSnapshotPoint[]) => points.filter((p) => p.priceIndex !== null && Number(p.priceIndex) > 0);

/** % change of the price index from the snapshot at (or just before) `start` to the latest one; null when indexed history does not reach back to `start`. Display-only math. */
function changeSince(points: NavSnapshotPoint[], start: number): number | null {
  const latest = points[points.length - 1];
  let base: NavSnapshotPoint | null = null;
  for (const p of points) {
    if (Date.parse(p.capturedAt) <= start) base = p;
    else break;
  }
  if (!base || base === latest) return null;
  const from = Number(base.priceIndex);
  const to = Number(latest.priceIndex);
  if (!(from > 0) || !Number.isFinite(to)) return null;
  return ((to - from) / from) * 100;
}

/** Returns over the standard ranges from recorded, indexed snapshots (oldest first). `sinceFirst` covers the whole indexed history. */
export function computeBagPerformance(all: NavSnapshotPoint[], now: number = Date.now()): BagPerformance {
  const points = indexed(all);
  if (points.length < 2) {
    return { '7D': null, '30D': null, YTD: null, sinceFirst: null, firstSnapshotAt: points[0]?.capturedAt ?? null, snapshots: points.length };
  }
  const yearStart = Date.UTC(new Date(now).getUTCFullYear(), 0, 1);
  return {
    '7D': changeSince(points, now - 7 * DAY_MS),
    '30D': changeSince(points, now - 30 * DAY_MS),
    YTD: changeSince(points, yearStart),
    sinceFirst: changeSince(points, Date.parse(points[0].capturedAt)),
    firstSnapshotAt: points[0].capturedAt,
    snapshots: points.length,
  };
}

/** What a Bag listing shows per Bag: TVL from the latest snapshot and 7D / 30D / YTD from recorded history (null where it does not reach back). */
export interface BagNavSummary {
  tvl: number;
  latestAt: string;
  performance: BagPerformance;
}

interface SummaryRow {
  bag_id: string;
  latest_at: string | null;
  gross_nav: string | number | null;
  price_index?: string | null;
  price_index_7d?: string | null;
  price_index_30d?: string | null;
  price_index_ytd?: string | null;
}

function pctFrom(base: string | null | undefined, latest: number): number | null {
  if (base === null || base === undefined) return null;
  const from = Number(base);
  if (!(from > 0) || !Number.isFinite(latest)) return null;
  return ((latest - from) / from) * 100;
}

/**
 * Listing summaries for many Bags in one call (`bag_nav_index_summaries`, migration 0055). Bags without a snapshot
 * are absent from the map. Before migration 0055, TVL only (from 0045's `bag_nav_summaries`) and no returns.
 * Display-only math.
 */
export async function getNavSummaries(admin: SupabaseClient, bagIds: string[]): Promise<Map<string, BagNavSummary>> {
  const out = new Map<string, BagNavSummary>();
  if (bagIds.length === 0) return out;
  let { data, error } = await admin.rpc('bag_nav_index_summaries', { p_bag_ids: bagIds });
  if (error) ({ data, error } = await admin.rpc('bag_nav_summaries', { p_bag_ids: bagIds }));
  if (error) throw new Error(error.message);
  for (const row of (data ?? []) as SummaryRow[]) {
    if (!row.latest_at || row.gross_nav === null) continue;
    const tvl = Number(row.gross_nav);
    const latest = row.price_index ? Number(row.price_index) : NaN;
    out.set(row.bag_id, {
      tvl: Number.isFinite(tvl) ? tvl : 0,
      latestAt: row.latest_at,
      performance: {
        '7D': pctFrom(row.price_index_7d, latest),
        '30D': pctFrom(row.price_index_30d, latest),
        YTD: pctFrom(row.price_index_ytd, latest),
        sinceFirst: null,
        firstSnapshotAt: null,
        snapshots: 0,
      },
    });
  }
  return out;
}
