'use client';

import { useEffect, useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { mockBags } from '@/lib/mock-data';
import { isDemoModeEnabled } from '@/lib/config/demo-mode';
import { usePublicBags } from '@/hooks/usePublicBags';
import { useWatchlist } from '@/lib/watchlist-store';
import {
  availableCategories,
  discoverBags,
  type BagSort,
  type DiscoveryFilter,
  type RiskLevel,
} from '@/lib/domain/discovery/bag-discovery';
import { BagCard } from '../bags/BagCard';

// -----------------------------------------------------------------------------
// Production-hardening P0-5 — Explore now reads real, published (ACTIVE)
// Bags from `GET /api/bags` (hooks/usePublicBags.ts) instead of the static
// `mockBags` fixture. A Bag a real creator just published through
// Create Bag is now actually reachable here — it used to only ever be
// visible in that creator's own Dashboard, never in Explore, since Explore
// never queried anything real at all. `mockBags` is still used, but ONLY
// under the explicit `NEXT_PUBLIC_DEMO_MODE` flag (default off) — the same
// isolation Dashboard.tsx applies to its own mock data.
//
// Discovery (lib/domain/discovery/bag-discovery.ts): category chips are the
// categories the listed Bags actually hold, the risk level is read from each
// composition, and the watchlist lives in this browser.
// -----------------------------------------------------------------------------

const RISKS: ('Any' | RiskLevel)[] = ['Any', 'Low', 'Medium', 'High'];
const SORTS: { id: BagSort; label: string }[] = [
  { id: 'newest', label: 'Newest' },
  { id: 'tvl', label: 'TVL' },
  { id: 'return30d', label: '30D return' },
  { id: 'holders', label: 'Holders' },
];

export function FeaturedBags({ initialQuery }: { initialQuery?: string } = {}) {
  const [query, setQuery] = useState(initialQuery ?? '');
  // A new search from the header (same page, new ?q=) replaces the current one.
  useEffect(() => {
    if (initialQuery !== undefined) setQuery(initialQuery);
  }, [initialQuery]);
  const [category, setCategory] = useState<DiscoveryFilter['category']>('All');
  const [risk, setRisk] = useState<DiscoveryFilter['risk']>('Any');
  const [sort, setSort] = useState<BagSort>('newest');
  const demoMode = isDemoModeEnabled();
  const { bags: apiBags, isLoading, isError, error, refresh } = usePublicBags();
  const { watchlist } = useWatchlist();

  const sourceBags = useMemo(() => (demoMode ? [...apiBags, ...mockBags] : apiBags), [demoMode, apiBags]);
  const categories = useMemo(() => availableCategories(sourceBags), [sourceBags]);
  const bags = useMemo(() => discoverBags(sourceBags, { query, category, risk, sort, watchlist }), [sourceBags, query, category, risk, sort, watchlist]);
  const filtered = query.trim() !== '' || category !== 'All' || risk !== 'Any';

  const chips: { id: DiscoveryFilter['category']; label: string }[] = [
    { id: 'All', label: 'All' },
    { id: 'Watchlist', label: `Watchlist${watchlist.size > 0 ? ` (${watchlist.size})` : ''}` },
    ...categories.map((c) => ({ id: c, label: c })),
  ];

  return (
    <div>
      <span className="section-label">Featured Bags</span>

      <div className="search-row">
        <div className="search-input-wrap">
          <Search size={17} />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search Bags, creators or assets..."
            className="search-input"
            aria-label="Search Bags"
          />
        </div>

        <div className="chip-row" aria-label="Category">
          {chips.map((c) => (
            <button key={c.id} type="button" aria-pressed={category === c.id} onClick={() => setCategory(c.id)} className={`chip ${category === c.id ? 'active' : ''}`}>
              {c.label}
            </button>
          ))}
        </div>

        <div className="discover-controls">
          <label>
            <span>Risk</span>
            <select value={risk} onChange={(e) => setRisk(e.target.value as DiscoveryFilter['risk'])} aria-label="Risk level">
              {RISKS.map((r) => (
                <option key={r} value={r}>
                  {r === 'Any' ? 'Any' : `${r} risk`}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Sort</span>
            <select value={sort} onChange={(e) => setSort(e.target.value as BagSort)} aria-label="Sort by">
              {SORTS.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {isLoading && bags.length === 0 && (
        <p style={{ color: 'var(--ink-soft)', fontSize: 13.5, marginTop: 24 }}>Loading bags…</p>
      )}

      {isError && (
        <div style={{ marginTop: 24, display: 'flex', alignItems: 'center', gap: 10 }}>
          <p style={{ color: '#E0847A', fontSize: 13.5 }}>{error ?? 'Could not load bags.'}</p>
          <button className="btn btn-ghost" style={{ padding: '4px 10px', fontSize: 12.5 }} onClick={() => refresh()}>
            Retry
          </button>
        </div>
      )}

      {!isLoading && !isError && bags.length > 0 && (
        <div className="bag-grid">
          {bags.map((bag) => (
            <BagCard key={bag.id} bag={bag} />
          ))}
        </div>
      )}

      {!isLoading && !isError && bags.length === 0 && (
        <p style={{ color: 'var(--ink-soft)', fontSize: 13.5, marginTop: 24 }}>
          {sourceBags.length === 0
            ? 'No bags have been published yet — be the first to create one.'
            : category === 'Watchlist' && watchlist.size === 0
              ? 'Your watchlist is empty. Tap the star on a Bag to watch it; the list is kept in this browser.'
              : filtered
                ? 'No bags match these filters.'
                : 'No bags to show.'}
        </p>
      )}
    </div>
  );
}
