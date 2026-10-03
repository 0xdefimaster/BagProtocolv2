'use client';

import { mockUser, mockUserBags } from '@/lib/mock-data';
import { isDemoModeEnabled } from '@/lib/config/demo-mode';
import { useUserBags } from '@/lib/user-bags-store';
import { useMyBags } from '@/hooks/useMyBags';
import { useActivity, formatRelativeTime } from '@/lib/activity-store';
import { usePortfolio } from '@/lib/portfolio-store';
import { usePaperPortfolio } from '@/hooks/usePaperPortfolio';
import { usePoints } from '@/hooks/usePoints';
import { useLeaderboard } from '@/hooks/useLeaderboard';
import { Plus, TrendingUp, Users, Upload, Send, Trophy, Boxes, Wallet2 } from 'lucide-react';
import Link from 'next/link';
import { useRef } from 'react';
import { BagCard } from '../bags/BagCard';
import { Bag } from '@/types';

interface DashboardProps {
  isConnected: boolean;
}

export function Dashboard({ isConnected }: DashboardProps) {
  const { userBags: localBags, addBag } = useUserBags();
  const {
    bags: apiBags,
    isLoading: myBagsLoading,
    isError: myBagsError,
    error: myBagsErrorMessage,
    isAuthenticated,
    refresh: refreshMyBags,
  } = useMyBags();
  const { activity } = useActivity();
  const { following, totalInvested } = usePortfolio();
  const { portfolio, unrealizedPnL, totalValue: paperTotalValue } = usePaperPortfolio();
  const { points } = usePoints();
  const { result: leaderboard } = useLeaderboard();
  const fileInputRef = useRef<HTMLInputElement>(null);

  if (!isConnected) {
    return null;
  }

  // Production-hardening P0-4 — mock/demo data is isolated behind the
  // explicit `NEXT_PUBLIC_DEMO_MODE` flag and OFF by default, everywhere
  // in production. This component only ever renders for a signed-in,
  // wallet-connected caller (see the `!isConnected` early return above) —
  // it used to blend `mockUser`/`mockUserBags` into every metric on this
  // screen regardless, which meant a REAL user's real portfolio value,
  // bag count, and "Forks Made" count were always padded with fabricated
  // numbers they never actually earned. `demoMode` is `false` in every
  // real deployment unless an operator explicitly opts in for a demo
  // environment.
  const demoMode = isDemoModeEnabled();

  // Signed-in (wallet-signature verified) users: Supabase (GET /api/bags?mine=1)
  // is the source of truth. Not-yet-signed-in / offline: localStorage is the
  // fallback so the demo loop keeps working. These two are never merged —
  // mixing a session-scoped list with a per-browser list is exactly the
  // duplicate/ID-conflict risk we're avoiding.
  const userBags = isAuthenticated ? apiBags : localBags;
  // Freshly published bags (from the Create flow) show up first, ahead of
  // the demo bags — but ONLY in demo mode. In production this is just
  // `userBags`: real bags only, never padded with `mockUserBags`.
  const allMyBags = demoMode ? [...userBags, ...mockUserBags] : userBags;
  const totalMyBags = demoMode ? mockUser.myBags + userBags.length : userBags.length;
  const totalFollowing = demoMode ? mockUser.following + following.length : following.length;
  const portfolioValue = demoMode ? mockUser.balance + totalInvested : totalInvested;
  // "Forks Made" has no real backend tracking yet (no fork-count endpoint
  // exists) — rather than inventing one (out of scope for this sprint) or
  // continuing to show a fabricated `mockUser.forks`, a real, connected
  // user's true known fork count is honestly 0 until that feature ships.
  const totalForks = demoMode ? mockUser.forks : 0;

  const handleImportClick = () => fileInputRef.current?.click();

  const handleImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-selecting the same file next time
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result as string);
        const imported: Bag = {
          ...parsed,
          id: `imported-${Date.now()}`,
          creator: parsed.creator || { name: 'You', avatar: '👤', address: mockUser.address, followers: 0, forks: 0 },
        };
        addBag(imported);
      } catch {
        alert('Could not read that file — make sure it\'s a valid bag.json export.');
      }
    };
    reader.readAsText(file);
  };

  return (
    <div style={{ paddingTop: 48, display: 'flex', flexDirection: 'column', gap: 48 }}>
      <div>
        <div className="dash-stats">
          <div className="dash-stat">
            <span className="l">Portfolio Value</span>
            <div className="v">${(portfolioValue / 1000).toFixed(0)}K</div>
            <div className="d pos">
              <TrendingUp size={13} />
              +12.5% (7D)
            </div>
          </div>
          <div className="dash-stat">
            <span className="l">My Bags</span>
            <div className="v">{totalMyBags}</div>
            <div className="d">
              <Link href="/dashboard/profile#my-bags">View all →</Link>
            </div>
          </div>
          <div className="dash-stat">
            <span className="l">Following</span>
            <div className="v">{totalFollowing}</div>
            <div className="d">
              <Users size={13} />
              creators
            </div>
          </div>
          <div className="dash-stat">
            <span className="l">Forks Made</span>
            <div className="v">{totalForks}</div>
            <div className="d">custom portfolios</div>
          </div>
        </div>
      </div>

      <div>
        <span className="section-label">Paper Trading &amp; BAG Points</span>
        <div className="dash-stats">
          <div className="dash-stat">
            <span className="l">Paper Portfolio</span>
            <div className="v">${paperTotalValue.toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>
            <div className={`d ${unrealizedPnL >= 0 ? 'pos' : ''}`} style={{ color: unrealizedPnL < 0 ? '#E0847A' : undefined }}>
              <TrendingUp size={13} />
              {unrealizedPnL >= 0 ? '+' : ''}${unrealizedPnL.toFixed(0)} unrealized
            </div>
          </div>
          <div className="dash-stat">
            <span className="l">Realized PnL</span>
            <div className="v" style={{ color: (portfolio?.realizedPnL ?? 0) >= 0 ? 'var(--emerald)' : '#E0847A' }}>
              {(portfolio?.realizedPnL ?? 0) >= 0 ? '+' : ''}${(portfolio?.realizedPnL ?? 0).toFixed(0)}
            </div>
            <div className="d">
              <Link href="/dashboard/portfolio">Trade →</Link>
            </div>
          </div>
          <div className="dash-stat">
            <span className="l">BAG Points</span>
            <div className="v">{points?.bagPoints ?? 0}</div>
            <div className="d">
              <Link href="/dashboard/inventory">Spend on boxes →</Link>
            </div>
          </div>
          <div className="dash-stat">
            <span className="l">Genesis Rank</span>
            <div className="v">{leaderboard?.self ? `#${leaderboard.self.rank}` : '—'}</div>
            <div className="d">
              <Link href="/dashboard/leaderboard">View leaderboard →</Link>
            </div>
          </div>
        </div>
      </div>

      <div>
        <span className="section-label">Quick Actions</span>
        <div className="quick-actions">
          <Link href="/dashboard/create" className="qa-btn primary">
            <Plus size={16} />
            Create Bag
          </Link>
          <Link href="/dashboard/explore" className="qa-btn">
            <Plus size={16} />
            Fork Bag
          </Link>
          <Link href="/dashboard/portfolio" className="qa-btn">
            <Wallet2 size={16} />
            Trade
          </Link>
          <Link href="/dashboard/inventory" className="qa-btn">
            <Boxes size={16} />
            Open Boxes
          </Link>
          <Link href="/dashboard/leaderboard" className="qa-btn">
            <Trophy size={16} />
            Leaderboard
          </Link>
          <button className="qa-btn" onClick={handleImportClick}>
            <Upload size={16} />
            Import JSON
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json,.json"
            onChange={handleImportFile}
            style={{ display: 'none' }}
          />
          <Link href="/dashboard/create" className="qa-btn">
            <Send size={16} />
            Publish
          </Link>
        </div>
      </div>

      <div>
        <span className="section-label">My Bags</span>
        {isAuthenticated && myBagsLoading && userBags.length === 0 && (
          <p style={{ color: 'var(--ink-soft)', fontSize: 13.5, marginTop: 12 }}>Loading your bags…</p>
        )}
        {isAuthenticated && myBagsError && (
          <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 10 }}>
            <p style={{ color: '#E0847A', fontSize: 13.5 }}>
              {myBagsErrorMessage ?? 'Could not load your bags.'}
            </p>
            <button className="btn btn-ghost" style={{ padding: '4px 10px', fontSize: 12.5 }} onClick={refreshMyBags}>
              Retry
            </button>
          </div>
        )}
        {allMyBags.length === 0 && !myBagsLoading && (
          <p style={{ color: 'var(--ink-soft)', fontSize: 13.5, marginTop: 12 }}>
            You haven&apos;t created any bags yet — <Link href="/dashboard/create">create your first one</Link>.
          </p>
        )}
        <div className="bag-grid" style={{ marginTop: 0 }}>
          {allMyBags.map((bag, idx) => (
            // "Just Published" only ever distinguishes a real bag from the
            // demo-mode-only appended `mockUserBags` tail — outside demo
            // mode `allMyBags` IS `userBags`, so there is no "old" bag to
            // contrast a "new" one against, and marking every item "new"
            // would be actively misleading.
            <BagCard key={bag.id} bag={bag} isNew={demoMode && idx < userBags.length} />
          ))}
        </div>
      </div>

      <div>
        <span className="section-label">Recent Activity</span>
        <div className="activity-card">
          {activity.length === 0 && (
            <div className="activity-row">
              <span className="activity-dot" />
              <div style={{ flex: 1 }}>
                <p>No activity yet — invest in, fork, or publish a bag to see it here.</p>
              </div>
            </div>
          )}
          {activity.map((item) => (
            <div key={item.id} className="activity-row">
              <span className="activity-dot" />
              <div style={{ flex: 1 }}>
                <p>{item.action}</p>
                <span>{formatRelativeTime(item.timestamp)}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
