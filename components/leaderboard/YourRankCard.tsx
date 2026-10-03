'use client';

interface YourRankCardProps {
  rank: number;
  bagPoints: number;
  realizedPnL: number;
  pointsToNextRank: number;
  isTopTier: boolean;
}

export function YourRankCard({ rank, bagPoints, realizedPnL, pointsToNextRank, isTopTier }: YourRankCardProps) {
  return (
    <div className="your-rank-card">
      <div className="your-rank-stat">
        <span className="l">Your Rank</span>
        <div className="v mono">
          #{rank}
          {isTopTier && <span className="genesis-badge">Genesis Access</span>}
        </div>
      </div>
      <div className="your-rank-stat">
        <span className="l">BAG Points</span>
        <div className="v mono">{bagPoints}</div>
      </div>
      <div className="your-rank-stat">
        <span className="l">Realized PnL</span>
        <div className="v mono" style={{ color: realizedPnL >= 0 ? 'var(--emerald)' : '#E0847A' }}>
          {realizedPnL >= 0 ? '+' : ''}${realizedPnL.toLocaleString()}
        </div>
      </div>
      {!isTopTier && pointsToNextRank > 0 && (
        <div className="your-rank-stat">
          <span className="l">To Rank Above</span>
          <div className="v mono">{pointsToNextRank} pts</div>
        </div>
      )}
    </div>
  );
}
