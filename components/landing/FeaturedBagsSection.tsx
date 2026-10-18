'use client';

import Link from 'next/link';
import { usePublicBags } from '@/hooks/usePublicBags';
import { bagDisplayName } from '@/lib/bag-display-name';

// -----------------------------------------------------------------------------
// Strategy discovery: what a visitor sees for any Bag (an annotated EXAMPLE
// card — creator as part of the identity, allocation, chain, version, lineage,
// and which metrics exist today), the Explore → Open → Invest → Fork path, then
// REAL published Bags from GET /api/bags (no mock fallback on the homepage).
// -----------------------------------------------------------------------------

const BAR_COLOR_BY_INDEX = ['var(--gold)', 'var(--emerald)', 'var(--bronze)', 'var(--ink-soft)'];

const EXAMPLE = {
  name: 'AI Infrastructure',
  creator: '@creator_a',
  description: 'Compute, chips and the platforms that rent them out.',
  chain: 'Robinhood Chain',
  version: 'v3',
  lineage: 'root · 2 forks',
  allocation: [
    { symbol: 'NVDA', weight: 40 },
    { symbol: 'MSFT', weight: 35 },
    { symbol: 'AMD', weight: 25 },
  ],
};

const PATH = ['Explore', 'Open strategy', 'Invest', 'Fork'];

export default function FeaturedBagsSection() {
  const { bags, isLoading, isError, isNotConfigured } = usePublicBags();
  const featured = bags.slice(0, 6);

  return (
    <section className="wrap" id="featured-bags">
      <div className="section-head" data-reveal>
        <span className="kicker">Discovery</span>
        <h2>Every strategy comes with its author.</h2>
        <p>
          Open any Bag and you see what it holds, who built it, which version you are looking
          at and where it came from — then invest in it or fork it.
        </p>
      </div>

      <div className="discovery-grid" data-reveal>
        <article className="discovery-card" aria-label="Example strategy page">
          <div className="dc-head">
            <div className="dc-id">
              <span className="dc-avatar" aria-hidden="true" />
              <div>
                <h3 className="dc-name">{EXAMPLE.name}</h3>
                <span className="dc-creator mono">by {EXAMPLE.creator}</span>
              </div>
            </div>
            <span className="hpc-example-badge">EXAMPLE</span>
          </div>
          <p className="dc-desc">{EXAMPLE.description}</p>
          <div className="dc-alloc">
            {EXAMPLE.allocation.map((a, i) => (
              <div className="lbc-asset-row" key={a.symbol}>
                <span className="lbc-weight">{a.weight}%</span>
                <div className="lbc-track">
                  <div className="lbc-track-fill" style={{ width: `${a.weight}%`, background: BAR_COLOR_BY_INDEX[i] }} />
                </div>
                <span>{a.symbol}</span>
              </div>
            ))}
          </div>
          <dl className="dc-meta">
            <div>
              <dt className="mono">chain</dt>
              <dd>{EXAMPLE.chain}</dd>
            </div>
            <div>
              <dt className="mono">version</dt>
              <dd>{EXAMPLE.version}</dd>
            </div>
            <div>
              <dt className="mono">lineage</dt>
              <dd>{EXAMPLE.lineage}</dd>
            </div>
            <div>
              <dt className="mono">diversification</dt>
              <dd>computed from composition</dd>
            </div>
            <div>
              <dt className="mono">performance history</dt>
              <dd className="dc-soon">coming next</dd>
            </div>
          </dl>
          <div className="dc-actions" aria-hidden="true">
            <span className="dc-btn primary">Invest</span>
            <span className="dc-btn">Fork</span>
          </div>
        </article>

        <div className="discovery-side">
          <ol className="discovery-path">
            {PATH.map((p, i) => (
              <li key={p}>
                <span className="mono">{String(i + 1).padStart(2, '0')}</span>
                {p}
              </li>
            ))}
          </ol>
          <p className="path-caption">
            The creator is not a decoration on the page. The creator, version and parent are
            part of the Bag&apos;s identity, and travel with every fork.
          </p>
        </div>
      </div>

      <h3 className="live-bags-title">Published Bags</h3>

      {isLoading && <p className="landing-bag-empty">Loading Bags…</p>}

      {/* Live data only: /api/bags (Supabase, ACTIVE = deployed Bags). There is no mock fallback on the homepage. */}
      {!isLoading && isNotConfigured && (
        <div className="landing-bag-empty" role="status">
          This deployment isn&apos;t connected to the protocol database, so there are no live Bags to show here.
        </div>
      )}

      {!isLoading && isError && !isNotConfigured && (
        <div className="landing-bag-error" role="alert">
          Couldn&apos;t load Bags right now — try again in a moment.
        </div>
      )}

      {!isLoading && !isError && featured.length === 0 && (
        <div className="landing-bag-empty">
          No Bags have been published yet — <Link href="/dashboard/create">be the first to create one</Link>.
        </div>
      )}

      {!isLoading && !isError && featured.length > 0 && (
        <div className="landing-bag-grid" data-reveal>
          {featured.map((bag) => {
            const topAssets = [...bag.composition].sort((a, b) => b.weight - a.weight).slice(0, 3);
            return (
              <Link href={`/dashboard/bag/${bag.id}`} className="landing-bag-card" key={bag.id}>
                <div className="lbc-name">{bagDisplayName(bag)}</div>
                <div className="lbc-creator">{bag.creator?.name ?? 'Unknown creator'}</div>
                <div className="lbc-composition">
                  {topAssets.map((asset, i) => (
                    <div className="lbc-asset-row" key={asset.symbol}>
                      <span className="lbc-weight">{asset.weight}%</span>
                      <div className="lbc-track">
                        <div
                          className="lbc-track-fill"
                          style={{ width: `${Math.min(100, asset.weight)}%`, background: BAR_COLOR_BY_INDEX[i % BAR_COLOR_BY_INDEX.length] }}
                        />
                      </div>
                      <span>{asset.symbol}</span>
                    </div>
                  ))}
                </div>
                <div className="lbc-foot">
                  <span>{bag.composition.length} asset{bag.composition.length === 1 ? '' : 's'}</span>
                  <span>View Bag →</span>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </section>
  );
}
