'use client';

import { LeaderboardEntry } from '@/types/domain';

interface LeaderboardTableProps {
  entries: LeaderboardEntry[];
  topN: number;
}

export function LeaderboardTable({ entries, topN }: LeaderboardTableProps) {
  return (
    <table className="leaderboard-table">
      <thead>
        <tr>
          <th>Rank</th>
          <th>Trader</th>
          <th>Realized PnL</th>
          <th>BAG Points</th>
        </tr>
      </thead>
      <tbody>
        {entries.map((entry) => (
          <tr
            key={entry.userId}
            className={`${entry.isSelf ? 'self-row' : ''} ${entry.rank <= topN ? 'genesis-row' : ''}`.trim()}
          >
            <td>
              <span className={`lb-rank mono ${entry.rank <= topN ? 'top' : ''}`}>#{entry.rank}</span>
            </td>
            <td>
              <span className="lb-trader">
                {entry.isSelf ? 'You' : entry.displayName}
                {entry.rank <= topN && <span className="genesis-badge">Genesis Access</span>}
              </span>
            </td>
            <td>
              <span className={`lb-pnl mono ${entry.realizedPnL >= 0 ? 'pos' : 'neg'}`}>
                {entry.realizedPnL >= 0 ? '+' : ''}${entry.realizedPnL.toLocaleString()}
              </span>
            </td>
            <td>
              <span className="lb-points mono">{entry.bagPoints}</span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
