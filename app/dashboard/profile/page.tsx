'use client';

import { CreatorAvatar } from '@/components/creator/CreatorAvatar';
import { ProfileEditor } from '@/components/profile/ProfileEditor';
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { mockUser, mockBags } from '@/lib/mock-data';
import { isDemoModeEnabled } from '@/lib/config/demo-mode';
import { usePublicBags } from '@/hooks/usePublicBags';
import { useUserBags } from '@/lib/user-bags-store';
import { useMyBags } from '@/hooks/useMyBags';
import { useActivity } from '@/lib/activity-store';
import { useServerActivity } from '@/hooks/useServerActivity';
import { useCreatorFollows } from '@/lib/creator-follow-store';
import { useWallet, shortenAddress } from '@/lib/wallet-context';
import { useXConnection } from '@/lib/x-connect-store';
import { useCreatorRewards } from '@/hooks/useCreatorRewards';
import { bagReturns, formatCompact, formatReturn, formatUsdCompact, formatAge } from '@/lib/format';
import { Reputation } from '@/components/creator/Reputation';
import { ActivityFeed } from '@/components/activity/ActivityFeed';
import { formatRelativeTime } from '@/lib/activity-store';
import { ConnectXModal } from '@/components/creator/ConnectXModal';
import { BagCard } from '@/components/bags/BagCard';
import { Wallet, X as XIcon, Check, LayoutGrid, List as ListIcon } from 'lucide-react';

type BagFilter = 'all' | 'tvl' | 'performance' | 'forks' | 'newest';
type ViewMode = 'grid' | 'list';

const BAG_FILTERS: { id: BagFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'tvl', label: 'Top TVL' },
  { id: 'performance', label: 'Best Performance' },
  { id: 'forks', label: 'Most Forked' },
  { id: 'newest', label: 'Newest' },
];

export default function ProfilePage() {
  const { userBags, hydrated } = useUserBags();
  const { activity: localActivity } = useActivity();
  const { following: followingRaw } = useCreatorFollows();
  const { isConnected, isConnecting, hasProvider, walletAddress, chainName, connect, disconnect, authUser } = useWallet();
  // Real money activity (purchases, redemptions, fees, royalties) from the server, merged with this
  // browser's own local log (create / fork / follow), newest first.
  const serverActivity = useServerActivity(Boolean(authUser));
  const activity = useMemo(
    () => [...serverActivity, ...localActivity].sort((a, b) => b.timestamp - a.timestamp).slice(0, 30),
    [serverActivity, localActivity]
  );
  const { handle, isConnected: xConnected, connectHandle, disconnectHandle } = useXConnection();
  // Production-hardening P1-12 (mock data audit) — same isolation
  // Dashboard.tsx/FeaturedBags.tsx already apply: a real, connected user's
  // OWN profile stats used to unconditionally blend in `mockUser.followers`/
  // `.forks`/`.joinedAt`, and the "Following" section only ever looked up
  // creator info from the static `mockBags` fixture — so following a REAL
  // bag (any bag published since Explore started using real data, P0-5)
  // silently showed no creator chip for it at all. `publicBags` (the same
  // real, ACTIVE-bag source Explore uses) fixes the second part; `demoMode`
  // gates the first.
  const demoMode = isDemoModeEnabled();
  const { bags: publicBags } = usePublicBags();
  const creatorLookupBags = demoMode ? [...publicBags, ...mockBags] : publicBags;
  const { rewards, totalQuote, claimableDisplay, claimableTokenSymbol, isVaultConfigured, isClaiming, claimError, lastClaimTxHash, claim } =
    useCreatorRewards(walletAddress);
  const [showXModal, setShowXModal] = useState(false);
  const [bagFilter, setBagFilter] = useState<BagFilter>('all');
  const [viewMode, setViewMode] = useState<ViewMode>('grid');

  // Nobody follows themselves: an entry for the connected wallet (left over
  // from before self-follow was blocked) is ignored.
  const following = followingRaw.filter((id) => !walletAddress || id.toLowerCase() !== walletAddress.toLowerCase());

  // One chip per followed creator, not one per bag they published.
  const followingLower = new Set(following.map((id) => id.toLowerCase()));
  const followedCreators = Array.from(
    new Map(
      creatorLookupBags
        .filter((b) => followingLower.has(b.creator.address.toLowerCase()))
        .map((b) => [b.creator.address.toLowerCase(), b] as const)
    ).values()
  );

  // Signed in: the server's list (GET /api/bags?mine=1) is the truth — it
  // includes DRAFT bags and forks. Signed out: this browser's local copies.
  const { bags: apiBags, isAuthenticated, isLoading: myBagsLoading, isError: myBagsFailed, error: myBagsError, refresh: refreshMyBags } = useMyBags();
  const myBags = isAuthenticated ? apiBags : hydrated ? userBags.filter((b) => b.creator.name === 'You') : [];

  const sortedBags = [...myBags].sort((a, b) => {
    switch (bagFilter) {
      case 'tvl':
        return b.tvl - a.tvl;
      case 'performance':
        return (bagReturns(b).ytd ?? -Infinity) - (bagReturns(a).ytd ?? -Infinity);
      case 'forks':
        return b.forks - a.forks;
      case 'newest':
        return (b.updateLog?.[b.updateLog.length - 1]?.date ?? '').localeCompare(
          a.updateLog?.[a.updateLog.length - 1]?.date ?? ''
        );
      default:
        return 0;
    }
  });

  const totalTVL = myBags.reduce((sum, b) => sum + b.tvl, 0);
  const totalForksReceived = myBags.reduce((sum, b) => sum + b.forks, 0);
  const successfulBags = myBags.filter((b) => (bagReturns(b).ytd ?? 0) > 0).length;

  const stats = [
    { label: 'Total TVL', value: `$${formatUsdCompact(totalTVL)}` },
    // Followers/joined-date have no real tracking yet — shown only in
    // demo mode; a real connected user sees neither fabricated numbers
    // nor a misleading zero for something genuinely untracked.
    ...(demoMode ? [{ label: 'Followers', value: formatCompact(mockUser.followers) }] : []),
    { label: 'Successful Bags', value: `${successfulBags}/${myBags.length || 0}` },
    { label: 'Forks', value: formatCompact(demoMode ? totalForksReceived + mockUser.forks : totalForksReceived) },
    ...(demoMode ? [{ label: 'Age', value: formatAge(mockUser.joinedAt) }] : []),
  ];

  const selfAddress = isConnected ? walletAddress : mockUser.address;
  const displayAddress = isConnected ? shortenAddress(walletAddress) : mockUser.address;
  // Production-hardening P1-12 — network/followers/reputation below are
  // real for a connected wallet (`chainName` from useWallet()), never
  // `mockUser`'s fabricated values; those only ever show for the
  // disconnected placeholder identity (already labeled "demo address"
  // right below) or explicitly in demo mode.
  const networkLabel = isConnected ? (chainName ?? '—') : mockUser.network;

  // No wallet: there is no profile to show yet. (A placeholder identity and
  // this browser's offline leftovers only confused people.)
  if (!isConnected && !demoMode) {
    return (
      <main className="wrap" style={{ paddingBottom: 80, paddingTop: 44 }}>
        <div className="profile-section" style={{ marginTop: 0, textAlign: 'center', padding: '56px 16px' }}>
          <h2 style={{ marginTop: 0 }}>Your profile</h2>
          <p style={{ color: 'var(--ink-soft)', fontSize: 14, margin: '0 auto 20px', maxWidth: 420 }}>
            Connect your wallet to see your Bags, positions, rewards and activity.
          </p>
          <button className="btn btn-primary" onClick={connect} disabled={isConnecting}>
            <Wallet size={14} /> {isConnecting ? 'Connecting…' : 'Connect Wallet'}
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="wrap" style={{ paddingBottom: 80, paddingTop: 44 }}>
      <div className="profile-header">
        <div className="profile-avatar">
          <CreatorAvatar avatarUrl={isConnected ? authUser?.avatarUrl : null} size={72} />
        </div>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div className="profile-name-row">
            <h2 style={{ margin: 0 }}>{(isConnected && authUser?.displayName) || 'You'}</h2>
            {xConnected && (
              <span className="reason-chip" style={{ padding: '4px 10px' }}>
                <XIcon size={11} /> @{handle}
              </span>
            )}
          </div>
          <div className="profile-handle">
            {displayAddress} &middot; {networkLabel}
            {!isConnected && <span style={{ color: 'var(--mute)' }}> (demo address — connect a real wallet below)</span>}
          </div>
          <div className="profile-follow-counts">
            <span><b>{following.length}</b> Following</span>
            {demoMode && <span><b>{formatCompact(mockUser.followers)}</b> Followers</span>}
            <span><b>{myBags.length}</b> Bags Published</span>
          </div>
          {demoMode && (
            <div style={{ marginTop: 10 }}>
              <Reputation score={mockUser.reputation} size="lg" />
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <Link href={`/dashboard/creator/${encodeURIComponent(selfAddress)}`} className="btn btn-ghost">
            View public profile
          </Link>
          <Link href="/dashboard/create" className="btn btn-primary">
            Create a Bag
          </Link>
        </div>
      </div>

      {isConnected && (
        <div className="profile-section" style={{ marginTop: 0 }}>
          <h3>Edit profile</h3>
          <ProfileEditor key={authUser?.id ?? 'signed-out'} />
        </div>
      )}

      {/* Connected accounts */}
      <div className="profile-section" style={{ marginTop: 0 }}>
        <h3>Connected Accounts</h3>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {isConnected ? (
            <button className="follow-btn following" onClick={disconnect}>
              <Check size={13} />
              {shortenAddress(walletAddress)} · Disconnect
            </button>
          ) : (
            <button className="follow-btn" onClick={connect} disabled={isConnecting}>
              <Wallet size={13} />
              {isConnecting ? 'Connecting…' : hasProvider ? 'Connect Wallet' : 'Install Wallet'}
            </button>
          )}

          {xConnected ? (
            <button className="follow-btn following" onClick={disconnectHandle}>
              <Check size={13} />@{handle} · Disconnect
            </button>
          ) : (
            <button className="follow-btn" onClick={() => setShowXModal(true)}>
              <XIcon size={13} />
              Connect X
            </button>
          )}
        </div>
      </div>

      <div className="account-stats-grid">
        {stats.map((s) => (
          <div className="account-stat" key={s.label}>
            <span className="sl">{s.label}</span>
            <span className="sv">{s.value}</span>
          </div>
        ))}
      </div>

      {(rewards.length > 0 || Number(totalQuote) > 0) && (
        <div className="profile-section" style={{ marginTop: 24 }}>
          <h3>Creator Rewards</h3>
          <div className="account-stats-grid" style={{ marginBottom: rewards.length > 0 ? 14 : 0 }}>
            <div className="account-stat">
              <span className="sl">Total Earned</span>
              <span className="sv">${Number(totalQuote).toFixed(2)}</span>
            </div>
            <div className="account-stat">
              <span className="sl">Fork Royalties</span>
              <span className="sv">{rewards.filter((r) => r.type === 'FORK_ROYALTY').length}</span>
            </div>
            <div className="account-stat">
              <span className="sl">Performance Fees</span>
              <span className="sv">{rewards.filter((r) => r.type === 'PERFORMANCE_FEE').length}</span>
            </div>
          </div>
          <p style={{ color: 'var(--ink-soft)', fontSize: 12.5, marginBottom: rewards.length > 0 ? 14 : 0 }}>
            Credited to your paper trading balance (below) — a real, tracked ledger balance, not yet an on-chain
            payout.
          </p>
          {isVaultConfigured && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
                padding: '10px 12px',
                borderRadius: 10,
                background: 'var(--surface-2, rgba(255,255,255,0.04))',
                marginBottom: rewards.length > 0 ? 14 : 0,
              }}
            >
              <div>
                <div style={{ fontSize: 11.5, color: 'var(--ink-soft)' }}>Claimable on-chain (Robinhood Chain)</div>
                <div style={{ fontSize: 15, fontWeight: 600 }}>
                  {claimableDisplay !== null ? `${claimableDisplay} ${claimableTokenSymbol}` : '—'}
                </div>
              </div>
              <button
                type="button"
                className="btn-primary"
                disabled={isClaiming || !claimableDisplay || Number(claimableDisplay) <= 0 || !isConnected}
                onClick={() => claim()}
              >
                {isClaiming ? 'Claiming…' : 'Claim'}
              </button>
            </div>
          )}
          {claimError && (
            <p style={{ color: 'var(--danger, #e5484d)', fontSize: 12.5, marginBottom: 8 }}>{claimError}</p>
          )}
          {lastClaimTxHash && (
            <p style={{ color: 'var(--ink-soft)', fontSize: 12, marginBottom: 8 }}>
              Claimed — tx {lastClaimTxHash.slice(0, 10)}…
            </p>
          )}
          {rewards.length > 0 && (
            <div className="activity-feed">
              {rewards.slice(0, 10).map((r) => (
                <div className="activity-row" key={r.id}>
                  <span className="activity-dot">{r.type === 'FORK_ROYALTY' ? '🌱' : '📈'}</span>
                  <div className="activity-text">
                    {r.type === 'FORK_ROYALTY' ? 'Fork royalty' : 'Performance fee'} — ${Number(r.amountQuote).toFixed(2)}
                  </div>
                  <div className="activity-time">{formatRelativeTime(new Date(r.createdAt).getTime())}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="profile-section" id="my-bags">
        <div className="bags-section-head">
          <h3 style={{ marginBottom: 0 }}>
            Created Bags{myBags.length > 0 ? ` (${myBags.length})` : ''}
          </h3>

          {myBags.length > 0 && (
            <div className="bags-controls">
              <div className="bags-filter-bar">
                {BAG_FILTERS.map((f) => (
                  <button
                    key={f.id}
                    className={`filter-pill ${bagFilter === f.id ? 'active' : ''}`}
                    onClick={() => setBagFilter(f.id)}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
              <div className="view-toggle">
                <button
                  className={viewMode === 'grid' ? 'active' : ''}
                  onClick={() => setViewMode('grid')}
                  aria-label="Grid view"
                  title="Grid view"
                >
                  <LayoutGrid size={15} />
                </button>
                <button
                  className={viewMode === 'list' ? 'active' : ''}
                  onClick={() => setViewMode('list')}
                  aria-label="List view"
                  title="List view"
                >
                  <ListIcon size={15} />
                </button>
              </div>
            </div>
          )}
        </div>

        {myBagsFailed ? (
          <p style={{ color: '#E0847A', fontSize: 13.5 }}>
            Could not load your bags: {myBagsError}{' '}
            <button onClick={refreshMyBags} style={{ background: 'none', border: 'none', color: 'inherit', textDecoration: 'underline', cursor: 'pointer' }}>
              Retry
            </button>
          </p>
        ) : myBagsLoading && myBags.length === 0 ? (
          <p style={{ color: 'var(--ink-soft)', fontSize: 13.5 }}>Loading your bags…</p>
        ) : myBags.length === 0 ? (
          <p style={{ color: 'var(--ink-soft)', fontSize: 13.5 }}>
            You haven&apos;t published a Bag yet.{' '}
            <Link href="/dashboard/create" style={{ color: 'var(--gold-lt)' }}>
              Create your first one →
            </Link>
          </p>
        ) : viewMode === 'grid' ? (
          <div className="bags-grid">
            {sortedBags.map((b) => (
              <BagCard key={b.id} bag={b} />
            ))}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {sortedBags.map((b) => (
              <Link
                key={b.id}
                href={`/dashboard/bag/${b.id}`}
                className="alloc-row"
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', textDecoration: 'none' }}
              >
                <span style={{ color: 'var(--ink)', fontWeight: 600 }}>{b.name}</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
                  <span className="mono" style={{ fontSize: 12, color: 'var(--mute)' }}>
                    ${formatUsdCompact(b.tvl)} TVL
                  </span>
                  <span className="mono" style={{ fontSize: 12, color: 'var(--mute)' }}>
                    {formatCompact(b.forks)} forks
                  </span>
                  <span
                    className="mono"
                    style={{ fontSize: 12.5, color: (bagReturns(b).ytd ?? 0) >= 0 ? 'var(--emerald)' : '#E0847A' }}
                  >
                    {formatReturn(bagReturns(b).ytd)} YTD
                  </span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>

      <div className="profile-section">
        <h3>Following</h3>
        {following.length === 0 ? (
          <p style={{ color: 'var(--ink-soft)', fontSize: 13.5 }}>
            You&apos;re not following any creators yet — follow one from a Bag page to see updates here.
          </p>
        ) : (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {followedCreators.map((b) => (
                <Link
                  key={b.creator.address}
                  href={`/dashboard/creator/${encodeURIComponent(b.creator.address)}`}
                  className="reason-chip creator-link"
                  style={{ textDecoration: 'none' }}
                >
                  {b.creator.avatar} {b.creator.name}
                </Link>
              ))}
          </div>
        )}
      </div>

      <div className="profile-section">
        <h3>Activity</h3>
        <ActivityFeed items={activity} emptyMessage="No activity yet." />
      </div>

      <div style={{ marginTop: 40 }}>
        <Link href="/dashboard" className="btn btn-ghost">
          ← Back to dashboard
        </Link>
      </div>

      {showXModal && (
        <ConnectXModal
          onConfirm={(h) => {
            connectHandle(h);
            setShowXModal(false);
          }}
          onClose={() => setShowXModal(false)}
        />
      )}
    </main>
  );
}
