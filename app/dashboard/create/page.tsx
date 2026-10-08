'use client';

import { fetchRegistryAssetsForChain } from '@/lib/registry-assets-client';
import { formatUSD, type Asset } from '@/lib/create-assets-data';
import { AssetSelector } from '@/components/create/AssetSelector';
import { AllocationEditor } from '@/components/create/AllocationEditor';
import { NetworkSelector } from '@/components/create/NetworkSelector';
import { useActivity } from '@/lib/activity-store';
import { useNotifications } from '@/lib/notifications-store';
import { useWallet } from '@/lib/wallet-context';
import { NETWORKS } from '@/lib/constants';
import { Bag } from '@/types';
import { MAX_PERFORMANCE_FEE_BPS, MAX_UNROUTABLE_WEIGHT_BPS, UNROUTABLE_POLICIES, type UnroutablePolicy } from '@/types/basket-protocol';
import { ArrowRight, Save, Check } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { AssetIcon } from '@/components/create/AssetIcon';
import { DeployBagPanel } from '@/components/bags/DeployBagPanel';
import { PurchasePreviewModal } from '@/components/app/PurchasePreviewModal';

const INVEST_PRESETS = ['0', '10', '100', '500', '1000'];
const ETH_INVEST_PRESETS = ['0', '0.01', '0.05', '0.1', '0.5'];

// Proportionally shrinks/grows the other allocations so the total always stays at 100.
function rebalance(
  ids: string[],
  current: Record<string, number>,
  changedId: string,
  rawValue: number
): Record<string, number> {
  const newValue = Math.max(0, Math.min(100, Math.round(rawValue) || 0));
  const others = ids.filter(id => id !== changedId);
  const next: Record<string, number> = { ...current, [changedId]: newValue };

  if (others.length === 0) {
    next[changedId] = 100;
    return next;
  }

  const oldOthersTotal = others.reduce((s, id) => s + (current[id] || 0), 0);
  const targetOthersTotal = 100 - newValue;

  if (targetOthersTotal <= 0) {
    others.forEach(id => (next[id] = 0));
  } else if (oldOthersTotal <= 0) {
    const equal = Math.floor(targetOthersTotal / others.length);
    let remainder = targetOthersTotal - equal * others.length;
    others.forEach(id => {
      next[id] = equal + (remainder > 0 ? 1 : 0);
      if (remainder > 0) remainder--;
    });
  } else {
    let allocatedSoFar = 0;
    others.forEach((id, idx) => {
      const share = (current[id] || 0) / oldOthersTotal;
      const val =
        idx === others.length - 1
          ? Math.max(0, targetOthersTotal - allocatedSoFar)
          : Math.max(0, Math.round(share * targetOthersTotal));
      next[id] = val;
      allocatedSoFar += val;
    });
  }

  return next;
}

export default function CreatePage() {
  const router = useRouter();
  const { addActivity } = useActivity();
  const { addNotification } = useNotifications();
  const { signIn, connect, isConnected, isSigningIn, authError } = useWallet();
  const [bagName, setBagName] = useState('');
  const [description, setDescription] = useState('');
  const [thesis, setThesis] = useState('');
  const [selectedAssetIds, setSelectedAssetIds] = useState<string[]>([]);
  const [allocations, setAllocations] = useState<Record<string, number>>({});
  // The creator's own launch buy: 0 creates the bag on-chain without buying;
  // anything above buys into it right after the deploy (pump.fun style).
  const [investmentAmount, setInvestmentAmount] = useState('0');
  const [launchPayment, setLaunchPayment] = useState<'settlement' | 'native'>('settlement');
  // Set once the draft exists: the deploy (and launch buy) then happen right
  // here, pump.fun-style, and only the finished bag's page is opened after.
  const [launch, setLaunch] = useState<{ bagId: string; name: string; buy?: string; buying: boolean; payment: 'settlement' | 'native' } | null>(null);
  // Production-hardening P0-1 — SINGLE-CHAIN network model. A Bag lives on
  // exactly one chain everywhere else in this codebase (`BasketRecipe.chain`,
  // `ExecutionPlan`, `BagExecutionGraph.chainId`); this used to be a
  // `string[]` toggled by a multi-select `NetworkSelector`, but only
  // `selectedNetworkIds[0]` was ever read anywhere downstream — the rest of
  // the toggled chips did nothing except misrepresent the Bag as
  // multi-chain on the Review step. Now a single value, matching what
  // `NetworkSelector`/`handlePublish` actually do with it.
  const [selectedNetworkId, setSelectedNetworkId] = useState<string>('ethereum');
  // Surfaces the "Network changed. Your asset selections were cleared."
  // notice below the selector for a few seconds — cleared automatically so
  // it doesn't linger once the person has moved on.
  const [networkChangeNotice, setNetworkChangeNotice] = useState(false);
  // Phase 22 — basis points of realized profit paid to this bag's creator
  // on redemption (types/basket-protocol.ts's Phase 22 doc block). Default
  // 0 = no fee, which is a fully valid choice, not a placeholder — the
  // creator opts INTO a fee, never has one silently applied.
  const [performanceFeeBps, setPerformanceFeeBps] = useState(0);
  // Bag rules chosen by the creator. Rebalancing is not automated yet, so the
  // default is honest ("Manual"); slippage and minimum are enforced on purchase.
  const [rebalanceChoice, setRebalanceChoice] = useState<'Manual' | 'Weekly' | 'Monthly' | 'Drift'>('Manual');
  const [slippageBps, setSlippageBps] = useState(100);
  // What a purchase does when an asset has no swap route (UNROUTABLE_POLICIES).
  // When the liquidity check flags an asset, the creator must pick explicitly.
  const [unroutablePolicy, setUnroutablePolicy] = useState<UnroutablePolicy>('BLOCK');
  const [unroutablePolicyChosen, setUnroutablePolicyChosen] = useState(false);
  const chooseUnroutablePolicy = (policy: UnroutablePolicy) => {
    setUnroutablePolicy(policy);
    setUnroutablePolicyChosen(true);
  };
  const [minInvestment, setMinInvestment] = useState(0);
  const [currentStep, setCurrentStep] = useState<'basic' | 'assets' | 'allocation' | 'review'>('basic');
  const [isPublishing, setIsPublishing] = useState(false);
  // Deploying is the only way to publish: the button saves the draft and goes
  // straight to the on-chain deploy (which charges the creation fee), with an
  // optional launch buy right after.
  const [creationFeeWei, setCreationFeeWei] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setCreationFeeWei(null);
    fetch(`/api/deploy/creation-fee?chain=${encodeURIComponent(selectedNetworkId)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (!cancelled && body && typeof body.amountWei === 'string') setCreationFeeWei(body.amountWei);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [selectedNetworkId]);
  const [publishError, setPublishError] = useState<string[] | null>(null);

  // Production-hardening P0-2 — ASSET REGISTRY IS THE ONLY SOURCE OF TRUTH.
  // Real, registry-backed assets for the ONE selected network. Previously
  // fell back to the static demo catalog (`cryptoAssets`/`stockAssets`,
  // lib/create-assets-data.ts) whenever the registry came back empty for a
  // type — that catalog carries fabricated prices and includes assets
  // (BTC chief among them) that have no real deployment on ANY chain this
  // app supports at all (see coingecko-import.ts's own doc: BTC/SOL/DOGE
  // are correctly SKIPPED by the importer, never faked as a "wrapped"
  // stand-in). Falling back to it meant a creator could select BTC, get all
  // the way to Publish, and only then hit a confusing `INVALID_ADDRESS` /
  // `ASSET_CHAIN_MISMATCH` rejection. Now: registry result only, and an
  // explicit empty state ("No verified assets are currently available on
  // this network") when it has nothing — never a silent switch to fake data.
  //
  // Refetches whenever the selected network changes: a coin or stock's
  // contract address is chain-specific (coingecko-import.ts /
  // robinhood-import.ts each write one chain's deployment per run), so
  // "registry has USDC" on Ethereum says nothing about whether it has USDC
  // on Base — this must re-ask per chain, not just once on mount.
  const [registryAssets, setRegistryAssets] = useState<Asset[]>([]);
  const [registryAssetsLoading, setRegistryAssetsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setRegistryAssetsLoading(true);
    fetchRegistryAssetsForChain(selectedNetworkId)
      .then((assets) => {
        if (!cancelled) setRegistryAssets(assets);
      })
      .finally(() => {
        if (!cancelled) setRegistryAssetsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedNetworkId]);

  const assetPool = registryAssets;

  // Switching the network invalidates every asset selection made against
  // the PREVIOUS chain's registry — a composition chosen against Ethereum's
  // verified assets must never end up submitted against Base's. Clears both
  // the selection and its allocations together (an orphaned allocation for
  // an id that no longer exists would just silently vanish from
  // `totalAllocation` anyway) and tells the person plainly what happened,
  // rather than discarding their work with no explanation.
  const handleNetworkChange = (networkId: string) => {
    if (networkId === selectedNetworkId) return;
    setSelectedNetworkId(networkId);
    if (networkId !== 'ethereum') setLaunchPayment('settlement');
    if (selectedAssetIds.length > 0) {
      setSelectedAssetIds([]);
      setAllocations({});
      setNetworkChangeNotice(true);
    }
  };

  useEffect(() => {
    if (!networkChangeNotice) return;
    const t = setTimeout(() => setNetworkChangeNotice(false), 6000);
    return () => clearTimeout(t);
  }, [networkChangeNotice]);

  const selectedAssets = selectedAssetIds
    .map(id => assetPool.find(a => a.id === id))
    .filter(Boolean)
    .sort((a, b) => a!.symbol.localeCompare(b!.symbol));

  // Liquidity warnings: probe each selected registry asset once per chain
  // (server caches too). Warn-only — liquidity comes and goes, so this
  // never blocks publishing.
  const [routeStatus, setRouteStatus] = useState<Record<string, 'ROUTABLE' | 'NO_ROUTE' | 'UNKNOWN'>>({});
  useEffect(() => setRouteStatus({}), [selectedNetworkId]);
  const selectedAddressKey = selectedAssets
    .map((a) => a!.address?.toLowerCase())
    .filter((a): a is string => !!a)
    .sort()
    .join(',');
  useEffect(() => {
    const missing = selectedAddressKey.split(',').filter((a) => a && !(a in routeStatus));
    if (missing.length === 0) return;
    let cancelled = false;
    fetch(`/api/assets/routes?chain=${encodeURIComponent(selectedNetworkId)}&addresses=${missing.slice(0, 25).join(',')}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (!cancelled && body?.routes) setRouteStatus((prev) => ({ ...prev, ...body.routes }));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // routeStatus is intentionally left out: it only filters what's already known.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAddressKey, selectedNetworkId]);
  const noRouteAssets = selectedAssets.filter((a) => a!.address && routeStatus[a!.address.toLowerCase()] === 'NO_ROUTE');
  const noRouteAssetIds = new Set(noRouteAssets.map((a) => a!.id));

  const totalAllocation = selectedAssetIds.reduce((sum, id) => sum + (allocations[id] || 0), 0);
  const isValid = totalAllocation === 100 && selectedAssetIds.length > 0;

  const steps = [
    { key: 'basic', label: 'Bag Info', disabled: false },
    { key: 'assets', label: 'Select Assets', disabled: !bagName },
    { key: 'allocation', label: 'Allocate', disabled: selectedAssetIds.length === 0 },
    { key: 'review', label: 'Review', disabled: !isValid },
  ] as const;

  const equalize = (ids: string[]) => {
    if (ids.length === 0) return {};
    const equal = Math.floor(100 / ids.length);
    const remainder = 100 % ids.length;
    const next: Record<string, number> = {};
    ids.forEach((id, i) => (next[id] = equal + (i === 0 ? remainder : 0)));
    return next;
  };

  const handleSelectAsset = (assetId: string) => {
    if (selectedAssetIds.includes(assetId)) return;
    const newIds = [...selectedAssetIds, assetId];
    setSelectedAssetIds(newIds);
    setAllocations(equalize(newIds));
  };

  const handleDeselectAsset = (assetId: string) => {
    const newIds = selectedAssetIds.filter(id => id !== assetId);
    setSelectedAssetIds(newIds);
    setAllocations(equalize(newIds));
  };

  const handleAllocationChange = (assetId: string, value: number) => {
    setAllocations(prev => rebalance(selectedAssetIds, prev, assetId, value));
  };

  const handleAutoBalance = () => setAllocations(equalize(selectedAssetIds));

  // POST /api/bags is the only way a Bag is created: it needs a signed-in
  // wallet and lands in the database as DRAFT until deployed on-chain.
  const launchBuy = investmentAmount.trim() !== '' && Number(investmentAmount) > 0;

  const handlePublish = async () => {
    if (!isValid) return;
    setIsPublishing(true);
    setPublishError(null);

    const composition = selectedAssets.map((asset) => ({
      symbol: asset!.symbol,
      weight: allocations[asset!.id] || 0,
    }));

    try {
      const res = await fetch('/api/bags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          name: bagName,
          description,
          thesis,
          chain: selectedNetworkId,
          composition,
          // The "how much do you want to invest" amount above is only a
          // preview — it is NOT the Bag's minimum for other investors.
          minInvestment,
          rebalanceFrequency: rebalanceChoice,
          slippageBps,
          unroutablePolicy,
          performanceFeeBps,
        }),
      });

      // A real, structured validation failure from the domain layer
      // (validateBasketRecipe via createBag) — e.g. an unsupported asset,
      // weights that don't sum to 100%, or a duplicate. This is
      // authoritative and must NOT be papered over with a local fallback
      // bag: doing so would show the creator a "published!" success state
      // for a bag that was, in fact, rejected.
      if (res.status === 422) {
        const body = (await res.json().catch(() => null)) as
          | { error: string; issues?: { message: string; severity: 'ERROR' | 'WARNING' }[] }
          | null;
        const messages = (body?.issues ?? [])
          .filter((i) => i.severity === 'ERROR')
          .map((i) => i.message);
        setPublishError(messages.length > 0 ? messages : [body?.error ?? 'Recipe validation failed.']);
        setIsPublishing(false);
        return;
      }

      // Not signed in (or the session expired): a Bag must belong to a
      // verified wallet, so ask for the signature instead of pretending.
      if (res.status === 401) {
        setIsPublishing(false);
        // signIn() needs a connected wallet; without one it would fail
        // silently, so open the wallet connection instead.
        if (!isConnected) {
          setPublishError(['Connect your wallet, sign the request, then press Deploy again.']);
          void connect();
        } else {
          setPublishError(['Sign in with your wallet first — approve the signature request, then press Deploy again.']);
          void signIn();
        }
        return;
      }

      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `The server responded ${res.status}.`);
      }
      const { bag } = (await res.json()) as { bag: Bag };

      // The draft is private until deployed. The deploy wallet prompt
      // (creation fee included) opens right here — publishing IS deploying —
      // and the launch buy follows on this same screen once the deploy is
      // verified. Only then does the creator land on the bag page. If they
      // reject, the deploy panel below stays here to retry.
      addActivity(`Created bag: ${bag.name}`);
      setLaunch({ bagId: bag.id, name: bag.name, buy: launchBuy ? investmentAmount : undefined, buying: false, payment: launchBuy ? launchPayment : 'settlement' });
    } catch (err) {
      // No local "saved on this device" copy any more: it never reached
      // Explore or Portfolio, showed a made-up TVL and let the creator follow
      // themselves. The creator keeps everything they entered and can retry.
      setPublishError([
        `Could not create the Bag: ${err instanceof Error ? err.message : 'network error'} Your selections are kept — try again.`,
      ]);
      setIsPublishing(false);
    }
  };

  return (
    <main className="wrap" style={{ paddingBottom: 80 }}>
      <div className="create-header">
        <Link href="/dashboard" className="create-back">← Back to Dashboard</Link>
        <h1>Create a Bag</h1>
        <p className="lead">Build your custom investment portfolio</p>
      </div>

      <div className="step-nav">
        {steps.map((step) => (
          <button
            key={step.key}
            className={`step-btn ${currentStep === step.key ? 'active' : ''}`}
            disabled={step.disabled}
            onClick={() => !step.disabled && setCurrentStep(step.key)}
          >
            {step.label}
          </button>
        ))}
      </div>

      <div className="create-grid">
        <div>
          {currentStep === 'basic' && (
            <div className="create-card">
              <div className="field">
                <label>Bag Name *</label>
                <input
                  type="text"
                  placeholder="e.g., AI Leaders, L2 Ecosystem, etc."
                  value={bagName}
                  onChange={(e) => setBagName(e.target.value)}
                />
              </div>
              <div className="field">
                <label>Description</label>
                <textarea
                  placeholder="What does this bag contain? What's the theme?"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={3}
                />
              </div>
              <div className="field">
                <label>Thesis (Why This Bag?)</label>
                <textarea
                  placeholder="Explain your investment thesis and reasoning..."
                  value={thesis}
                  onChange={(e) => setThesis(e.target.value)}
                  rows={4}
                />
              </div>
              <div className="field">
                <label>Deploy On</label>
                <NetworkSelector selected={selectedNetworkId} onChange={handleNetworkChange} />
                {networkChangeNotice && (
                  <div
                    role="status"
                    style={{
                      marginTop: 10,
                      fontSize: 13,
                      color: 'var(--ink-soft)',
                      padding: '8px 12px',
                      borderRadius: 8,
                      background: 'rgba(255,255,255,0.04)',
                    }}
                  >
                    Network changed. Your asset selections were cleared.
                  </div>
                )}
              </div>
              <div className="create-actions">
                <button className="btn btn-primary" disabled={!bagName} onClick={() => setCurrentStep('assets')}>
                  Next: Select Assets <ArrowRight size={17} />
                </button>
              </div>
            </div>
          )}

          {currentStep === 'assets' && (
            <div className="create-card">
              <AssetSelector
                assets={assetPool}
                selectedIds={selectedAssetIds}
                onSelect={handleSelectAsset}
                onDeselect={handleDeselectAsset}
                loadingRegistryAssets={registryAssetsLoading}
              />
              <div className="create-actions">
                <button className="btn btn-ghost back" onClick={() => setCurrentStep('basic')}>Back</button>
                <button className="btn btn-primary" disabled={selectedAssetIds.length === 0} onClick={() => setCurrentStep('allocation')}>
                  Next: Allocate <ArrowRight size={17} />
                </button>
              </div>
            </div>
          )}

          {currentStep === 'allocation' && (
            <div className="create-card">
              <div className="invest-box">
                <span className="lbl">How much do you want to buy at launch?</span>
                <div className="nm" style={{ marginBottom: 8 }}>
                  {launchPayment === 'native' && selectedNetworkId === 'ethereum'
                    ? 'Enter the ETH amount. $0 / 0 ETH just creates the bag on-chain.'
                    : '$0 just creates the bag on-chain. Any amount buys into it right after it&apos;s deployed.'}
                </div>

                {selectedNetworkId === 'ethereum' && (
                  <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                    <button
                      type="button"
                      className={`invest-preset ${launchPayment === 'settlement' ? 'active' : ''}`}
                      onClick={() => {
                        setLaunchPayment('settlement');
                        setInvestmentAmount((current) => ETH_INVEST_PRESETS.includes(current) ? '100' : current);
                      }}
                    >
                      USDC
                    </button>
                    <button
                      type="button"
                      className={`invest-preset ${launchPayment === 'native' ? 'active' : ''}`}
                      onClick={() => {
                        setLaunchPayment('native');
                        setInvestmentAmount((current) =>
                          current === '0' || INVEST_PRESETS.includes(current) ? '0.05' : current
                        );
                      }}
                    >
                      ETH
                    </button>
                  </div>
                )}

                <div className="invest-input-row">
                  <span className="dollar">{launchPayment === 'native' && selectedNetworkId === 'ethereum' ? 'Ξ' : '$'}</span>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={investmentAmount}
                    onChange={(e) => setInvestmentAmount(e.target.value.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1'))}
                  />
                </div>

                <div className="invest-presets">
                  {(launchPayment === 'native' && selectedNetworkId === 'ethereum' ? ETH_INVEST_PRESETS : INVEST_PRESETS).map((amt) => (
                    <button
                      key={amt}
                      className={`invest-preset ${investmentAmount === amt ? 'active' : ''}`}
                      onClick={() => setInvestmentAmount(amt)}
                    >
                      {amt === '0'
                        ? 'Just create'
                        : launchPayment === 'native' && selectedNetworkId === 'ethereum'
                          ? `${amt} ETH`
                          : formatUSD(Number(amt))}
                    </button>
                  ))}
                </div>
              </div>

              <div className="invest-box" style={{ marginTop: 18 }}>
                <span className="lbl">Creator performance fee (optional)</span>
                <div className="nm" style={{ marginTop: 4, marginBottom: 12, lineHeight: 1.5 }}>
                  Charged only on REALIZED profit when an investor redeems — never on their principal,
                  and never if their position is at a loss. 0% is a fully valid choice. You can change it in a
                  later version until the first outside investor buys in; from then on it is locked for good.
                </div>
                <div className="alloc-slider-row">
                  <input
                    type="range"
                    min={0}
                    max={MAX_PERFORMANCE_FEE_BPS / 100}
                    step={0.5}
                    value={performanceFeeBps / 100}
                    onChange={(e) => setPerformanceFeeBps(Math.round(parseFloat(e.target.value || '0') * 100))}
                    className="alloc-slider"
                  />
                  <input
                    type="number"
                    min={0}
                    max={MAX_PERFORMANCE_FEE_BPS / 100}
                    step={0.5}
                    value={performanceFeeBps / 100}
                    onChange={(e) =>
                      setPerformanceFeeBps(
                        Math.max(0, Math.min(MAX_PERFORMANCE_FEE_BPS, Math.round(parseFloat(e.target.value || '0') * 100)))
                      )
                    }
                    className="alloc-num"
                  />
                  <span className="nm" style={{ marginLeft: -4 }}>%</span>
                </div>
              </div>

              <div className="invest-box" style={{ marginTop: 18 }}>
                <span className="lbl">Bag rules</span>

                <div className="nm" style={{ marginTop: 10, marginBottom: 6 }}>Rebalance</div>
                <div className="invest-presets">
                  {(['Manual', 'Weekly', 'Monthly', 'Drift'] as const).map((opt) => (
                    <button
                      key={opt}
                      type="button"
                      className={`invest-preset ${rebalanceChoice === opt ? 'active' : ''}`}
                      onClick={() => setRebalanceChoice(opt)}
                    >
                      {opt === 'Drift' ? 'When drift ≥ 5%' : opt}
                    </button>
                  ))}
                </div>
                <div className="nm" style={{ marginTop: 6, lineHeight: 1.5 }}>
                  Automatic rebalancing isn&apos;t live yet — this records your intended schedule; you update the Bag
                  yourself by publishing a new version.
                </div>

                <div className="nm" style={{ marginTop: 14, marginBottom: 6 }}>Max slippage per purchase</div>
                <div className="invest-presets">
                  {[50, 100, 200, 300].map((bps) => (
                    <button
                      key={bps}
                      type="button"
                      className={`invest-preset ${slippageBps === bps ? 'active' : ''}`}
                      onClick={() => setSlippageBps(bps)}
                    >
                      {bps / 100}%
                    </button>
                  ))}
                </div>

                <div className="nm" style={{ marginTop: 14, marginBottom: 6 }}>If an asset can&apos;t be bought (no liquidity)</div>
                <UnroutablePolicyPicker value={unroutablePolicy} onChange={chooseUnroutablePolicy} />

                <div className="nm" style={{ marginTop: 14, marginBottom: 6 }}>Minimum investment (USD, 0 = none)</div>
                <div className="invest-input-row">
                  <span className="dollar">$</span>
                  <input
                    type="number"
                    min={0}
                    value={minInvestment}
                    onChange={(e) => setMinInvestment(Math.max(0, Number(e.target.value) || 0))}
                  />
                </div>
              </div>

              <AllocationEditor
                assetPool={assetPool}
                assetIds={selectedAssetIds}
                allocations={allocations}
                investmentAmount={Number(investmentAmount) || 0}
                investmentCurrency={launchPayment === 'native' && selectedNetworkId === 'ethereum' ? 'ETH' : 'USD'}
                onAllocationChange={handleAllocationChange}
                onAutoBalance={handleAutoBalance}
                noRouteAssetIds={noRouteAssetIds}
              />

              <div className="create-actions">
                <button className="btn btn-ghost back" onClick={() => setCurrentStep('assets')}>Back</button>
                <button className="btn btn-primary" disabled={!isValid} onClick={() => setCurrentStep('review')}>
                  Review <ArrowRight size={17} />
                </button>
              </div>
            </div>
          )}

          {currentStep === 'review' && (
            <div className="create-card">
              <span className="section-label">Bag Details</span>
              <div className="alloc-row" style={{ marginBottom: 22 }}>
                <div className="nm" style={{ marginBottom: 4 }}>NAME</div>
                <div style={{ color: 'var(--ink)', fontWeight: 600, marginBottom: description || thesis ? 12 : 0 }}>{bagName}</div>
                {description && (
                  <>
                    <div className="nm" style={{ marginBottom: 4 }}>DESCRIPTION</div>
                    <div style={{ color: 'var(--ink-soft)', fontSize: 13.5, marginBottom: thesis ? 12 : 0 }}>{description}</div>
                  </>
                )}
                {thesis && (
                  <>
                    <div className="nm" style={{ marginBottom: 4 }}>THESIS</div>
                    <div style={{ color: 'var(--ink-soft)', fontSize: 13.5 }}>{thesis}</div>
                  </>
                )}
              </div>

              <span className="section-label">Strategy</span>
              <div style={{ marginBottom: 22 }}>
                <span className="bag-chain-tag">Static Basket</span>
              </div>

              <span className="section-label">Creator Fee</span>
              <div style={{ marginBottom: 22 }}>
                <span className="bag-chain-tag">
                  {performanceFeeBps > 0 ? `${(performanceFeeBps / 100).toFixed(1)}% of realized profit` : 'No performance fee'}
                </span>
              </div>

              <span className="section-label">Rules</span>
              <div style={{ marginBottom: 22, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <span className="bag-chain-tag">Rebalance: {rebalanceChoice === 'Drift' ? 'when drift ≥ 5%' : rebalanceChoice}</span>
                <span className="bag-chain-tag">Max slippage: {slippageBps / 100}%</span>
                <span className="bag-chain-tag">No liquidity: {UNROUTABLE_POLICY_LABELS[unroutablePolicy].short}</span>
                <span className="bag-chain-tag">Minimum: {minInvestment > 0 ? formatUSD(minInvestment) : 'none'}</span>
              </div>

              <span className="section-label">Network</span>
              <div style={{ marginBottom: 22 }}>
                <span className="bag-chain-tag">
                  {NETWORKS.find((n) => n.id === selectedNetworkId)?.glyph}{' '}
                  {NETWORKS.find((n) => n.id === selectedNetworkId)?.label ?? selectedNetworkId}
                </span>
              </div>

              <span className="section-label">Composition</span>
              {noRouteAssets.length > 0 && (
                <NoRouteWarning
                  symbols={noRouteAssets.map((a) => a!.symbol)}
                  policy={unroutablePolicyChosen ? unroutablePolicy : null}
                  onChoose={chooseUnroutablePolicy}
                />
              )}
              <div className="review-list">
                {selectedAssets.map((asset) => {
                  const pct = allocations[asset!.id] || 0;
                  return (
                    <div key={asset!.id} className="review-row">
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <AssetIcon asset={asset!} />
                        <div className="asset-meta">
                          <div className="sym">{asset!.symbol}</div>
                          <div className="nm">
                            {asset!.name}{launchBuy ? ` · ${formatUSD((pct / 100) * investmentAmount)}` : ''}
                          </div>
                        </div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                        <div className="review-bar-wrap">
                          <div className="review-bar" style={{ width: `${pct}%` }} />
                        </div>
                        <span className="alloc-pct">{pct}%</span>
                      </div>
                    </div>
                  );
                })}
              </div>

              {publishError && (
                <div className="publish-error" role="alert" style={{
                  marginTop: 16,
                  marginBottom: 4,
                  padding: '12px 14px',
                  borderRadius: 10,
                  border: '1px solid rgba(239,68,68,0.4)',
                  background: 'rgba(239,68,68,0.08)',
                  color: '#ef4444',
                  fontSize: 13.5,
                }}>
                  <div style={{ fontWeight: 600, marginBottom: 4 }}>Couldn&apos;t deploy this bag</div>
                  <ul style={{ margin: 0, paddingLeft: 18 }}>
                    {publishError.map((msg, i) => (
                      <li key={i}>{msg}</li>
                    ))}
                  </ul>
                  {/* The actual reason sign-in failed, if it did — otherwise
                      the creator only ever sees "sign in first" again. */}
                  {isSigningIn && <div style={{ marginTop: 8 }}>Waiting for the signature in your wallet…</div>}
                  {!isSigningIn && authError && <div style={{ marginTop: 8 }}>Sign-in error: {authError}</div>}
                </div>
              )}

              <span className="section-label" style={{ marginTop: 22, display: 'block' }}>Launch</span>
              <div className="alloc-row" style={{ marginBottom: 8 }}>
                <div style={{ fontSize: 13.5, color: 'var(--ink-soft)', marginBottom: 10 }}>
                  Your bag goes live when you deploy it on-chain. Protocol creation fee:{' '}
                  <strong style={{ color: 'var(--ink)' }}>{creationFeeWei === null ? '…' : formatEthFee(creationFeeWei)}</strong>
                  {creationFeeWei !== null && creationFeeWei !== '0' && ', paid in the same transaction. One signature.'}
                </div>
                <div style={{ fontSize: 13.5 }}>
                  {launchBuy ? (
                    <>
                      Launch buy: <strong>{launchPayment === 'native' && selectedNetworkId === 'ethereum' ? `${investmentAmount} ETH` : formatUSD(Number(investmentAmount))}</strong> — starts right after the deploy is confirmed.
                    </>
                  ) : (
                    'No launch buy — the bag is only created on-chain.'
                  )}{' '}
                  <button type="button" onClick={() => setCurrentStep('allocation')} style={{ background: 'none', border: 'none', padding: 0, color: 'var(--gold-lt, #F0DFC0)', cursor: 'pointer', textDecoration: 'underline' }}>
                    Change
                  </button>
                </div>
              </div>

              {launch ? (
                <div style={{ marginTop: 16 }}>
                  <DeployBagPanel
                    bagId={launch.bagId}
                    bagName={launch.name}
                    chain={selectedNetworkId}
                    autoStart
                    presetLaunchBuy={launch.buy ?? '0'}
                    onDeployed={(amount) => {
                      if (amount) setLaunch((prev) => (prev ? { ...prev, buying: true } : prev));
                      else router.push(`/dashboard/bag/${launch.bagId}`);
                    }}
                  />
                  <p style={{ fontSize: 12.5, color: 'var(--mute)', marginTop: 8 }}>
                    Your draft is saved — you can also <Link href={`/dashboard/bag/${launch.bagId}`}>open the bag page</Link> and deploy from there.
                  </p>
                </div>
              ) : (
                <div className="create-actions">
                  <button className="btn btn-ghost back" onClick={() => setCurrentStep('allocation')}>Back</button>
                  <button
                    className="btn btn-primary"
                    disabled={!isValid || isPublishing || (noRouteAssets.length > 0 && !unroutablePolicyChosen)}
                    title={noRouteAssets.length > 0 && !unroutablePolicyChosen ? 'Choose what happens to the assets with no swap route first.' : undefined}
                    onClick={handlePublish}
                  >
                    {isPublishing ? <Check size={17} /> : <Save size={17} />}
                    {isPublishing ? 'Opening your wallet…' : launchBuy ? `Deploy & buy ${launchPayment === 'native' && selectedNetworkId === 'ethereum' ? `${investmentAmount} ETH` : formatUSD(Number(investmentAmount))}` : 'Deploy bag'}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="summary-card">
          <span className="section-label">Bag Summary</span>
          <div className="summary-row"><span className="l">Name</span><span className="v">{bagName || '-'}</span></div>
          <div className="summary-row"><span className="l">Launch buy</span><span className="v">{launchBuy ? (launchPayment === 'native' && selectedNetworkId === 'ethereum' ? `${investmentAmount} ETH` : formatUSD(Number(investmentAmount))) : 'None'}</span></div>
          <div className="summary-row"><span className="l">Assets</span><span className="v">{selectedAssetIds.length}</span></div>
          <div className="summary-row"><span className="l">Network</span><span className="v">{NETWORKS.find((n) => n.id === selectedNetworkId)?.label ?? selectedNetworkId}</span></div>
          <div className="summary-row">
            <span className="l">Allocation</span>
            <span className={`v ${totalAllocation === 100 ? 'ok' : 'bad'}`}>{totalAllocation}%</span>
          </div>
          <div className="summary-row"><span className="l">Crypto</span><span className="v">{selectedAssets.filter(a => a!.type === 'crypto').length}</span></div>
          <div className="summary-row"><span className="l">Stocks</span><span className="v">{selectedAssets.filter(a => a!.type === 'stock').length}</span></div>

          {currentStep === 'review' && (
            <div className="summary-ready">✓ Ready to publish your bag!</div>
          )}
        </div>
      </div>

      {launch?.buying && launch.buy && (
        <PurchasePreviewModal
          bagId={launch.bagId}
          bagName={launch.name}
          initialAmount={launch.buy}
          preferNativeInput={launch.payment === 'native'}
          autoStart
          onCompleted={() => router.push(`/dashboard/bag/${launch.bagId}`)}
          onClose={() => router.push(`/dashboard/bag/${launch.bagId}`)}
        />
      )}
    </main>
  );
}

const UNROUTABLE_POLICY_LABELS: Record<UnroutablePolicy, { short: string; long: string }> = {
  BLOCK: { short: 'pause buying', long: 'Pause buying — nobody can buy the Bag until every asset has liquidity.' },
  HOLD_INPUT: {
    short: 'hold as USDG',
    long: "Hold that share as USDG — the buyer's money still goes in; the missing asset's share waits as USDG until it can be bought.",
  },
  REFUND: { short: 'refund that share', long: "Refund that share — the buyer only pays for the assets that can be bought." },
};

function UnroutablePolicyPicker({ value, onChange }: { value: UnroutablePolicy | null; onChange: (p: UnroutablePolicy) => void }) {
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      {UNROUTABLE_POLICIES.map((policy) => (
        <label key={policy} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13, cursor: 'pointer', lineHeight: 1.45 }}>
          <input type="radio" name="unroutable-policy" checked={value === policy} onChange={() => onChange(policy)} style={{ marginTop: 3 }} />
          <span>{UNROUTABLE_POLICY_LABELS[policy].long}</span>
        </label>
      ))}
      <div className="nm" style={{ lineHeight: 1.5 }}>
        Partial buys stop if more than {MAX_UNROUTABLE_WEIGHT_BPS / 100}% of the Bag can&apos;t be bought.
      </div>
    </div>
  );
}

function NoRouteWarning({
  symbols,
  policy,
  onChoose,
}: {
  symbols: string[];
  policy: UnroutablePolicy | null;
  onChoose: (p: UnroutablePolicy) => void;
}) {
  return (
    <div
      style={{
        marginBottom: 14,
        padding: '10px 12px',
        borderRadius: 10,
        border: '1px solid rgba(226,125,96,0.45)',
        background: 'rgba(226,125,96,0.08)',
        fontSize: 13,
      }}
    >
      <div style={{ color: '#E27D60', marginBottom: 8 }}>
        No swap route right now for {symbols.join(', ')}. Choose what happens when someone buys this Bag:
      </div>
      <UnroutablePolicyPicker value={policy} onChange={onChoose} />
    </div>
  );
}

/** Wei -> "0.00015 ETH", exact, trailing zeros trimmed. */
function formatEthFee(wei: string): string {
  if (wei === '0') return 'none';
  const value = BigInt(wei);
  const base = BigInt(10) ** BigInt(18);
  const frac = (value % base).toString().padStart(18, '0').replace(/0+$/, '');
  return `${value / base}${frac ? `.${frac}` : ''} ETH`;
}
