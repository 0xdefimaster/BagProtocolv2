'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Bag } from '@/types';
import { bagReturns, formatCompact, formatReturn, formatUsdCompact } from '@/lib/format';
import { useForkBag } from '@/hooks/useForkBag';
import dynamic from 'next/dynamic';
import { getCategoryBreakdown, getDiversificationScore, categoryForPosition, CATEGORY_COLORS } from '@/lib/categorize';
import { Users, GitFork, TrendingUp, TrendingDown, Star } from 'lucide-react';
import { VerificationBadge } from '@/components/bags/VerificationBadge';
import { assessRisk } from '@/lib/domain/discovery/bag-discovery';
import { useWatchlist } from '@/lib/watchlist-store';

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
  const topComposition = bag.composition.slice(0, 4);
  const restCount = bag.composition.length - topComposition.length;

  const breakdown = getCategoryBreakdown(bag.composition);
  const diversification = getDiversificationScore(bag.composition);
  const dominantCategory = breakdown[0]?.category ?? 'Crypto';
  const accent = CATEGORY_COLORS[dominantCategory];
  const risk = assessRisk(bag.composition);
  const { isWatching, toggleWatch } = useWatchlist();
  const watching = isWatching(bag.id);

  const router = useRouter();

  const [showInvest, setShowInvest] = useState(false);
  const { fork, isForking, forkError } = useForkBag();

  const handleCreatorClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    router.push(`/dashboard/creator/${encodeURIComponent(bag.creator.address)}`);
  };

  const handleFork = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    void fork(bag);
  };

  return (
    <>
    <Link
      href={`/dashboard/bag/${bag.id}`}
      className={`bag-card bag-card-pro ${isNew ? 'bag-card-new' : ''}`}
      style={{ ['--accent' as string]: accent }}
    >
      <div className="bag-card-accent" />

      <div className="bag-card-head">
        <div className="bag-card-id">
          <span className="bag-avatar-ring">
            <span className="bag-avatar creator-link" onClick={handleCreatorClick}>
              {initials(bag.creator.name)}
            </span>
          </span>
          <div style={{ minWidth: 0 }}>
            <div className="bag-card-title">{bag.name}</div>
            <div className="bag-card-sub">
              by <span className="creator-link" onClick={handleCreatorClick}>{bag.creator.name}</span>
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {isNew && <span className="bag-new-badge">Just Published</span>}
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
      </div>

      <div className="bag-card-tags">
        <span className="bag-category-chip">
          <span className="dot" style={{ background: accent }} />
          {dominantCategory}
        </span>
        {risk && (
          <span className={`bag-risk-chip risk-${risk.level.toLowerCase()}`} title={`${risk.reasons.join(' · ')}. Rule-based estimate from the composition, not investment advice.`}>
            {risk.level} risk
          </span>
        )}
        {/* Phase 11 — only strategy type today; falls back for pre-Phase-11 Bags. */}
        <span className="bag-risk-chip">{bag.strategyType === 'STATIC_BASKET' || !bag.strategyType ? 'Static Basket' : bag.strategyType}</span>
      </div>

      <div className="bag-hero">
        <div>
          <span className="l">TVL</span>
          <div className="bag-hero-value">${formatUsdCompact(bag.tvl)}</div>
        </div>
        <div className={`bag-trend-badge ${isPositive ? 'pos' : 'neg'}`}>
          {isPositive ? <TrendingUp size={13} /> : <TrendingDown size={13} />}
          {formatReturn(returns.d7)} <span className="bag-trend-period">7D</span>
        </div>
      </div>

      <div className="bag-stats bag-stats-secondary">
        <div>
          <span className="l">30D</span>
          <div className={`v ${(returns.d30 ?? 0) >= 0 ? 'pos' : 'neg'}`}>{formatReturn(returns.d30)}</div>
        </div>
        <div>
          <span className="l">YTD</span>
          <div className={`v ${(returns.ytd ?? 0) >= 0 ? 'pos' : 'neg'}`}>{formatReturn(returns.ytd)}</div>
        </div>
        <div>
          <span className="l">Diversification</span>
          <div className="v">{diversification}/100</div>
        </div>
      </div>

      <div className="bag-comp">
        <div className="bag-comp-bar">
          {topComposition.map((pos) => (
            <span
              key={pos.symbol}
              title={`${pos.symbol} · ${pos.weight}%`}
              style={{ width: `${pos.weight}%`, background: CATEGORY_COLORS[categoryForPosition(pos)] }}
            />
          ))}
        </div>
        <div className="bag-comp-legend">
          {topComposition.map((pos) => (
            <span key={pos.symbol}>
              <span className="bag-comp-dot" style={{ background: CATEGORY_COLORS[categoryForPosition(pos)] }} />
              {pos.symbol} <b>{pos.weight}%</b>
            </span>
          ))}
          {restCount > 0 && <span className="bag-comp-more">+{restCount}</span>}
        </div>
      </div>

      <div className="bag-card-footer">
        <div className="bag-footer-stats">
          <span>
            <Users size={12} /> {formatCompact(bag.holders ?? bag.followers)} holders
          </span>
          <span>
            <GitFork size={12} /> {formatCompact(bag.forks)} forks
          </span>
          <VerificationBadge verification={bag.verification} />
        </div>
        <div className="bag-chains">
          {bag.chains.map((chain) => (
            <span key={chain} className="bag-chain-tag">
              {chain}
            </span>
          ))}
        </div>
      </div>

      <div className="bag-actions">
        <button onClick={handleFork} className="btn btn-ghost" disabled={isForking} title={forkError ?? undefined}>
          <GitFork size={15} />
          {isForking ? 'Forking…' : 'Fork'}
        </button>
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
      </div>
    </Link>
    {showInvest && (
      <PurchasePreviewModal bagId={bag.id} bagName={bag.name} onClose={() => setShowInvest(false)} />
    )}
    </>
  );
}

