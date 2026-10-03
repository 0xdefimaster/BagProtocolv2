'use client';

import { mockBags, mockUserBags } from '@/lib/mock-data';
import { useUserBags } from '@/lib/user-bags-store';
import { usePortfolio } from '@/lib/portfolio-store';
import { useActivity } from '@/lib/activity-store';
import { useBag } from '@/hooks/useBag';
import { useForkBag } from '@/hooks/useForkBag';
import { bagReturns, formatCompact, formatUsdCompact, formatDecimalStringUsd, formatRawAmount } from '@/lib/format';
import { Bag } from '@/types';
import { use, useState } from 'react';
import {
  TrendingUp,
  ArrowDownLeft,
  Users,
  GitFork,
  Share2,
  Copy,
  Check,
  AlertTriangle,
} from 'lucide-react';
import Link from 'next/link';
import { PurchasePreviewModal } from '@/components/app/PurchasePreviewModal';
import { RedeemPreviewModal } from '@/components/app/RedeemPreviewModal';
import { PerformanceTimeline } from '@/components/bags/PerformanceTimeline';
import { DiversificationScore } from '@/components/bags/DiversificationScore';
import { FollowButton, useIsSelf } from '@/components/creator/FollowButton';
import { Reputation } from '@/components/creator/Reputation';
import { CreatorAvatar } from '@/components/creator/CreatorAvatar';
import { VersionTimeline } from '@/components/bags/VersionTimeline';
import { StrategyPassportView } from '@/components/bags/StrategyPassportView';
import { MyBagPosition } from '@/components/bags/MyBagPosition';
import { DeployBagPanel } from '@/components/bags/DeployBagPanel';
import { StockQuote } from '@/components/bags/StockQuote';
import { useStockQuotes } from '@/hooks/useStockQuotes';

function unroutableLabel(policy: string | undefined): { title: string; detail: string } {
  if (policy === 'HOLD_INPUT') {
    return {
      title: 'Hold as USDG',
      detail: "When an asset has no swap route, its share of a purchase is kept as USDG until it can be bought (up to 30% of the Bag).",
    };
  }
  if (policy === 'REFUND') {
    return {
      title: 'Refund that share',
      detail: 'When an asset has no swap route, the buyer only pays for the assets that can be bought (up to 30% of the Bag).',
    };
  }
  return { title: 'Pause buying', detail: 'When any asset has no swap route, the Bag cannot be bought until liquidity returns.' };
}

function rebalanceLabel(frequency: string): string {
  switch (frequency) {
    case 'MANUAL':
      return 'Manual';
    case 'DAILY':
      return 'Daily';
    case 'WEEKLY':
      return 'Weekly';
    case 'MONTHLY':
      return 'Monthly';
    case 'THRESHOLD_ONLY':
      return 'On drift';
    default:
      return frequency;
  }
}

interface BagDetailPageProps {
  params: Promise<{ id: string }>;
}

// -----------------------------------------------------------------------------
// GET /api/bags/[id] is now the primary source. Mock/localStorage bags
// (demo fixtures + the old Create fallback path) are still resolved
// synchronously so their pages render instantly with no loading flash, but
// they're only ever used when the backend doesn't know about this id
// (never as an override of a real API response) — see the note on
// buildViewState below.
// -----------------------------------------------------------------------------

function buildViewState(
  id: string,
  localBag: Bag | undefined,
  api: ReturnType<typeof useBag>
): { bag: Bag | null; view: 'loading' | 'not_found' | 'error' } {
  if (api.bag) return { bag: api.bag, view: 'loading' }; // view unused when bag is set
  if (api.isNotFound || api.isError) {
    if (localBag) return { bag: localBag, view: 'loading' };
    return { bag: null, view: api.isNotFound ? 'not_found' : 'error' };
  }
  // still loading — render the local fixture instantly if we have one
  if (localBag) return { bag: localBag, view: 'loading' };
  return { bag: null, view: 'loading' };
}

export default function BagDetailPage({ params }: BagDetailPageProps) {
  const { id } = use(params);
  const { userBags } = useUserBags();
  const { following, toggleFollow } = usePortfolio();
  const { addActivity } = useActivity();
  const api = useBag(id);
  const localBag =
    userBags.find((b) => b.id === id) ?? mockUserBags.find((b) => b.id === id) ?? mockBags.find((b) => b.id === id);
  const { bag, view } = buildViewState(id, localBag, api);

  const [activeTab, setActiveTab] = useState('overview');
  const [copied, setCopied] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const [showInvest, setShowInvest] = useState(false);
  const [investInitialAmount, setInvestInitialAmount] = useState<string | undefined>(undefined);
  const [showRedeem, setShowRedeem] = useState(false);
  const { fork, isForking, forkError } = useForkBag();
  const isFollowing = bag ? following.includes(bag.id) : false;
  const isOwnBag = useIsSelf(bag?.creator.address);
  const isRobinhood = bag?.chains.includes('robinhood') ?? false;
  const stockQuotes = useStockQuotes(bag ? bag.composition.map((c) => c.symbol) : [], isRobinhood && activeTab === 'overview');

  if (!bag) {
    if (view === 'not_found') {
      return (
        <main className="min-h-screen bg-black pb-20 flex items-center justify-center">
          <div className="text-center max-w-md px-4">
            <AlertTriangle className="w-10 h-10 text-white/40 mx-auto mb-4" />
            <h1 className="text-2xl font-bold text-white mb-2">Bag not found</h1>
            <p className="text-white/60 mb-6">
              This bag doesn&apos;t exist, was archived, or you don&apos;t have permission to view it.
            </p>
            <Link href="/dashboard/explore" className="text-emerald-400 hover:text-emerald-300 font-medium">
              ← Back to Explore
            </Link>
          </div>
        </main>
      );
    }
    if (view === 'error') {
      return (
        <main className="min-h-screen bg-black pb-20 flex items-center justify-center">
          <div className="text-center max-w-md px-4">
            <AlertTriangle className="w-10 h-10 text-red-400 mx-auto mb-4" />
            <h1 className="text-2xl font-bold text-white mb-2">Couldn&apos;t load this bag</h1>
            <p className="text-white/60 mb-6">{api.error ?? 'Something went wrong. Please try again.'}</p>
            <button
              onClick={api.refresh}
              className="px-5 py-2.5 rounded-lg bg-emerald-500 text-black font-semibold hover:bg-emerald-400 transition-all"
            >
              Retry
            </button>
          </div>
        </main>
      );
    }
    // loading — no local fixture and the API hasn't resolved yet
    return (
      <main className="min-h-screen bg-black pb-20 flex items-center justify-center">
        <p className="text-white/50">Loading bag…</p>
      </main>
    );
  }



  const tabs = ['Overview', 'Passport', 'Thesis', 'Rules', 'Performance', 'History', 'JSON'];

  const copyToClipboard = () => {
    navigator.clipboard.writeText(JSON.stringify(bag, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleShare = () => {
    navigator.clipboard.writeText(window.location.href);
    setLinkCopied(true);
    setTimeout(() => setLinkCopied(false), 2000);
  };

  const handleFollow = () => {
    const nowFollowing = toggleFollow(bag.id);
    addActivity(nowFollowing ? `Started following ${bag.name}` : `Unfollowed ${bag.name}`);
  };

  const handleFork = () => {
    void fork(bag);
  };

  return (
    <>
    <main className="min-h-screen bg-black pb-20">
      {/* Hero Section */}
      <div className="bg-gradient-to-b from-emerald-500/10 to-transparent pt-12 pb-10">
        <div className="mx-auto max-w-7xl px-4">
          <Link
            href="/dashboard/explore"
            className="text-sm text-white/60 hover:text-white transition-colors mb-8 inline-flex"
          >
            ← Back to Bags
          </Link>

          {/* GET /api/bags/[id] already 404s a DRAFT/ARCHIVED bag for anyone but its creator (see that
              route's header comment) — reaching this render with status DRAFT means we ARE the owner,
              so no separate wallet-address comparison is needed (bag.creator.address is a display stub
              here, not necessarily the wallet — see bag-mapper.ts's default CreatorProfile). */}
          {bag.status === 'DRAFT' && (
            <div className="mb-8">
              <DeployBagPanel
                bagId={bag.id}
                bagName={bag.name}
                chain={bag.chains[0] ?? "robinhood"}
                onDeployed={(launchBuyAmount) => {
                  void api.refresh();
                  if (launchBuyAmount) {
                    setInvestInitialAmount(launchBuyAmount);
                    setShowInvest(true);
                  }
                }}
              />
            </div>
          )}

          <div className="grid md:grid-cols-3 gap-8 mb-12">
            {/* Left Column - Bag Info */}
            <div className="md:col-span-2 space-y-6">
              <div>
                <h1 className="text-4xl md:text-5xl font-bold text-white mb-2">
                  {bag.name}
                </h1>
                <p className="text-lg text-white/60">{bag.description}</p>
              </div>

              {/* Creator Info */}
              <div className="flex items-center gap-4 p-4 rounded-xl bg-white/5 border border-white/10">
                <Link
                  href={`/dashboard/creator/${encodeURIComponent(bag.creator.address)}`}
                  className="flex items-center gap-4 flex-1 min-w-0 group"
                >
                  <CreatorAvatar avatarUrl={bag.creator.avatarUrl} fallback={bag.creator.avatar} size={44} />
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold text-white group-hover:text-emerald-400 transition-colors">
                      {bag.creator.name}
                    </p>
                    <p className="text-sm text-white/60 truncate">{bag.creator.address}</p>
                    <div className="mt-1">
                      <Reputation score={bag.creator.creatorScore} />
                    </div>
                  </div>
                </Link>
                <FollowButton creatorId={bag.creator.address} creatorName={bag.creator.name} />
              </div>
            </div>

            {/* Right Column - Stats */}
            <div className="space-y-3">
              <div className="rounded-xl bg-white/5 border border-white/10 p-4">
                <p className="text-xs font-medium text-white/50 uppercase tracking-wider">TVL</p>
                <p className="text-2xl font-bold text-white mt-1">
                  ${formatUsdCompact(bag.tvl)}
                </p>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-xl bg-white/5 border border-white/10 p-4">
                  <p className="text-xs font-medium text-white/50 uppercase tracking-wider">
                    Followers
                  </p>
                  <p className="text-xl font-bold text-white mt-1">
                    {formatCompact(bag.followers)}
                  </p>
                </div>
                <div className="rounded-xl bg-white/5 border border-white/10 p-4">
                  <p className="text-xs font-medium text-white/50 uppercase tracking-wider">
                    Forks
                  </p>
                  <p className="text-xl font-bold text-white mt-1">{bag.forks}</p>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3">
                {(
                  [
                    ['7D', bagReturns(bag).d7],
                    ['30D', bagReturns(bag).d30],
                    ['YTD', bagReturns(bag).ytd],
                  ] as const
                ).map(([label, pct]) => (
                  <div key={label} className="rounded-xl bg-white/5 border border-white/10 p-3">
                    <p className="text-xs font-medium text-white/50 uppercase tracking-wider">{label}</p>
                    {pct === null ? (
                      // Live Bag whose recorded history does not reach back this far yet.
                      <p className="text-lg font-bold mt-1 text-white/40" title="Not enough recorded history yet">—</p>
                    ) : (
                      <p className={`text-lg font-bold mt-1 ${pct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        {pct > 0 ? '+' : ''}
                        {pct.toFixed(1)}%
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* CTA Buttons */}
          <div className="flex flex-wrap gap-3">
            <button
              onClick={() => setShowInvest(true)}
              className="flex items-center gap-2 px-6 py-3 rounded-xl bg-emerald-500 text-black font-semibold transition-all hover:bg-emerald-400"
            >
              <TrendingUp className="w-5 h-5" />
              Invest Now
            </button>
            <button
              onClick={() => setShowRedeem(true)}
              className="flex items-center gap-2 px-6 py-3 rounded-xl bg-white/10 text-white font-semibold border border-white/20 transition-all hover:bg-white/20"
              title="Sell your own holdings in this Bag back to an asset of your choice"
            >
              <ArrowDownLeft className="w-5 h-5" />
              Redeem
            </button>
            <button
              onClick={handleFork}
              disabled={isForking}
              className="flex items-center gap-2 px-6 py-3 rounded-xl bg-white/10 text-white font-semibold border border-white/20 transition-all hover:bg-white/20"
            >
              <GitFork className="w-5 h-5" />
              {isForking ? 'Forking…' : 'Fork Bag'}
            </button>
            {!isOwnBag && (
              <button
                onClick={handleFollow}
                className={`flex items-center gap-2 px-6 py-3 rounded-xl font-semibold border transition-all ${
                  isFollowing
                    ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30 hover:bg-emerald-500/30'
                    : 'bg-white/10 text-white border-white/20 hover:bg-white/20'
                }`}
              >
                <Users className="w-5 h-5" />
                {isFollowing ? 'Following' : 'Follow'}
              </button>
            )}
            <button
              onClick={handleShare}
              className="flex items-center gap-2 px-6 py-3 rounded-xl bg-white/10 text-white font-semibold border border-white/20 transition-all hover:bg-white/20"
            >
              {linkCopied ? <Check className="w-5 h-5" /> : <Share2 className="w-5 h-5" />}
              {linkCopied ? 'Link Copied!' : 'Share'}
            </button>
          </div>
          {forkError && (
            <p role="alert" className="mt-3 text-sm text-amber-300">
              {forkError}
            </p>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="mx-auto max-w-7xl px-4">
        <div className="border-b border-white/10 mb-8">
          <div className="flex overflow-x-auto gap-8 -mb-px">
            {tabs.map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab.toLowerCase())}
                className={`px-1 py-4 font-medium whitespace-nowrap transition-colors border-b-2 ${
                  activeTab === tab.toLowerCase()
                    ? 'text-emerald-400 border-emerald-400'
                    : 'text-white/60 border-transparent hover:text-white'
                }`}
              >
                {tab}
              </button>
            ))}
          </div>
        </div>

        {/* Tab Content */}
        <div className="mb-12">
          {/* Overview opens on what the Bag holds: position, allocation and live breakdown first; the thesis has its own tab. */}
          {activeTab === 'overview' && (
            <div className="space-y-8">
              <DiversificationScore composition={bag.composition} />

              {/* Real position (bag_investor_positions + live NAV); refetched when the TVL changes after a purchase or redemption. */}
              <MyBagPosition bagId={bag.id} refreshKey={bag.tvl} />
              <div className="grid md:grid-cols-2 gap-8">
                <div>
                  <h3 className="text-lg font-bold text-white mb-4">Allocation</h3>
                  <div className="space-y-3">
                    {bag.composition.map((pos) => (
                      <div key={pos.symbol}>
                        <div className="flex justify-between mb-2">
                          <span className="font-medium text-white">{pos.symbol}</span>
                          <span className="text-emerald-400 font-semibold">{pos.weight}%</span>
                        </div>
                        <div className="h-2 bg-white/10 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-gradient-to-r from-emerald-500 to-emerald-400"
                            style={{ width: `${pos.weight}%` }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="rounded-xl border border-white/10 bg-white/5 p-6">
                  <h3 className="text-lg font-bold text-white mb-4">Breakdown</h3>
                  <div className="space-y-2">
                    {bag.composition.map((pos) => {
                      const held = bag.holdings?.find((h) => h.symbol.toUpperCase() === pos.symbol.toUpperCase());
                      const hasQuantity = !!held && BigInt(held.quantityRaw) > BigInt(0);
                      return (
                        <div
                          key={pos.symbol}
                          className="flex justify-between items-start gap-4 text-white/70 py-2 border-b border-white/10 last:border-0"
                        >
                          <span>
                            {pos.symbol} <span className="font-medium">{pos.weight}%</span>
                          </span>
                          {hasQuantity ? (
                            <span className="text-right">
                              {/* What the Bag's whole holding of this asset is worth — rows add up to the TVL. */}
                              <span className="block font-semibold text-white">{held.value !== null ? formatDecimalStringUsd(held.value) : '—'}</span>
                              <span className="block text-xs text-white/50">
                                {formatRawAmount(held.quantityRaw, held.decimals, { maxFractionDigits: 6 })} {pos.symbol}
                                {held.price !== null && <> · {formatDecimalStringUsd(held.price)} per token</>}
                              </span>
                            </span>
                          ) : isRobinhood ? (
                            // Nothing held yet: only the per-token market price is meaningful.
                            <StockQuote quote={stockQuotes.quotes[pos.symbol.toUpperCase()]} error={stockQuotes.errors[pos.symbol.toUpperCase()]} />
                          ) : (
                            <span className="text-xs text-white/40">Not held yet</span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  <p className="mt-3 text-xs text-white/40">
                    {bag.holdings && bag.holdings.some((h) => BigInt(h.quantityRaw) > BigInt(0))
                      ? 'Value = what this Bag holds of each asset × its current price — the same prices as the TVL above. "Per token" is the price of one token.'
                      : isRobinhood
                        ? stockQuotes.failed
                          ? 'Robinhood quotes unavailable right now.'
                          : 'Nothing bought into this Bag yet. Prices shown are per token (bid / ask from Robinhood, refreshed every 15 s).'
                        : 'Nothing bought into this Bag yet.'}
                  </p>
                </div>
              </div>

              {bag.updateLog.length > 0 && (
                <div>
                  <h2 className="text-2xl font-bold text-white mb-4">Update Log</h2>
                  <div className="space-y-3">
                    {bag.updateLog.map((log, idx) => (
                      <div
                        key={idx}
                        className="p-4 rounded-xl border border-white/10 bg-white/5"
                      >
                        <div className="flex justify-between items-start mb-1">
                          <p className="font-semibold text-white">{log.change}</p>
                          <p className="text-xs text-white/60">{log.date}</p>
                        </div>
                        <p className="text-sm text-white/60">{log.reason}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {activeTab === 'thesis' && (
            <div>
              <p className="text-white/70 leading-relaxed text-lg">{bag.thesis}</p>
            </div>
          )}

          {activeTab === 'rules' && (
            <div className="grid md:grid-cols-3 gap-6">
              <div className="rounded-xl border border-white/10 bg-white/5 p-6">
                <p className="text-sm font-medium text-white/50 uppercase tracking-wider">
                  Rebalance
                </p>
                <p className="text-2xl font-bold text-white mt-2">{rebalanceLabel(bag.rules.rebalanceFrequency)}</p>
                {bag.rules.rebalanceFrequency !== 'MANUAL' && (
                  <p className="text-xs text-white/50 mt-2">Target schedule — automatic rebalancing isn&apos;t live yet.</p>
                )}
              </div>
              <div className="rounded-xl border border-white/10 bg-white/5 p-6">
                <p className="text-sm font-medium text-white/50 uppercase tracking-wider">
                  Slippage
                </p>
                <p className="text-2xl font-bold text-white mt-2">{bag.rules.slippage}%</p>
                <p className="text-xs text-white/50 mt-2">Max slippage allowed on each purchase.</p>
              </div>
              <div className="rounded-xl border border-white/10 bg-white/5 p-6">
                <p className="text-sm font-medium text-white/50 uppercase tracking-wider">
                  Min Investment
                </p>
                <p className="text-2xl font-bold text-white mt-2">
                  {bag.rules.minInvestment > 0 ? `$${bag.rules.minInvestment}` : 'None'}
                </p>
              </div>
              <div className="rounded-xl border border-white/10 bg-white/5 p-6 md:col-span-3">
                <p className="text-sm font-medium text-white/50 uppercase tracking-wider">
                  If an asset can&apos;t be bought
                </p>
                <p className="text-2xl font-bold text-white mt-2">{unroutableLabel(bag.rules.unroutablePolicy).title}</p>
                <p className="text-xs text-white/50 mt-2">{unroutableLabel(bag.rules.unroutablePolicy).detail}</p>
              </div>
            </div>
          )}

          {activeTab === 'performance' && <PerformanceTimeline bag={bag} />}

          {activeTab === 'passport' && <StrategyPassportView bagId={bag.id} />}

          {activeTab === 'history' && <VersionTimeline bagId={bag.id} />}

          {activeTab === 'json' && (
            <div className="space-y-4">
              <button
                onClick={copyToClipboard}
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-500/20 text-emerald-300 font-medium border border-emerald-500/30 transition-all hover:bg-emerald-500/30"
              >
                <Copy className="w-4 h-4" />
                {copied ? 'Copied!' : 'Copy to Clipboard'}
              </button>
              <pre className="bg-black border border-white/10 rounded-xl p-6 overflow-auto max-h-96 text-xs text-white/70 font-mono">
                {JSON.stringify(bag, null, 2)}
              </pre>
            </div>
          )}
        </div>

        {/* Supported Chains */}
        <div className="rounded-xl border border-white/10 bg-white/5 p-6">
          <h3 className="text-lg font-bold text-white mb-4">Supported Chains</h3>
          <div className="flex flex-wrap gap-3">
            {bag.chains.map((chain) => (
              <span
                key={chain}
                className="px-4 py-2 rounded-lg bg-white/10 text-white border border-white/20 font-medium"
              >
                {chain}
              </span>
            ))}
          </div>
        </div>
      </div>
    </main>

    {showInvest && (
      <PurchasePreviewModal
        bagId={bag.id}
        bagName={bag.name}
        initialAmount={investInitialAmount}
        autoStart={investInitialAmount !== undefined}
        // Holdings (and so TVL) change once the purchase is accounted for.
        onCompleted={() => void api.refresh()}
        onClose={() => {
          setShowInvest(false);
          setInvestInitialAmount(undefined);
        }}
      />
    )}
    {showRedeem && (
      <RedeemPreviewModal bagId={bag.id} bagName={bag.name} onClose={() => setShowRedeem(false)} />
    )}
    </>
  );
}
