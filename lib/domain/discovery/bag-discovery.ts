import { categoryForPosition, getCategoryBreakdown, type AssetCategory } from '@/lib/categorize';
import { bagReturns } from '@/lib/format';
import type { Bag, BagPosition } from '@/types';

// -----------------------------------------------------------------------------
// Explore's discovery: which categories a Bag belongs to, a rule-based risk
// level, and the filter/sort the page applies. Everything is derived from the
// Bag's own composition (registry asset types, pinned stablecoin address), so
// the same Bag reads the same everywhere and nothing is self-declared.
// Weights are display percentages (numbers), as in BagPosition.
// -----------------------------------------------------------------------------

/** A Bag is listed under a category holding at least this share of it. */
export const CATEGORY_MATCH_MIN_WEIGHT = 20;

export function bagCategories(composition: BagPosition[]): AssetCategory[] {
  return getCategoryBreakdown(composition)
    .filter((c) => c.weight >= CATEGORY_MATCH_MIN_WEIGHT)
    .map((c) => c.category);
}

export type RiskLevel = 'Low' | 'Medium' | 'High';

export interface RiskAssessment {
  level: RiskLevel;
  /** The facts the level was read from, for a tooltip. */
  reasons: string[];
}

export const RISK_RULES = {
  /** High: this share or more in crypto (an asset without a registry type counts as crypto). */
  highCryptoWeight: 60,
  /** High: one non-stablecoin position this large or larger. */
  highTopWeight: 60,
  /** High: this share or more in meme coins. */
  highMemeWeight: 20,
  /** Low: this share or more in the settlement stablecoin. */
  lowStableWeight: 60,
} as const;

const pct = (n: number) => `${Math.round(n)}%`;

/**
 * A rule-based estimate from the composition, not a forecast: what share sits in the stablecoin, in
 * crypto, in meme coins, and how large the largest position is. Null for an empty composition.
 */
export function assessRisk(composition: BagPosition[]): RiskAssessment | null {
  if (composition.length === 0) return null;
  let stable = 0;
  let crypto = 0;
  let stock = 0;
  let meme = 0;
  let top = 0;
  for (const pos of composition) {
    const w = Number.isFinite(pos.weight) && pos.weight > 0 ? pos.weight : 0;
    const category = categoryForPosition(pos);
    if (category === 'Stable') {
      stable += w;
      continue;
    }
    if (pos.assetType === 'stock') stock += w;
    else crypto += w;
    if (category === 'Meme') meme += w;
    top = Math.max(top, w);
  }

  const reasons: string[] = [];
  if (stable > 0) reasons.push(`${pct(stable)} in stablecoins`);
  if (crypto > 0) reasons.push(`${pct(crypto)} in crypto`);
  if (stock > 0) reasons.push(`${pct(stock)} in stock tokens`);
  if (meme > 0) reasons.push(`${pct(meme)} in meme coins`);
  if (top > 0) reasons.push(`Largest position ${pct(top)}`);

  const level: RiskLevel =
    meme >= RISK_RULES.highMemeWeight || crypto >= RISK_RULES.highCryptoWeight || top >= RISK_RULES.highTopWeight
      ? 'High'
      : stable >= RISK_RULES.lowStableWeight
        ? 'Low'
        : 'Medium';
  return { level, reasons };
}

// ------------------------------ Filter & sort --------------------------------

export const BAG_SORTS = ['newest', 'tvl', 'return30d', 'holders'] as const;
export type BagSort = (typeof BAG_SORTS)[number];

export interface DiscoveryFilter {
  query: string;
  /** 'All', 'Watchlist', or a category. */
  category: 'All' | 'Watchlist' | AssetCategory;
  risk: 'Any' | RiskLevel;
  sort: BagSort;
  watchlist: ReadonlySet<string>;
}

function matchesQuery(bag: Bag, q: string): boolean {
  if (!q) return true;
  return (
    bag.name.toLowerCase().includes(q) ||
    (bag.creator?.name ?? '').toLowerCase().includes(q) ||
    (bag.composition ?? []).some((p) => p.symbol.toLowerCase().includes(q))
  );
}

const nullsLast = (a: number | null, b: number | null) => (a === null ? (b === null ? 0 : 1) : b === null ? -1 : b - a);

/** Filters, then sorts; 'newest' keeps the API's order (newest first). Ties keep their input order. */
export function discoverBags(bags: Bag[], f: DiscoveryFilter): Bag[] {
  const q = f.query.trim().toLowerCase();
  const out = bags.filter((bag) => {
    if (!matchesQuery(bag, q)) return false;
    if (f.category === 'Watchlist' && !f.watchlist.has(bag.id)) return false;
    if (f.category !== 'All' && f.category !== 'Watchlist' && !bagCategories(bag.composition ?? []).includes(f.category)) return false;
    if (f.risk !== 'Any' && assessRisk(bag.composition ?? [])?.level !== f.risk) return false;
    return true;
  });
  if (f.sort === 'newest') return out;
  const value = (bag: Bag): number | null =>
    f.sort === 'tvl' ? (Number.isFinite(bag.tvl) ? bag.tvl : null) : f.sort === 'holders' ? (bag.holders ?? null) : bagReturns(bag).d30;
  return out
    .map((bag, i) => ({ bag, i, v: value(bag) }))
    .sort((a, b) => nullsLast(a.v, b.v) || a.i - b.i)
    .map((x) => x.bag);
}

/** Categories present in at least one Bag, most common first, for the filter chips. */
export function availableCategories(bags: Bag[]): AssetCategory[] {
  const counts = new Map<AssetCategory, number>();
  for (const bag of bags) for (const c of bagCategories(bag.composition ?? [])) counts.set(c, (counts.get(c) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([c]) => c);
}
