'use client';

import Link from 'next/link';
import { Trophy } from 'lucide-react';
import { useLeaderboard } from '@/hooks/useLeaderboard';
import { LeaderboardTable } from '@/components/leaderboard/LeaderboardTable';
import { YourRankCard } from '@/components/leaderboard/YourRankCard';

export default function LeaderboardPage() {
  const { result, season } = useLeaderboard();

  return (
    <main className="wrap" style={{ paddingBottom: 80, paddingTop: 44 }}>
      <div className="app-intro">
        <span className="eyebrow">
          <span className="dot" />
          {season ? `${season.name} · Active` : 'No active season right now'}
        </span>
        <h1 style={{ marginTop: 16 }}>Genesis Leaderboard</h1>
        <p className="lead">
          Ranked by realized paper-trading PnL this season. The top {result?.topN ?? 20} traders get first access
          to BAG Protocol on Robinhood Chain mainnet.
        </p>
      </div>

      {result?.self && (
        <div style={{ marginTop: 32 }}>
          <YourRankCard
            rank={result.self.rank}
            bagPoints={result.self.bagPoints}
            realizedPnL={result.self.realizedPnL}
            pointsToNextRank={result.self.pointsToNextRank}
            isTopTier={result.self.rank <= result.topN}
          />
        </div>
      )}

      <div className="leaderboard-card" style={{ marginTop: 20 }}>
        <div className="leaderboard-head">
          <h2>
            <Trophy size={16} style={{ display: 'inline', marginRight: 8, color: 'var(--gold)' }} />
            Top {result?.topN ?? 20}
          </h2>
          <Link href="/dashboard/portfolio" className="btn btn-ghost" style={{ padding: '8px 16px', fontSize: 12.5 }}>
            Trade to climb →
          </Link>
        </div>
        {result ? (
          <LeaderboardTable entries={result.entries} topN={result.topN} />
        ) : (
          <div className="positions-empty">Loading leaderboard…</div>
        )}
      </div>

      <p className="mono" style={{ fontSize: 11, color: 'var(--mute)', marginTop: 16, lineHeight: 1.6 }}>
        Genesis Season 01 access is an early-access tier for the BAG Protocol product, not an investment return or
        financial guarantee. Rankings other than yours are simulated demo activity for this MVP.
      </p>
    </main>
  );
}
