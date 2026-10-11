'use client';

import { mockUser, mockUserBags } from '@/lib/mock-data';
import { isDemoModeEnabled } from '@/lib/config/demo-mode';
import { useUserBags } from '@/lib/user-bags-store';
import { useMyBags } from '@/hooks/useMyBags';
import { useActivity, formatRelativeTime } from '@/lib/activity-store';
import { usePortfolio } from '@/lib/portfolio-store';
import { usePositionsTotal } from '@/hooks/usePositionsTotal';
import { formatDecimalStringUsd } from '@/lib/format';
import { Plus, Users, Send, Trophy, Wallet2 } from 'lucide-react';
import Link from 'next/link';
import { BagCard } from '../bags/BagCard';

interface DashboardProps {
  isConnected: boolean;
}

export function Dashboard({ isConnected }: DashboardProps) {
  const { userBags: localBags } = useUserBags();
  const {
    bags: apiBags,
    isLoading: myBagsLoading,
    isError: myBagsError,
    error: myBagsErrorMessage,
    isAuthenticated,
    refresh: refreshMyBags,
  } = useMyBags();
  const { activity } = useActivity();
  const { following } = usePortfolio();
  const positions = usePositionsTotal(isConnected && isAuthenticated);

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

  return (
    <div style={{ paddingTop: 48, display: 'flex', flexDirection: 'column', gap: 48 }}>
      <div>
        <div className="dash-stats">
          <div className="dash-stat">
            <span className="l">Portfolio Value</span>
            <div className="v">
              {positions.status === 'ready' ? `${formatDecimalStringUsd(positions.total)}${positions.complete ? '' : '*'}` : '—'}
            </div>
            <div className="d">
              <Link href="/dashboard/portfolio">{positions.status === 'ready' && !positions.complete ? 'Some prices unavailable →' : 'Your positions →'}</Link>
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
            Portfolio
          </Link>
          <Link href="/dashboard/leaderboard" className="qa-btn">
            <Trophy size={16} />
            Leaderboard
          </Link>
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
