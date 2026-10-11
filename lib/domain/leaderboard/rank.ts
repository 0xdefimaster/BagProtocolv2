import type { Bag } from '@/types';
import { bagReturns } from '@/lib/format';

// -----------------------------------------------------------------------------
// Leaderboard rankings from live Bags (GET /api/bags): TVL and returns come
// from recorded NAV snapshots, holders from on-ledger positions, forks from
// recorded lineage. A Bag with no recorded figure for a metric is left out of
// that ranking, never ranked as zero. Display only: nothing here moves money.
// -----------------------------------------------------------------------------

export const BAG_METRICS = ['tvl', 'return30d', 'return7d', 'holders', 'forks'] as const;
export type BagMetric = (typeof BAG_METRICS)[number];

export interface RankedBag {
  rank: number;
  bag: Bag;
  value: number;
}

export interface RankedCreator {
  rank: number;
  address: string;
  name: string;
  avatar: string;
  avatarUrl?: string;
  bags: number;
  tvl: number;
  holders: number;
  forks: number;
  /** Best recorded 30D return across the creator's Bags, null when none is recorded. */
  best30d: number | null;
}

const finite = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

export function bagMetricValue(bag: Bag, metric: BagMetric): number | null {
  switch (metric) {
    case 'tvl':
      return finite(bag.tvl) ? bag.tvl : null;
    case 'return30d':
      return bagReturns(bag).d30;
    case 'return7d':
      return bagReturns(bag).d7;
    case 'holders':
      return finite(bag.holders) ? bag.holders : null;
    case 'forks':
      return finite(bag.forks) ? bag.forks : null;
  }
}

/** Highest first; ties by TVL, then name, so the order is stable. */
export function rankBags(bags: readonly Bag[], metric: BagMetric, limit = 50): RankedBag[] {
  return bags
    .map((bag) => ({ bag, value: bagMetricValue(bag, metric) }))
    .filter((r): r is { bag: Bag; value: number } => finite(r.value))
    .sort((a, b) => b.value - a.value || (b.bag.tvl || 0) - (a.bag.tvl || 0) || a.bag.name.localeCompare(b.bag.name))
    .slice(0, limit)
    .map((r, i) => ({ rank: i + 1, ...r }));
}

/** Creators by the TVL of their live Bags; ties by holders, then by name. */
export function rankCreators(bags: readonly Bag[], limit = 50): RankedCreator[] {
  const byCreator = new Map<string, Omit<RankedCreator, 'rank'>>();
  for (const bag of bags) {
    const address = bag.creator?.address;
    if (!address) continue;
    const key = address.toLowerCase();
    const c = byCreator.get(key) ?? {
      address,
      name: bag.creator.name,
      avatar: bag.creator.avatar,
      avatarUrl: bag.creator.avatarUrl,
      bags: 0,
      tvl: 0,
      holders: 0,
      forks: 0,
      best30d: null,
    };
    c.bags += 1;
    c.tvl += finite(bag.tvl) ? bag.tvl : 0;
    c.holders += finite(bag.holders) ? bag.holders : 0;
    c.forks += finite(bag.forks) ? bag.forks : 0;
    const d30 = bagReturns(bag).d30;
    if (d30 !== null && (c.best30d === null || d30 > c.best30d)) c.best30d = d30;
    byCreator.set(key, c);
  }
  return [...byCreator.values()]
    .sort((a, b) => b.tvl - a.tvl || b.holders - a.holders || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((c, i) => ({ rank: i + 1, ...c }));
}
