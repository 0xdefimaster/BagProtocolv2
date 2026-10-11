'use client';

import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { mockBags } from '@/lib/mock-data';
import { isDemoModeEnabled } from '@/lib/config/demo-mode';
import { usePublicBags } from '@/hooks/usePublicBags';
import { BagCard } from '../bags/BagCard';

const CATEGORIES = ['All', 'AI', 'DeFi', 'RWA', 'Memes', 'Stable', 'L2'];

// -----------------------------------------------------------------------------
// Production-hardening P0-5 — Explore now reads real, published (ACTIVE)
// Bags from `GET /api/bags` (hooks/usePublicBags.ts) instead of the static
// `mockBags` fixture. A Bag a real creator just published through
// Create Bag is now actually reachable here — it used to only ever be
// visible in that creator's own Dashboard, never in Explore, since Explore
// never queried anything real at all. `mockBags` is still used, but ONLY
// under the explicit `NEXT_PUBLIC_DEMO_MODE` flag (default off) — the same
// isolation Dashboard.tsx applies to its own mock data.
// -----------------------------------------------------------------------------

export function FeaturedBags() {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('All');
  const demoMode = isDemoModeEnabled();
  const { bags: apiBags, isLoading, isError, error, refresh } = usePublicBags();

  const sourceBags = useMemo(() => (demoMode ? [...apiBags, ...mockBags] : apiBags), [demoMode, apiBags]);

  const bags = useMemo(() => {
    return sourceBags.filter((bag) => {
      const matchesQuery = bag.name.toLowerCase().includes(query.toLowerCase());
      const matchesCategory = category === 'All' || bag.category === category;
      return matchesQuery && matchesCategory;
    });
  }, [sourceBags, query, category]);

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
            placeholder="Search Bags..."
            className="search-input"
          />
        </div>

        <div className="chip-row">
          {CATEGORIES.map((cat) => (
            <button
              key={cat}
              onClick={() => setCategory(cat)}
              className={`chip ${category === cat ? 'active' : ''}`}
            >
              {cat}
            </button>
          ))}
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
            : `No bags match "${query}" in ${category === 'All' ? 'any category' : category}.`}
        </p>
      )}
    </div>
  );
}
