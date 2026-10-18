'use client';

import Link from 'next/link';
import { CreatorAvatar } from '@/components/creator/CreatorAvatar';
import { VerificationBadge } from '@/components/bags/VerificationBadge';
import { formatCompact, formatReturn, formatUsdCompact } from '@/lib/format';
import type { BagMetric, RankedBag, RankedCreator } from '@/lib/domain/leaderboard/rank';
import { bagDisplayName } from '@/lib/bag-display-name';

const same = (a: string | undefined, b: string | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

export function formatMetric(metric: BagMetric, value: number): string {
  if (metric === 'tvl') return `$${formatUsdCompact(value)}`;
  if (metric === 'return30d' || metric === 'return7d') return formatReturn(value);
  return formatCompact(value);
}

export function BagLeaderboardTable({ rows, metric, metricLabel, selfAddress }: { rows: RankedBag[]; metric: BagMetric; metricLabel: string; selfAddress?: string }) {
  return (
    <table className="leaderboard-table">
      <thead>
        <tr>
          <th>Rank</th>
          <th>Bag</th>
          <th>Creator</th>
          <th>{metricLabel}</th>
          <th>On-chain</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(({ rank, bag, value }) => {
          const own = same(bag.creator?.address, selfAddress);
          const signed = metric === 'return30d' || metric === 'return7d';
          return (
            <tr key={bag.id} className={own ? 'self-row' : undefined}>
              <td>
                <span className={`lb-rank mono ${rank <= 3 ? 'top' : ''}`}>#{rank}</span>
              </td>
              <td>
                <Link href={`/dashboard/bag/${bag.id}`} className="lb-trader">
                  {bagDisplayName(bag)}
                </Link>
              </td>
              <td>
                <Link href={`/dashboard/creator/${bag.creator.address}`} className="lb-trader">
                  {own ? 'You' : bag.creator.name}
                </Link>
              </td>
              <td>
                <span className={`mono ${signed ? (value >= 0 ? 'lb-pnl pos' : 'lb-pnl neg') : 'lb-points'}`}>{formatMetric(metric, value)}</span>
              </td>
              <td>
                <VerificationBadge verification={bag.verification} />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function CreatorLeaderboardTable({ rows, selfAddress }: { rows: RankedCreator[]; selfAddress?: string }) {
  return (
    <table className="leaderboard-table">
      <thead>
        <tr>
          <th>Rank</th>
          <th>Creator</th>
          <th>TVL</th>
          <th>Bags</th>
          <th>Holders</th>
          <th>Best 30D</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((c) => {
          const own = same(c.address, selfAddress);
          return (
            <tr key={c.address} className={own ? 'self-row' : undefined}>
              <td>
                <span className={`lb-rank mono ${c.rank <= 3 ? 'top' : ''}`}>#{c.rank}</span>
              </td>
              <td>
                <Link href={`/dashboard/creator/${c.address}`} className="lb-trader" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                  <CreatorAvatar avatarUrl={c.avatarUrl} fallback={c.avatar || '👤'} size={22} />
                  {own ? 'You' : c.name}
                </Link>
              </td>
              <td>
                <span className="lb-points mono">${formatUsdCompact(c.tvl)}</span>
              </td>
              <td className="mono">{c.bags}</td>
              <td className="mono">{formatCompact(c.holders)}</td>
              <td>
                <span className={`mono ${c.best30d === null ? '' : c.best30d >= 0 ? 'lb-pnl pos' : 'lb-pnl neg'}`}>{formatReturn(c.best30d)}</span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
