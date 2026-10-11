'use client';

import { useMemo, useState } from 'react';
import { Trophy } from 'lucide-react';
import { usePublicBags } from '@/hooks/usePublicBags';
import { useWallet } from '@/lib/wallet-context';
import { rankBags, rankCreators, type BagMetric } from '@/lib/domain/leaderboard/rank';
import { BagLeaderboardTable, CreatorLeaderboardTable } from '@/components/leaderboard/LeaderboardTable';

const METRICS: { id: BagMetric; label: string }[] = [
  { id: 'tvl', label: 'TVL' },
  { id: 'return30d', label: '30D return' },
  { id: 'return7d', label: '7D return' },
  { id: 'holders', label: 'Holders' },
  { id: 'forks', label: 'Forks' },
];

// Rankings of the live Bags on BAG Protocol, from the same data Explore shows.
export default function LeaderboardPage() {
  const { bags, isLoading, isError, error, refresh } = usePublicBags();
  const { isConnected, walletAddress } = useWallet();
  const [view, setView] = useState<'bags' | 'creators'>('bags');
  const [metric, setMetric] = useState<BagMetric>('tvl');
  const selfAddress = isConnected ? walletAddress : undefined;

  const bagRows = useMemo(() => rankBags(bags, metric), [bags, metric]);
  const creatorRows = useMemo(() => rankCreators(bags), [bags]);
  const metricLabel = METRICS.find((m) => m.id === metric)!.label;
  const rows = view === 'bags' ? bagRows : creatorRows;

  return (
    <main className="wrap" style={{ paddingBottom: 80, paddingTop: 44 }}>
      <div className="app-intro">
        <span className="eyebrow">
          <span className="dot" />
          Live Bags
        </span>
        <h1 style={{ marginTop: 16 }}>Leaderboard</h1>
        <p className="lead">The top Bags and creators on BAG Protocol, ranked from live data.</p>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 28 }} role="tablist" aria-label="Leaderboard">
        {(['bags', 'creators'] as const).map((v) => (
          <button key={v} type="button" role="tab" aria-selected={view === v} className={`filter-pill ${view === v ? 'active' : ''}`} onClick={() => setView(v)}>
            {v === 'bags' ? 'Bags' : 'Creators'}
          </button>
        ))}
      </div>

      {view === 'bags' && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }} aria-label="Rank Bags by">
          {METRICS.map((m) => (
            <button key={m.id} type="button" aria-pressed={metric === m.id} className={`filter-pill ${metric === m.id ? 'active' : ''}`} onClick={() => setMetric(m.id)}>
              {m.label}
            </button>
          ))}
        </div>
      )}

      <div className="leaderboard-card" style={{ marginTop: 20 }}>
        <div className="leaderboard-head">
          <h2>
            <Trophy size={16} style={{ display: 'inline', marginRight: 8, color: 'var(--gold)' }} />
            {view === 'bags' ? `Top Bags by ${metricLabel}` : 'Top creators by TVL'}
          </h2>
        </div>
        {isLoading ? (
          <div className="positions-empty">Loading leaderboard…</div>
        ) : isError ? (
          <div className="positions-empty">
            Could not load the leaderboard: {error}{' '}
            <button type="button" className="btn btn-ghost" style={{ padding: '4px 10px', fontSize: 12.5 }} onClick={refresh}>
              Retry
            </button>
          </div>
        ) : rows.length === 0 ? (
          <div className="positions-empty">
            {view === 'bags' && (metric === 'return30d' || metric === 'return7d')
              ? 'No Bag has a recorded return for this period yet.'
              : 'No live Bags yet.'}
          </div>
        ) : view === 'bags' ? (
          <div style={{ overflowX: 'auto' }}>
            <BagLeaderboardTable rows={bagRows} metric={metric} metricLabel={metricLabel} selfAddress={selfAddress} />
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <CreatorLeaderboardTable rows={creatorRows} selfAddress={selfAddress} />
          </div>
        )}
      </div>

      <p className="mono" style={{ fontSize: 11, color: 'var(--mute)', marginTop: 16, lineHeight: 1.6 }}>
        TVL and returns come from recorded NAV snapshots, holders from positions BAG has verified on-chain. A Bag with
        no recorded return for a period is not ranked by it. Rankings are not investment advice.
      </p>
    </main>
  );
}
