'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Bag } from '@/types';
import { bagReturns, formatCompact, formatReturn, formatUsdCompact } from '@/lib/format';
import dynamic from 'next/dynamic';
import { getCategoryBreakdown, getDiversificationScore, CATEGORY_COLORS } from '@/lib/categorize';
import { Users, GitFork, TrendingUp, TrendingDown, Star } from 'lucide-react';
import { VerificationBadge } from '@/components/bags/VerificationBadge';
import { assessRisk } from '@/lib/domain/discovery/bag-discovery';
import { useWatchlist } from '@/lib/watchlist-store';
import { allocationColor } from '@/lib/allocation-colors';

// Loaded when Invest is opened: the purchase flow (LI.FI SDK, viem) stays out of every page that lists Bags.
const PurchasePreviewModal = dynamic(() => import('@/components/app/PurchasePreviewModal').then((m) => m.PurchasePreviewModal), { ssr: false });

interface BagCardProps {
  bag: Bag;
  isNew?: boolean;
}

function initials(name: string) {
  return name
    .split(' ')
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

export function BagCard({ bag, isNew }: BagCardProps) {
  const returns = bagReturns(bag);
  const isPositive = (returns.d7 ?? 0) >= 0;

  const breakdown = getCategoryBreakdown(bag.composition);
  const diversification = getDiversificationScore(bag.composition);
  const dominantCategory = breakdown[0]?.category ?? 'Crypto';
  const accent = CATEGORY_COLORS[dominantCategory];
  const risk = assessRisk(bag.composition);
  const { isWatching, toggleWatch } = useWatchlist();
  const watching = isWatching(bag.id);

  const router = useRouter();

  const [showInvest, setShowInvest] = useState(false);

  const handleCreatorClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    router.push(`/dashboard/creator/${encodeURIComponent(bag.creator.address)}`);
  };

  const handleFork = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // The fork is chosen in the Bag page's editor (ForkPanel), the same one as Edit strategy.
    router.push(`/dashboard/bag/${encodeURIComponent(bag.id)}?fork=1`);
  };

  // Up to three assets by weight; the rest as one "Others" chip.
  const byWeight = [...bag.composition].sort((x, y) => y.weight - x.weight);
  const topAssets = byWeight.slice(0, 3);
  const othersWeight = byWeight.slice(3).reduce((sum, p) => sum + p.weight, 0);
  const version = typeof bag.version === 'number' ? bag.version : 1;
  const rebalance = bag.rules?.rebalanceFrequency || 'Manual';

  return (
    <>
    <Link href={`/dashboard/bag/${bag.id}`} className={`bag-card bag-card-v2 ${isNew ? 'bag-card-new' : ''}`} style={{ ['--accent' as string]: accent }}>
      <div className="bcv-head">
        <span className="bcv-icon" style={{ background: allocationColor(0) }} aria-hidden="true">
          {initials(bag.name)}
        </span>
        <div className="bcv-id">
          <div className="bcv-title">
            <span className="bcv-name">{bag.name}</span>
            <span className="bcv-ver">v{version}</span>
            {isNew && <span className="bag-new-badge">Just Published</span>}
          </div>
          <div className="bcv-by">
            by{' '}
            <span className="creator-link" onClick={handleCreatorClick}>
              {bag.creator.name}
            </span>
            {bag.creator.verified && <span className="bcv-tick" title="Verified creator"> ✓</span>}
          </div>
        </div>
        <button
          type="button"
          className={`watch-btn ${watching ? 'on' : ''}`}
          aria-pressed={watching}
          aria-label={watching ? `Remove ${bag.name} from watchlist` : `Add ${bag.name} to watchlist`}
          title={watching ? 'Watching (saved in this browser)' : 'Watch (saved in this browser)'}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            toggleWatch(bag.id);
          }}
        >
          <Star size={15} fill={watching ? 'currentColor' : 'none'} />
        </button>
      </div>

      <div className="bcv-chips">
        {topAssets.map((pos, i) => (
          <span key={pos.symbol} className="bcv-chip mono" title={`${pos.symbol} · ${pos.weight}%`}>
            <span className="bcv-dot" style={{ background: allocationColor(i) }} />
            {pos.symbol} {pos.weight}%
          </span>
        ))}
        {othersWeight > 0 && (
          <span className="bcv-chip mono">
            <span className="bcv-dot" style={{ background: 'var(--mute)' }} />
            Others {Math.round(othersWeight * 100) / 100}%
          </span>
        )}
      </div>

      <div className="bcv-meta">
        <span className="bcv-chain">{bag.chains.join(' · ')}</span>
        <span>
          <Users size={12} /> {formatCompact(bag.holders ?? bag.followers)} holders
        </span>
        <span>
          <GitFork size={12} /> {formatCompact(bag.forks)} forks
        </span>
        <VerificationBadge verification={bag.verification} />
      </div>

      <div className="bcv-numbers">
        <div>
          <span className="l">TVL</span>
          <div className="bcv-tvl mono">${formatUsdCompact(bag.tvl)}</div>
        </div>
        <div className="bcv-returns">
          <div className={`bcv-ret mono ${(returns.d30 ?? 0) >= 0 ? 'pos' : 'neg'}`}>{formatReturn(returns.d30)}</div>
          <span className="l">30D return</span>
          <div className={`bcv-ret7 mono ${isPositive ? 'pos' : 'neg'}`}>
            {isPositive ? <TrendingUp size={12} /> : <TrendingDown size={12} />} {formatReturn(returns.d7)} 7D
          </div>
        </div>
      </div>

      <div className="bcv-mini">
        <div>
          <span className="l">Risk</span>
          {risk ? (
            <span className={`bag-risk-chip risk-${risk.level.toLowerCase()}`} title={`${risk.reasons.join(' · ')}. Rule-based estimate from the composition, not investment advice.`}>
              {risk.level} risk
            </span>
          ) : (
            <span className="v">—</span>
          )}
        </div>
        <div>
          <span className="l">Rebalance</span>
          <span className="v">{rebalance}</span>
        </div>
        <div>
          <span className="l" title="Diversification score">Spread</span>
          <span className="v">{diversification}/100</span>
        </div>
      </div>

      <div className="bag-actions">
        <button
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setShowInvest(true);
          }}
          className="btn btn-primary"
        >
          Invest
        </button>
        <button onClick={handleFork} className="btn btn-ghost">
          <GitFork size={15} />
          Fork
        </button>
      </div>
    </Link>
    {showInvest && (
      <PurchasePreviewModal bagId={bag.id} bagName={bag.name} onClose={() => setShowInvest(false)} />
    )}
    </>
  );
}

