'use client';

import { use } from 'react';
import Link from 'next/link';
import { mockBags, mockUserBags, mockUser } from '@/lib/mock-data';
import { isDemoModeEnabled } from '@/lib/config/demo-mode';
import { usePublicBags } from '@/hooks/usePublicBags';
import { useUserBags } from '@/lib/user-bags-store';
import { useWallet, shortenAddress } from '@/lib/wallet-context';
import { useXConnection } from '@/lib/x-connect-store';
import { getBagsByCreator, getCreatorStats } from '@/lib/creator-utils';
import { formatCompact, formatUsdCompact } from '@/lib/format';
import { Reputation } from '@/components/creator/Reputation';
import { CreatorAvatar } from '@/components/creator/CreatorAvatar';
import { FollowButton } from '@/components/creator/FollowButton';
import { BagCard } from '@/components/bags/BagCard';
import { BadgeCheck, X as XIcon } from 'lucide-react';

interface CreatorPageProps {
  params: Promise<{ address: string }>;
}

export default function CreatorProfilePage({ params }: CreatorPageProps) {
  const { address: rawAddress } = use(params);
  const address = decodeURIComponent(rawAddress);

  const { userBags, hydrated } = useUserBags();
  const { walletAddress, isConnected } = useWallet();
  const { handle: myHandle, isConnected: xConnected } = useXConnection();
  // Production-hardening P1-12 — this page previously only ever looked up
  // a creator's bags from the static `mockBags`/`mockUserBags` fixtures
  // plus THIS browser's own local `userBags` — visiting a real, OTHER
  // creator's profile (anyone who published through the real API, P0-5)
  // showed an empty "hasn't published any Bags yet" regardless of what
  // they'd actually published. `publicBags` (the same real, ACTIVE-bag
  // source Explore/profile use) fixes that; the mock fixtures are now
  // demo-mode-only, same isolation every other screen already applies.
  const demoMode = isDemoModeEnabled();
  const { bags: publicBags } = usePublicBags();

  const isSelf =
    (isConnected && walletAddress === address) || (!isConnected && address === mockUser.address);

  const bags = getBagsByCreator(
    address,
    publicBags,
    hydrated ? userBags : [],
    demoMode ? mockBags : [],
    demoMode ? mockUserBags : []
  );
  const stats = getCreatorStats(address, bags, isSelf ? { name: 'You', avatar: '👤', address, followers: 0, forks: 0 } : undefined);

  const displayHandle = isSelf && xConnected ? myHandle : stats.handle;

  const statCards = [
    { label: 'Total TVL', value: `$${formatUsdCompact(stats.totalTVL)}` },
    { label: 'Bags Published', value: `${stats.bagsPublished}` },
    { label: 'Successful Bags', value: `${stats.successfulBags}/${stats.bagsPublished || 0}` },
    { label: 'Total Followers', value: formatCompact(stats.totalFollowers) },
    { label: 'Total Forks', value: formatCompact(stats.totalForks) },
    {
      label: 'Avg YTD Return',
      value: `${stats.avgPerformanceYtd >= 0 ? '+' : ''}${stats.avgPerformanceYtd.toFixed(1)}%`,
    },
  ];

  return (
    <main className="wrap" style={{ paddingBottom: 80, paddingTop: 44 }}>
      <div className="profile-header">
        <div className="profile-avatar">
          <CreatorAvatar avatarUrl={stats.avatarUrl} fallback={stats.avatar} size={72} />
        </div>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div className="profile-name-row">
            <h2 style={{ margin: 0 }}>{stats.name}</h2>
            {stats.verified && <BadgeCheck size={18} color="var(--gold-lt)" />}
            {displayHandle && (
              <span className="reason-chip" style={{ padding: '4px 10px' }}>
                <XIcon size={11} /> @{displayHandle}
              </span>
            )}
          </div>
          <div className="profile-handle">{shortenAddress(address)}</div>
          <div style={{ marginTop: 10 }}>
            <Reputation score={stats.creatorScore} size="lg" />
          </div>
        </div>

        {isSelf ? (
          <Link href="/dashboard/profile" className="btn btn-ghost">
            Manage your profile
          </Link>
        ) : (
          <FollowButton creatorId={address} creatorName={stats.name} />
        )}
      </div>

      <div className="account-stats-grid">
        {statCards.map((s) => (
          <div className="account-stat" key={s.label}>
            <span className="sl">{s.label}</span>
            <span className="sv">{s.value}</span>
          </div>
        ))}
      </div>

      <div className="profile-section">
        <h3>
          {isSelf ? 'Your Bags' : `Bags by ${stats.name}`}
          {stats.bagsPublished > 0 ? ` (${stats.bagsPublished})` : ''}
        </h3>

        {!hydrated ? (
          <p style={{ color: 'var(--ink-soft)', fontSize: 13.5 }}>Loading…</p>
        ) : bags.length === 0 ? (
          <p style={{ color: 'var(--ink-soft)', fontSize: 13.5 }}>
            {isSelf ? (
              <>
                You haven&apos;t published a Bag yet.{' '}
                <Link href="/dashboard/create" style={{ color: 'var(--gold-lt)' }}>
                  Create your first one →
                </Link>
              </>
            ) : (
              'This creator hasn\u2019t published any Bags yet.'
            )}
          </p>
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
              gap: 16,
            }}
          >
            {bags.map((bag) => (
              <BagCard key={bag.id} bag={bag} />
            ))}
          </div>
        )}
      </div>

      <div style={{ marginTop: 40 }}>
        <Link href="/dashboard/explore" className="btn btn-ghost">
          ← Back to explore
        </Link>
      </div>
    </main>
  );
}
