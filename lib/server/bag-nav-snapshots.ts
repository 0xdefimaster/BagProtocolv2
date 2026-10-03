import { SupabaseClient } from '@supabase/supabase-js';
import { calculateNavPerShare } from '@/lib/domain/basket-protocol/nav/nav';
import { getBagNavSafe } from '@/lib/server/bag-nav';
import { getShareSupply } from '@/lib/server/bag-share-state-repo';
import { getDisplayPriceProvider } from '@/lib/server/price-provider';
import type { NavResult } from '@/types/basket-protocol';
import type { BagPerformance, NavSnapshotPoint } from '@/types';

// -----------------------------------------------------------------------------
// Recorded NAV history (bag_nav_snapshots, migration 0044) and the returns
// computed from it. Only real snapshots are used: a range whose start lies
// before the first snapshot has no figure (null) instead of an estimate.
// -----------------------------------------------------------------------------

/** A Bag page read records a new snapshot only when the last one is at least this old. */
export const SNAPSHOT_MIN_INTERVAL_MS = 15 * 60 * 1000;

interface SnapshotRow {
  captured_at: string;
  gross_nav: string | number;
  nav_per_share: string | number;
}

const toPoint = (r: SnapshotRow): NavSnapshotPoint => ({
  capturedAt: r.captured_at,
  grossNav: String(r.gross_nav),
  navPerShare: String(r.nav_per_share),
});

/** Snapshots for one Bag, oldest first. */
export async function getNavSnapshots(admin: SupabaseClient, bagId: string, limit = 2000): Promise<NavSnapshotPoint[]> {
  const { data, error } = await admin
    .from('bag_nav_snapshots')
    .select('captured_at,gross_nav,nav_per_share')
    .eq('bag_id', bagId)
    .order('captured_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return ((data ?? []) as SnapshotRow[]).map(toPoint).reverse();
}

export type SnapshotOutcome = 'recorded' | 'recent' | 'no-shares' | 'no-nav';

/**
 * Prices the Bag now and stores one snapshot. Skips when a snapshot newer than
 * `minIntervalMs` exists, when the Bag has no shares yet (no NAV per share), or
 * when NAV cannot be priced — never stores a guessed value.
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

  const supply = await getShareSupply(admin, bagId);
  if (BigInt(supply.totalSharesRaw) === BigInt(0)) return 'no-shares';
  let nav = options.nav;
  if (!nav) {
    const outcome = await getBagNavSafe(admin, bagId, getDisplayPriceProvider());
    if (!outcome.ok) return 'no-nav';
    nav = outcome.nav;
  }

  const navPerShare = calculateNavPerShare(nav, supply.totalSharesRaw, supply.shareDecimals);
  const { error } = await admin.from('bag_nav_snapshots').insert({
    bag_id: bagId,
    captured_at: new Date(now).toISOString(),
    gross_nav: nav.grossNav,
    nav_per_share: navPerShare,
    total_shares_raw: supply.totalSharesRaw,
    share_decimals: supply.shareDecimals,
    quote_currency: nav.quoteCurrency,
  });
  if (error) throw new Error(error.message);
  return 'recorded';
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** % change of NAV per share from the snapshot at (or just before) `start` to the latest one; null when history does not reach back to `start`. Display-only math. */
function changeSince(points: NavSnapshotPoint[], start: number): number | null {
  const latest = points[points.length - 1];
  let base: NavSnapshotPoint | null = null;
  for (const p of points) {
    if (Date.parse(p.capturedAt) <= start) base = p;
    else break;
  }
  if (!base || base === latest) return null;
  const from = Number(base.navPerShare);
  const to = Number(latest.navPerShare);
  if (!(from > 0) || !Number.isFinite(to)) return null;
  return ((to - from) / from) * 100;
}

/** Returns over the standard ranges from recorded snapshots (oldest first). `sinceFirst` covers the whole recorded history. */
export function computeBagPerformance(points: NavSnapshotPoint[], now: number = Date.now()): BagPerformance {
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
  nav_per_share: string | number | null;
  nav_per_share_7d: string | number | null;
  nav_per_share_30d: string | number | null;
  nav_per_share_ytd: string | number | null;
}

function pctFrom(base: string | number | null, latest: number): number | null {
  if (base === null) return null;
  const from = Number(base);
  if (!(from > 0) || !Number.isFinite(latest)) return null;
  return ((latest - from) / from) * 100;
}

/**
 * Listing summaries for many Bags in one call (`bag_nav_summaries`, migration
 * 0045). Bags without a snapshot are absent from the map. Display-only math.
 */
export async function getNavSummaries(admin: SupabaseClient, bagIds: string[]): Promise<Map<string, BagNavSummary>> {
  const out = new Map<string, BagNavSummary>();
  if (bagIds.length === 0) return out;
  const { data, error } = await admin.rpc('bag_nav_summaries', { p_bag_ids: bagIds });
  if (error) throw new Error(error.message);
  for (const row of (data ?? []) as SummaryRow[]) {
    if (!row.latest_at || row.gross_nav === null || row.nav_per_share === null) continue;
    const latest = Number(row.nav_per_share);
    const tvl = Number(row.gross_nav);
    out.set(row.bag_id, {
      tvl: Number.isFinite(tvl) ? tvl : 0,
      latestAt: row.latest_at,
      performance: {
        '7D': pctFrom(row.nav_per_share_7d, latest),
        '30D': pctFrom(row.nav_per_share_30d, latest),
        YTD: pctFrom(row.nav_per_share_ytd, latest),
        sinceFirst: null,
        firstSnapshotAt: null,
        snapshots: 0,
      },
    });
  }
  return out;
}
