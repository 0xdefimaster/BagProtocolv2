'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { X, ArrowRight, Loader2, CheckCircle2, AlertTriangle, Wallet } from 'lucide-react';
import { MAX_ACCEPTABLE_PRICE_IMPACT_BPS, type ComposerFallbackNotice } from '@/types/purchase-intent';
import { formatDecimalStringUsd, formatRawAmount, formatRawAmountUsd } from '@/lib/format';
import { useWallet } from '@/lib/wallet-context';
import { usePurchaseExecution } from '@/hooks/use-purchase-execution';
import { purchasePrefetchKey, usePurchasePrefetch } from '@/hooks/use-purchase-prefetch';
import { usePurchaseOptions, resolveSelectedProviderId, ExecutionCandidateView } from '@/hooks/use-purchase-options';
import { deriveSigningExpectation } from '@/lib/execution/signing-expectation';
import { MAX_UNROUTABLE_WEIGHT_BPS } from '@/types/basket-protocol';

// -----------------------------------------------------------------------------
// Phase 12 — Purchase Preview. Replaces InvestModal (components/app/
// InvestModal.tsx) as the "Invest" entry point on BagCard and both bag
// detail pages. Deliberately NOT the same flow as InvestModal's
// onConfirm(amount): that was — and, as a standalone file, still is — the
// existing PAPER TRADING confirm (creates a Position, no domain math).
// This component does not call it, does not create a paper position, and
// does not move any money — it only shows what the Phase 10 domain
// pipeline (calculateDepositAllocation -> getDepositQuote ->
// buildExecutionPlan, wired server-side in
// app/api/bags/[id]/purchase-preview/route.ts) says WOULD happen.
//
// UI computes nothing itself — every number here comes from the server
// response. See lib/server/purchase-preview.ts for where the actual math
// lives.
//
// Phase 13 cleanup — every raw/decimal-string display below goes through
// lib/format.ts's `formatRawAmount*`/`formatDecimalString*` helpers, never
// `Number(...)`. This wasn't a cosmetic-only concern: `Number(rawBigString)`
// silently loses precision for a large share quantity well before any
// `.toFixed()`/`.toLocaleString()` runs — the loss happens at the
// `Number(...)` conversion itself, which is exactly the "no JS number on
// the financial path" rule the domain layer (shares.ts) already follows
// for computation, now followed here for display too.
// -----------------------------------------------------------------------------

interface InputAssetOption {
  id: string;
  chain: string;
  address: string;
  symbol: string;
  decimals: number;
  name: string;
}

interface DepositAllocationView {
  targetSymbol: string;
  targetWeightBps: number;
  valueRaw: string;
  action: 'KEEP' | 'SWAP';
}

interface ExecutionStepView {
  targetSymbol: string;
  action: 'KEEP' | 'SWAP';
}

// Phase 14 — mirrors lib/blockchain/execution-adapter.ts's `ExecutionStepQuote`/
// `ExecutionQuoteError`/`ExecutionResult`. UI-local view types (not imported
// from lib/blockchain directly, same convention `DepositAllocationView`/
// `ExecutionStepView` above already establish for this file) — only the
// fields actually rendered are listed.
interface ExecutionQuoteView {
  outputAmountRaw: string;
  outputDecimals: number;
  minOutputRaw: string | null;
  route: string | null;
  gasCostRaw: string | null;
  gasCostAsset: { chain: string; address: string } | null;
}

interface ExecutionQuoteErrorView {
  code: 'QUOTE_UNAVAILABLE' | 'UNSUPPORTED_ROUTE' | 'INVALID_ASSET' | 'PROVIDER_ERROR';
  message: string;
}

interface ExecutionStepResultView {
  step: ExecutionStepView;
  quote: ExecutionQuoteView | null;
  error: ExecutionQuoteErrorView | null;
}

interface ExecutionResultView {
  steps: ExecutionStepResultView[];
}

interface PurchasePreviewResponse {
  disclaimer: string;
  inputSymbol: string;
  inputAmountDisplay: string;
  depositPlan: { allocations: DepositAllocationView[]; unallocatedRaw: string };
  /** Null when the oracle could not value the Bag: shares are then priced from the executable quote when the purchase is prepared. */
  depositQuote: { sharesRaw: string; shareDecimals: number; sharePrice: string; isBootstrap: boolean } | null;
  shareValuation?: 'ORACLE_NAV' | 'EXECUTION_QUOTE';
  executionPlan: { steps: ExecutionStepView[] };
  navGross: string | null;
  navQuoteCurrency: string | null;
  isBootstrap: boolean;
  /** Which holdings have no usable market price right now, and why. Display only: it never blocks the purchase by itself. */
  valuation?: { available: true } | { available: false; unavailable: { chain: string; address: string; symbol: string | null; cause: string }[] };
  /** Phase 14 — present (possibly `null`) only because this file always requests `?quotes=true`; a caller of the raw API without that flag never gets this field populated. */
  quotes: ExecutionResultView | null;
  quotesError: string | null;
  /** The creator's rule for legs with no swap route: 'BLOCK' | 'HOLD_INPUT' | 'REFUND'. */
  unroutablePolicy?: string;
}

interface PurchasePreviewModalProps {
  bagId: string;
  bagName: string;
  /** Prefills "You pay" — e.g. the creator's launch-buy amount from the deploy panel. */
  initialAmount?: string;
  /** For Ethereum launch buys, prefer native ETH over the default settlement token. */
  preferNativeInput?: boolean;
  /** Starts the purchase by itself once the preview and routes are ready (launch buy right after deploy). The wallet still asks for every signature. */
  autoStart?: boolean;
  /** Called once the purchase completes (the Create page uses it to move on to the new bag's page). */
  onCompleted?: () => void;
  onClose: () => void;
}

const PRICE_CAUSE_LABEL: Record<string, string> = {
  MARKET_CLOSED_OR_HALTED: 'market closed or trading halted',
  SPREAD_TOO_WIDE: 'bid/ask spread too wide, e.g. market closed',
  STALE_QUOTE: 'no recent quote',
  NOT_LISTED: 'not listed by the price source',
  SOURCES_DISAGREE: 'price sources disagree',
  SOURCE_UNAVAILABLE: 'price source unreachable',
  NO_PRICE: 'no price published',
  STALE_PRICE: 'price too old',
};
const priceCauseLabel = (cause: string) => PRICE_CAUSE_LABEL[cause] ?? 'unavailable';

export function PurchasePreviewModal({ bagId, bagName, initialAmount, autoStart, preferNativeInput, onCompleted, onClose }: PurchasePreviewModalProps) {
  // No default amount: a pre-filled "100" made the background preparation
  // build a $100 route before the buyer had typed anything.
  const [amount, setAmount] = useState(initialAmount ?? '');
  const [inputAssets, setInputAssets] = useState<InputAssetOption[] | null>(null);
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const [loadingAssets, setLoadingAssets] = useState(true);
  const [assetsError, setAssetsError] = useState<string | null>(null);

  const [preview, setPreview] = useState<PurchasePreviewResponse | null>(null);
  const [calculating, setCalculating] = useState(false);
  const [quotesLoading, setQuotesLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const wallet = useWallet();
  const execution = usePurchaseExecution();
  const awaitingFallback = execution.state.phase === 'awaiting_price_impact_confirmation';
  const isExecuting = execution.state.phase !== 'idle' && execution.state.phase !== 'failed' && !awaitingFallback;

  // The wallet prompts are sent by THIS page (the server never signs for the
  // buyer). Closing or reloading the tab mid-purchase stops them, so warn first.
  useEffect(() => {
    if (!isExecuting || execution.state.phase === 'completed') return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [isExecuting, execution.state.phase]);

  // Item 6/8/9/14 — candidate comparison. `options` is `null` on any
  // deployment without BAG_EXECUTION_COMPILER_ENABLED (or while nothing is
  // eligible yet) — see hooks/use-purchase-options.ts's own doc. Nothing
  // below this ever blocks the existing preview/purchase flow on it.
  //
  // Checkpoint 8/9 — `isStale`/`refresh` are now actually consulted (see
  // the staleness banner below and the Purchase button's disabled
  // condition), closing the gap where `CANDIDATE_TTL_MS`/`isCandidateStale()`
  // existed but nothing in the UI ever called them.
  // The automatic launch buy never shows the route comparison, so it doesn't
  // ask for it: that request (and the live per-leg quotes below) only
  // competed with the purchase itself for the server.
  const { options, isStale, refresh } = usePurchaseOptions(bagId, selectedAssetId, amount, !autoStart);
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null);

  // Only worth a picker when there's an actual CHOICE (item 0: "today the
  // user will normally see 2 candidates at most" — often exactly one). A
  // single executable candidate (or zero) is nothing to compare, so no UI
  // renders and `execution.start()` below is called without a
  // `selectedProviderId`, falling straight through to
  // `compileBagExecution()`'s own ordinary provider-order fallback.
  const executableCandidates = options?.candidates.filter((c) => c.compile.status === 'COMPILED') ?? [];
  const showCandidatePicker = executableCandidates.length > 1;

  // Review fix #4 — the server already tells us how many providers were
  // ATTEMPTED (not just how many succeeded): `options.candidates` (COMPILED)
  // + `options.failed` (FAILED) is exactly `eligible.length` from
  // `compileBagExecutionCandidates()` — a provider that was never eligible
  // (didn't pass `supports()`/`allowedProviders`/`atomic`) never appears in
  // either array, so this count is never inflated by routes that were never
  // really tried. Only rendered when at least one attempted route actually
  // failed — "2 of 2 available" is noise, "2 of 3 available" is signal.
  // Deliberately independent of `showCandidatePicker`: a single surviving
  // candidate (nothing to compare, so no picker renders) is exactly the
  // case where silently dropping the failed routes would be most
  // misleading — the user should still see that a route was attempted and
  // didn't work, without the raw internal `failureReason` ever reaching
  // this component (that stays server-side/logging-only — see
  // hooks/use-purchase-options.ts's own "don't interpret why" convention).
  const totalAttemptedRoutes = executableCandidates.length + (options?.failed.length ?? 0);
  const showRouteAvailabilitySummary = (options?.failed.length ?? 0) > 0;

  // Checkpoint 8/9 fix — `resolveSelectedProviderId()` (use-purchase-options.ts)
  // replaces the old `[options?.executionPlanHash, showCandidatePicker]`
  // effect, which missed the case of a REFRESH returning the SAME
  // `executionPlanHash` while the previously-selected provider had dropped
  // out of the executable set (see that function's own doc for the full
  // reasoning). Runs on every `options` change — not just a hash change —
  // and uses the functional `setState` form so it never needs
  // `selectedProviderId` itself as a dependency (avoiding a stale-closure
  // bug or an effect that re-fires on its own write).
  const previousPlanHashRef = useRef<string | null>(null);
  useEffect(() => {
    setSelectedProviderId((prev) =>
      resolveSelectedProviderId({
        previousProviderId: prev,
        previousExecutionPlanHash: previousPlanHashRef.current,
        options,
      })
    );
    previousPlanHashRef.current = options?.executionPlanHash ?? null;
  }, [options]);

  // Item 5/6 — a stale comparison is only a UI-correctness concern when
  // its numbers are actually being shown/compared (the picker). With 0 or
  // 1 executable candidates nothing numeric is on screen to go stale, and
  // `execution.start()` doesn't pin a provider anyway (see
  // `showCandidatePicker`'s own doc) — the server's ordinary fallback
  // order applies regardless of quote age. `compiledAt` itself is never
  // trusted as an executable artifact either way — see
  // `ExecutionCandidate.compiledAt`'s own doc in candidate-types.ts; this
  // flag exists purely so the UI doesn't show week-old-looking numbers as
  // if they were just quoted, and so the user isn't picking a route off a
  // comparison that's since drifted, per spec item 6.
  const staleComparisonBlocksPurchase = showCandidatePicker && isStale;

  // Item 8 — derived in ONE place (lib/execution/signing-expectation.ts)
  // from the compiled execution's persisted mode, never recomputed from
  // steps here. Null until an intent exists, because the mode is only
  // known once the purchase has actually been compiled.
  const signingExpectation = useMemo(
    () => (execution.state.intent ? deriveSigningExpectation(execution.state.intent) : null),
    [execution.state.intent]
  );

  // Swap legs the live quote says have no route (not transient provider
  // errors). Whether that blocks the purchase is the creator's rule: under
  // BLOCK (default) it would fail at the re-quote step anyway, so block it
  // up front; HOLD_INPUT / REFUND buy around it up to the weight cap, and
  // the server applies the same rule when the purchase is created.
  const unroutableSymbols = useMemo(() => {
    if (!preview?.quotes) return [];
    return preview.executionPlan.steps
      .filter((s) => s.action === 'SWAP')
      .filter((s) => {
        const result = preview.quotes?.steps.find((r) => r.step.targetSymbol === s.targetSymbol);
        return !result || (result.error !== null && result.error.code !== 'PROVIDER_ERROR');
      })
      .map((s) => s.targetSymbol);
  }, [preview]);
  const unroutablePolicy = preview?.unroutablePolicy ?? 'BLOCK';
  const unroutableWeightBps = useMemo(
    () =>
      (preview?.depositPlan.allocations ?? [])
        .filter((a) => unroutableSymbols.includes(a.targetSymbol))
        .reduce((sum, a) => sum + a.targetWeightBps, 0),
    [preview, unroutableSymbols]
  );
  const noRouteBlocksPurchase =
    unroutableSymbols.length > 0 && (unroutablePolicy === 'BLOCK' || unroutableWeightBps > MAX_UNROUTABLE_WEIGHT_BPS);
  const buyingAroundNoRoute = unroutableSymbols.length > 0 && !noRouteBlocksPurchase;

  // Prepare the purchase server-side while the buyer is still looking, so Buy
  // opens the wallet immediately (use-purchase-prefetch.ts).
  const prefetch = usePurchasePrefetch({
    bagId,
    inputAssetId: selectedAssetId,
    amount,
    providerId: selectedProviderId,
    enabled:
      !!preview && !previewError && !calculating && !!selectedAssetId && wallet.isConnected && !!wallet.authUser &&
      !!wallet.walletAddress && !isExecuting && execution.state.phase !== 'completed' && !noRouteBlocksPurchase && !staleComparisonBlocksPurchase,
  });
  const takePrepared = () =>
    selectedAssetId ? prefetch.take(purchasePrefetchKey(bagId, selectedAssetId, amount, selectedProviderId)) : undefined;

  // Load the verified input-asset list once per bag.
  useEffect(() => {
    let cancelled = false;
    setLoadingAssets(true);
    setAssetsError(null);
    fetch(`/api/bags/${bagId}/purchase-preview`, { credentials: 'same-origin' })
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `Request failed (${res.status})`);
        return res.json() as Promise<{ inputAssets: InputAssetOption[] }>;
      })
      .then((data) => {
        if (cancelled) return;
        setInputAssets(data.inputAssets);
        const nativeEth = preferNativeInput
          ? data.inputAssets.find((a) => a.chain === 'ethereum' && a.address.toLowerCase() === '0x0000000000000000000000000000000000000000')
          : undefined;
        setSelectedAssetId(nativeEth?.id ?? data.inputAssets[0]?.id ?? null);
      })
      .catch((err) => {
        if (cancelled) return;
        setAssetsError(err instanceof Error ? err.message : 'Unable to load input assets.');
      })
      .finally(() => {
        if (!cancelled) setLoadingAssets(false);
      });
    return () => {
      cancelled = true;
    };
  }, [bagId, preferNativeInput]);

  // Recompute the preview whenever amount/asset changes (debounced —
  // "Calculating..." for the network round trip, not for pure local math,
  // since there isn't any local math here to begin with).
  useEffect(() => {
    if (!selectedAssetId) return;

    const trimmed = amount.trim();
    if (trimmed === '') {
      setPreview(null);
      setPreviewError(null);
      return;
    }

    let cancelled = false;
    setCalculating(true);
    setPreviewError(null);

    // Two phases so the allocation shows up immediately: the plain preview
    // (registry + NAV + allocation math) first, then the live LI.FI quotes,
    // which are the slow part. Purchase is enabled as soon as the allocation
    // is in: the quotes are display-only here — the purchase-intent compiles
    // its own route server-side (reusing the background purchase-options
    // compile when it has one) and applies the no-route policy itself.
    const post = (withQuotes: boolean) =>
      fetch(`/api/bags/${bagId}/purchase-preview${withQuotes ? '?quotes=true' : ''}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ inputAssetId: selectedAssetId, amount: trimmed }),
      }).then(async (res) => {
        const body = await res.json().catch(() => null);
        if (!res.ok) throw new Error(body?.error ?? 'Unable to calculate allocation.');
        return body.preview as PurchasePreviewResponse;
      });

    const timer = setTimeout(() => {
      setQuotesLoading(true);
      post(false)
        .then((data) => {
          if (cancelled) return;
          setPreview({ ...data, quotes: null, quotesError: null });
          setCalculating(false);
          // The automatic launch buy starts right away and never waits for
          // the display-only live quotes; don't fetch them at all then.
          if (autoStart) return;
          return post(true)
            .then((withQuotes) => {
              if (!cancelled) setPreview(withQuotes);
            })
            .catch((err) => {
              // Keep the allocation; only the live quotes are missing.
              if (!cancelled) {
                setPreview((prev) =>
                  prev ? { ...prev, quotesError: err instanceof Error ? err.message : 'Unable to fetch live quotes.' } : prev
                );
              }
            });
        })
        .catch((err) => {
          if (cancelled) return;
          setPreview(null);
          setPreviewError(err instanceof Error ? err.message : 'Unable to calculate allocation.');
        })
        .finally(() => {
          if (!cancelled) {
            setCalculating(false);
            setQuotesLoading(false);
          }
        });
    }, 300);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [bagId, selectedAssetId, amount, autoStart]);

  // Launch buy: once everything the Purchase button waits for is ready,
  // press it once on the creator's behalf, so deploy → buy feels like one
  // flow. Never retried automatically after a failure.
  const completedNotifiedRef = useRef(false);
  useEffect(() => {
    if (execution.state.phase !== 'completed' || completedNotifiedRef.current) return;
    completedNotifiedRef.current = true;
    onCompleted?.();
  }, [execution.state.phase, onCompleted]);

  const autoStartedRef = useRef(false);
  useEffect(() => {
    if (!autoStart || autoStartedRef.current) return;
    if (!preview || previewError || calculating || !selectedAssetId) return;
    if (noRouteBlocksPurchase || staleComparisonBlocksPurchase) return;
    if (!wallet.isConnected || !wallet.authUser || execution.state.phase !== 'idle') return;
    autoStartedRef.current = true;
    void execution.start(bagId, selectedAssetId, amount.trim(), wallet.walletAddress, selectedProviderId ?? undefined, takePrepared());
    // Fires once when every precondition is met; execution/wallet identities are stable enough here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart, preview, previewError, calculating, selectedAssetId, noRouteBlocksPurchase, staleComparisonBlocksPurchase, wallet.isConnected, wallet.authUser, execution.state.phase]);

  const selectedAsset = useMemo(
    () => inputAssets?.find((a) => a.id === selectedAssetId) ?? null,
    [inputAssets, selectedAssetId]
  );

  const estimatedSharesDisplay = preview?.depositQuote
    ? formatRawAmount(preview.depositQuote.sharesRaw, preview.depositQuote.shareDecimals, { maxFractionDigits: 4 })
    : null;
  const unvaluedAssets = preview?.valuation && !preview.valuation.available ? preview.valuation.unavailable : [];

  return (
    <div
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.7)',
        backdropFilter: 'blur(4px)',
        zIndex: 200,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
        overflowY: 'auto',
      }}
    >
      <div
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        style={{
          background: 'var(--surface, #0D0D0D)',
          border: '1px solid var(--line, rgba(217,185,139,0.16))',
          borderRadius: 16,
          padding: 24,
          width: '100%',
          maxWidth: 460,
          color: 'var(--ink, #F6F3EC)',
          fontFamily: 'var(--font-inter), sans-serif',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
          <h3 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>Buy {bagName}</h3>
          <button
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onClose();
            }}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--ink-soft, #B4AEA2)' }}
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>
        <p style={{ fontSize: 12.5, color: 'var(--ink-soft, #B4AEA2)', marginBottom: 18 }}>
          {isExecuting || execution.state.phase === 'completed'
            ? 'This purchase uses a real, on-chain route signed by your wallet.'
            : 'Allocation below is a live preview. Purchasing executes real on-chain transactions from your wallet.'}
        </p>

        {/* Item 8 — the REAL signature/transaction expectation, taken from
            the compiled execution's own mode rather than assumed. Shown as
            soon as an intent exists (the mode is only determined once the
            purchase has been compiled); before that there is nothing
            truthful to state, so nothing is stated, and the copy above no
            longer implies a single transaction. */}
        {signingExpectation && (
          <div
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 8,
              padding: '9px 12px',
              borderRadius: 10,
              marginBottom: 14,
              fontSize: 12,
              border: '1px solid var(--line-soft, rgba(255,255,255,0.08))',
              color: 'var(--ink-soft, #B4AEA2)',
            }}
          >
            <Wallet size={14} style={{ flexShrink: 0, marginTop: 1 }} />
            <span>
              <strong style={{ color: 'var(--ink, #F6F3EC)', fontWeight: 600 }}>
                {signingExpectation.summary}
              </strong>
              {' — '}
              {signingExpectation.detail}
            </span>
          </div>
        )}

        {/* You Pay */}
        <div style={{ marginBottom: 6, fontSize: 11.5, letterSpacing: 0.4, textTransform: 'uppercase', color: 'var(--ink-soft, #B4AEA2)' }}>
          You Pay
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            border: '1px solid var(--line-soft, rgba(255,255,255,0.08))',
            borderRadius: 10,
            padding: '10px 14px',
            marginBottom: 14,
            opacity: isExecuting ? 0.6 : 1,
          }}
        >
          <input
            type="text"
            inputMode="decimal"
            value={amount}
            disabled={isExecuting}
            onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
            placeholder="Enter amount"
            style={{
              flex: 1,
              background: 'transparent',
              border: 'none',
              outline: 'none',
              color: 'var(--ink, #F6F3EC)',
              fontSize: 20,
              fontWeight: 600,
              minWidth: 0,
            }}
          />
          {loadingAssets ? (
            <span style={{ fontSize: 12.5, color: 'var(--ink-soft, #B4AEA2)' }}>Loading…</span>
          ) : assetsError ? (
            <span style={{ fontSize: 12.5, color: '#E27D60' }}>Assets unavailable</span>
          ) : inputAssets && inputAssets.length > 0 ? (
            <select
              value={selectedAssetId ?? ''}
              disabled={isExecuting}
              onChange={(e) => setSelectedAssetId(e.target.value)}
              style={{
                background: 'var(--gold-tint, rgba(217,185,139,0.1))',
                border: '1px solid var(--line-soft, rgba(255,255,255,0.08))',
                borderRadius: 8,
                padding: '6px 10px',
                color: 'var(--gold-lt, #F0DFC0)',
                fontWeight: 600,
                fontSize: 13.5,
              }}
            >
              {inputAssets.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.symbol}
                </option>
              ))}
            </select>
          ) : (
            <span style={{ fontSize: 12.5, color: 'var(--ink-soft, #B4AEA2)' }}>No supported payment asset on this network yet.</span>
          )}
        </div>

        {previewError && (
          <div
            role="alert"
            style={{
              padding: '10px 12px',
              borderRadius: 10,
              border: '1px solid rgba(226,125,96,0.4)',
              background: 'rgba(226,125,96,0.08)',
              color: '#E27D60',
              fontSize: 12.5,
              marginBottom: 14,
            }}
          >
            {previewError}
          </div>
        )}

        {calculating && !preview && !previewError && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--ink-soft, #B4AEA2)', fontSize: 12.5, marginBottom: 14 }}>
            <Loader2 size={14} className="spin" /> Calculating…
          </div>
        )}

        {preview && !previewError && (
          <>
            <div style={{ marginBottom: 6, fontSize: 11.5, letterSpacing: 0.4, textTransform: 'uppercase', color: 'var(--ink-soft, #B4AEA2)' }}>
              Allocation
            </div>
            <div style={{ marginBottom: 14 }}>
              {preview.depositPlan.allocations.map((a) => {
                const isNativePayment = selectedAsset?.address.toLowerCase() === '0x0000000000000000000000000000000000000000';
                const valueDisplay = selectedAsset
                  ? isNativePayment
                    ? `${formatRawAmount(a.valueRaw, selectedAsset.decimals, { maxFractionDigits: 6 })} ${selectedAsset.symbol}`
                    : formatRawAmountUsd(a.valueRaw, selectedAsset.decimals)
                  : '$0.00';
                return (
                  <div
                    key={a.targetSymbol}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '6px 0',
                      fontSize: 13,
                      borderBottom: '1px solid var(--line-soft, rgba(255,255,255,0.06))',
                    }}
                  >
                    <span style={{ fontWeight: 600 }}>{a.targetSymbol}</span>
                    <span style={{ color: 'var(--ink-soft, #B4AEA2)' }}>{(a.targetWeightBps / 100).toFixed(0)}%</span>
                    <span>{valueDisplay}</span>
                    <span
                      style={{
                        fontSize: 10.5,
                        fontWeight: 700,
                        letterSpacing: 0.3,
                        padding: '2px 8px',
                        borderRadius: 999,
                        color: a.action === 'KEEP' ? 'var(--gold-lt, #F0DFC0)' : 'var(--ink-soft, #B4AEA2)',
                        border: `1px solid ${a.action === 'KEEP' ? 'var(--gold, #D9B98B)' : 'var(--line-soft, rgba(255,255,255,0.1))'}`,
                      }}
                    >
                      {a.action}
                    </span>
                  </div>
                );
              })}
            </div>

            {unvaluedAssets.length > 0 && (
              <div
                role="status"
                style={{
                  marginBottom: 10,
                  padding: '8px 10px',
                  borderRadius: 8,
                  fontSize: 12.5,
                  border: '1px solid var(--line-soft, rgba(255,255,255,0.12))',
                  color: 'var(--ink-soft, #B4AEA2)',
                }}
              >
                Market price unavailable:{' '}
                {unvaluedAssets.map((a) => `${a.symbol ?? `${a.address.slice(0, 6)}…`} (${priceCauseLabel(a.cause)})`).join(', ')}. Your purchase still uses
                live executable routes and their minimum outputs; your shares are priced from that quote.
              </div>
            )}
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'baseline',
                marginBottom: 4,
                paddingTop: 10,
                borderTop: '1px solid var(--line-soft, rgba(255,255,255,0.08))',
              }}
            >
              <span style={{ fontSize: 12.5, color: 'var(--ink-soft, #B4AEA2)' }}>
                Estimated BAG Shares {preview.depositQuote?.isBootstrap ? '(bootstrap quote)' : ''}
              </span>
              <span style={{ fontSize: 18, fontWeight: 700 }}>{estimatedSharesDisplay ?? 'From your quote'}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 14, fontSize: 12.5, color: 'var(--ink-soft, #B4AEA2)' }}>
              <span>Price per share</span>
              <span>{preview.depositQuote ? formatDecimalStringUsd(preview.depositQuote.sharePrice) : 'Set at confirmation'}</span>
            </div>

            <div style={{ marginBottom: 6, fontSize: 11.5, letterSpacing: 0.4, textTransform: 'uppercase', color: 'var(--ink-soft, #B4AEA2)' }}>
              Allocation vs. Live Quote
            </div>
            <div style={{ marginBottom: 14, fontSize: 12.5, color: 'var(--ink-soft, #B4AEA2)' }}>
              {preview.executionPlan.steps.length} allocation{preview.executionPlan.steps.length === 1 ? '' : 's'}
              {preview.executionPlan.steps.map((s) => {
                const result = preview.quotes?.steps.find((r) => r.step.targetSymbol === s.targetSymbol);
                return (
                  <div key={s.targetSymbol} style={{ marginTop: 8, color: 'var(--ink, #F6F3EC)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span>{preview.inputSymbol}</span>
                      <ArrowRight size={12} />
                      <span>{s.targetSymbol}</span>
                      <span style={{ marginLeft: 'auto', fontSize: 10.5, color: 'var(--ink-soft, #B4AEA2)' }}>
                        {s.action === 'KEEP' ? 'no route needed' : ''}
                      </span>
                    </div>
                    {s.action === 'SWAP' && (
                      <div style={{ marginTop: 3, fontSize: 11.5, color: 'var(--gold-lt, #F0DFC0)' }}>
                        {!preview.quotes && !preview.quotesError && (
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: 'var(--ink-soft, #B4AEA2)' }}>
                            <Loader2 size={11} className="spin" /> Getting best route…
                          </span>
                        )}
                        {result?.quote && (
                          <span>
                            ≈ {formatRawAmount(result.quote.outputAmountRaw, result.quote.outputDecimals, { maxFractionDigits: 6 })}{' '}
                            {s.targetSymbol}
                            {result.quote.route ? <span style={{ color: 'var(--ink-soft, #B4AEA2)' }}> via {result.quote.route}</span> : null}
                          </span>
                        )}
                        {result?.error && (
                          <span style={{ color: '#E27D60' }}>
                            {result.error.code === 'QUOTE_UNAVAILABLE' ? 'No route available' : result.error.message}
                          </span>
                        )}
                        {!result && preview.quotes && (
                          <span style={{ color: 'var(--ink-soft, #B4AEA2)' }}>No route available</span>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
              {preview.quotesError && (
                <div style={{ marginTop: 10, color: '#E27D60' }}>Live quotes unavailable — allocation above is still accurate.</div>
              )}
              {noRouteBlocksPurchase && (
                <div style={{ marginTop: 10, color: '#E27D60' }}>
                  {unroutablePolicy === 'BLOCK'
                    ? `No swap route for ${unroutableSymbols.join(', ')} right now, so this Bag can't be bought until liquidity exists.`
                    : `Too much of this Bag has no swap route right now (${unroutableSymbols.join(', ')}, ${unroutableWeightBps / 100}%). Try again later.`}
                </div>
              )}
              {buyingAroundNoRoute && (
                <div style={{ marginTop: 10, color: 'var(--gold-lt, #F0DFC0)' }}>
                  {unroutableSymbols.join(', ')} ({unroutableWeightBps / 100}%) can&apos;t be bought right now.{' '}
                  {unroutablePolicy === 'HOLD_INPUT'
                    ? `Per this Bag's rules, that share stays in your position as ${preview.inputSymbol} until it can be bought.`
                    : `Per this Bag's rules, you'll only pay for the rest — about ${(100 - unroutableWeightBps / 100).toFixed(0)}% of the amount above.`}
                </div>
              )}
            </div>
          </>
        )}

        {/* Review fix #4 — minimal "N of M execution routes available"
            summary. Text-only, no per-route failure reason exposed (see
            showRouteAvailabilitySummary's own doc for why this is
            deliberately shown even when showCandidatePicker is false). */}
        {showRouteAvailabilitySummary && !isExecuting && execution.state.phase === 'idle' && (
          <div style={{ fontSize: 12, color: 'var(--ink-soft, #B4AEA2)', marginBottom: 8 }}>
            {executableCandidates.length} of {totalAttemptedRoutes} execution routes available
          </div>
        )}

        {/* Item 14 — minimal candidate picker. Only rendered before signing
            (once execution has started, the route is already locked in —
            re-deriving it happens server-side via selectedProviderId, not
            by letting the user change their pick mid-flight) and only when
            there's an actual choice (see showCandidatePicker's own doc). */}
        {showCandidatePicker && !isExecuting && execution.state.phase === 'idle' && (
          <>
            {/* Item 5/6/7 — staleness banner + controlled manual refresh,
                not a poll. Shown ONLY once this specific comparison has
                actually aged past CANDIDATE_TTL_MS (isCandidateStale(),
                surfaced via usePurchaseOptions' isStale) — never before
                that, and never phrased as an error, since the numbers were
                genuinely fresh a moment ago. The Purchase button below is
                disabled for the same condition (staleComparisonBlocksPurchase)
                so the user can't act on a comparison this banner is
                actively telling them not to trust. */}
            {isStale && (
              <div
                role="status"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '8px 12px',
                  borderRadius: 10,
                  marginBottom: 8,
                  fontSize: 11.5,
                  border: '1px solid rgba(217,185,139,0.35)',
                  background: 'rgba(217,185,139,0.08)',
                  color: 'var(--gold-lt, #F0DFC0)',
                }}
              >
                <span style={{ flex: 1 }}>These routes may be outdated.</span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    refresh();
                  }}
                  style={{
                    background: 'none',
                    border: '1px solid var(--gold, #D9B98B)',
                    borderRadius: 8,
                    padding: '3px 9px',
                    fontSize: 11,
                    fontWeight: 600,
                    color: 'var(--gold-lt, #F0DFC0)',
                    cursor: 'pointer',
                  }}
                >
                  Refresh routes
                </button>
              </div>
            )}
            <ExecutionCandidatePicker
              candidates={executableCandidates}
              winners={options?.winners ?? []}
              selectedProviderId={selectedProviderId}
              onSelect={setSelectedProviderId}
              /* Item 5 — a stale comparison's own metrics are never
                 presented as if they were just quoted; dimming (rather
                 than hiding) keeps the picker usable for re-selecting once
                 refreshed without implying these particular numbers are
                 current right now. */
              dimmed={isStale}
            />
          </>
        )}

        {execution.state.phase !== 'idle' && !awaitingFallback && (
          <PurchaseExecutionPanel
            state={execution.state}
            inputSymbol={preview?.inputSymbol ?? selectedAsset?.symbol ?? ''}
          />
        )}

        {awaitingFallback && execution.state.priceImpactNotice ? (
          <PriceImpactConfirmation
            notice={execution.state.priceImpactNotice}
            onContinue={() => {
              const bps = execution.state.priceImpactNotice?.priceImpactBps;
              if (!selectedAssetId || bps === null || bps === undefined) return;
              void execution.start(bagId, selectedAssetId, amount.trim(), wallet.walletAddress, selectedProviderId ?? undefined, undefined, { acceptedPriceImpactBps: bps });
            }}
            onCancel={() => execution.reset()}
          />
        ) : execution.state.phase === 'completed' ? (
          <button
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onClose();
            }}
            style={{
              width: '100%',
              padding: '12px',
              borderRadius: 10,
              border: 'none',
              fontWeight: 600,
              fontSize: 14,
              cursor: 'pointer',
              background: 'linear-gradient(155deg, var(--gold-lt, #F0DFC0), var(--gold, #D9B98B) 55%, var(--gold-dk, #9C7B49))',
              color: '#0A0805',
            }}
          >
            Done
          </button>
        ) : !wallet.hasProvider ? (
          <button
            disabled
            title="Install MetaMask, Coinbase Wallet, or Rabby to purchase"
            style={disabledButtonStyle}
          >
            No wallet detected
          </button>
        ) : !wallet.isConnected ? (
          <button onClick={() => wallet.connect()} disabled={wallet.isConnecting} style={primaryButtonStyle}>
            {wallet.isConnecting ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, justifyContent: 'center', width: '100%' }}>
                <Loader2 size={14} className="spin" /> Connecting…
              </span>
            ) : (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, justifyContent: 'center', width: '100%' }}>
                <Wallet size={15} /> Connect Wallet
              </span>
            )}
          </button>
        ) : !wallet.authUser ? (
          <button onClick={() => wallet.signIn()} disabled={wallet.isSigningIn} style={primaryButtonStyle}>
            {wallet.isSigningIn ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, justifyContent: 'center', width: '100%' }}>
                <Loader2 size={14} className="spin" /> Confirm in wallet…
              </span>
            ) : (
              'Sign in to continue'
            )}
          </button>
        ) : (
          <button
            onClick={() => {
              if (!selectedAssetId) return;
              void execution.start(bagId, selectedAssetId, amount.trim(), wallet.walletAddress, selectedProviderId ?? undefined, takePrepared());
            }}
            disabled={!preview || !!previewError || calculating || isExecuting || !selectedAssetId || staleComparisonBlocksPurchase || noRouteBlocksPurchase}
            title={staleComparisonBlocksPurchase ? 'Refresh routes to continue — the comparison shown is outdated.' : noRouteBlocksPurchase ? `No route for ${unroutableSymbols.join(', ')}` : undefined}
            style={{
              ...primaryButtonStyle,
              opacity: !preview || !!previewError || calculating || isExecuting || !selectedAssetId || staleComparisonBlocksPurchase || noRouteBlocksPurchase ? 0.5 : 1,
              cursor: !preview || !!previewError || calculating || isExecuting || !selectedAssetId || staleComparisonBlocksPurchase || noRouteBlocksPurchase ? 'not-allowed' : 'pointer',
            }}
          >
            {isExecuting ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, justifyContent: 'center', width: '100%' }}>
                <Loader2 size={14} className="spin" /> Purchase in progress…
              </span>
            ) : execution.state.phase === 'failed' ? (
              'Try again'
            ) : staleComparisonBlocksPurchase ? (
              'Refresh routes to continue'
            ) : noRouteBlocksPurchase ? (
              'No route available'
            ) : (
              'Purchase'
            )}
          </button>
        )}

        {quotesLoading && preview && !isExecuting && (
          <div style={{ marginTop: 8, fontSize: 12, color: 'var(--ink-soft)' }}>Live route quotes are still loading — you can already purchase.</div>
        )}
        {wallet.error && <div style={{ marginTop: 10, fontSize: 12, color: '#E27D60' }}>{wallet.error}</div>}
        {wallet.authError && <div style={{ marginTop: 10, fontSize: 12, color: '#E27D60' }}>{wallet.authError}</div>}
      </div>
    </div>
  );
}

const primaryButtonStyle: React.CSSProperties = {
  width: '100%',
  padding: '12px',
  borderRadius: 10,
  border: 'none',
  fontWeight: 600,
  fontSize: 14,
  cursor: 'pointer',
  background: 'linear-gradient(155deg, var(--gold-lt, #F0DFC0), var(--gold, #D9B98B) 55%, var(--gold-dk, #9C7B49))',
  color: '#0A0805',
};

const disabledButtonStyle: React.CSSProperties = {
  width: '100%',
  padding: '12px',
  borderRadius: 10,
  border: 'none',
  fontWeight: 600,
  fontSize: 14,
  cursor: 'not-allowed',
  opacity: 0.5,
  background: 'linear-gradient(155deg, var(--gold-lt, #F0DFC0), var(--gold, #D9B98B) 55%, var(--gold-dk, #9C7B49))',
  color: '#0A0805',
};

// -----------------------------------------------------------------------------
// Item 14 — the minimal candidate picker. Renders ONLY the metrics
// `getPurchaseOptionsForUser()` actually annotated (candidate-metrics.ts's
// own "no fabricated zero values" rule, honored here too — a `null` metric
// is simply omitted from a card, never shown as "$0.00" or "N/A" dressed
// up as a real figure) and reuses `deriveSigningExpectation()`
// (signing-expectation.ts) for the confirmation count instead of
// re-deriving it from `executionMode` here.
// -----------------------------------------------------------------------------

const RANKING_LABELS: Record<string, string> = {
  bestGuaranteedOutput: 'Best Guaranteed Output',
  bestQuotedOutput: 'Best Quoted Output',
  lowestGas: 'Lowest Gas',
  fastest: 'Fastest',
};

function providerDisplayName(providerId: string): string {
  if (providerId === 'lifi-composer') return 'LI.FI Composer';
  if (providerId === 'lifi-sequential') return 'LI.FI';
  if (providerId === 'bag-router') return 'BAG Router';
  return providerId;
}

function ExecutionCandidatePicker({
  candidates,
  winners,
  selectedProviderId,
  onSelect,
  dimmed = false,
}: {
  candidates: ExecutionCandidateView[];
  winners: { category: string; providerId: string }[];
  selectedProviderId: string | null;
  onSelect: (providerId: string) => void;
  /** Item 5 — visually de-emphasizes (without hiding) the metrics once the comparison they came from is stale, so they're never mistaken for a just-quoted figure. Selecting a candidate still works while dimmed (e.g. to re-pick after a refresh lands) — this is a presentation hint, not a disabled state. */
  dimmed?: boolean;
}) {
  const categoriesByProvider = new Map<string, string[]>();
  for (const w of winners) {
    categoriesByProvider.set(w.providerId, [...(categoriesByProvider.get(w.providerId) ?? []), w.category]);
  }

  return (
    <div style={{ marginBottom: 14, opacity: dimmed ? 0.55 : 1, transition: 'opacity 150ms ease' }}>
      <div
        style={{
          fontSize: 11,
          fontWeight: 600,
          color: 'var(--ink-soft, #B4AEA2)',
          marginBottom: 8,
          textTransform: 'uppercase',
          letterSpacing: 0.4,
        }}
      >
        Ways to buy
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {candidates.map((candidate) => {
          const isSelected = candidate.providerId === selectedProviderId;
          const tags = categoriesByProvider.get(candidate.providerId) ?? [];
          // Item 2 — the server sends `swapLegCount` directly now (never the
          // full `compiled` object/calldata this comparison screen has no
          // use for; see ExecutionCandidateView's own doc).
          const swapLegCount = candidate.swapLegCount ?? 0;
          // Synthetic steps array — deriveSigningExpectation() only ever
          // reads `.action`, and a candidate has no real
          // PurchaseIntentStepRecord[] yet (that shape doesn't exist until
          // this provider is actually recompiled/persisted — item 9). This
          // is display-only math, exactly the same figure the real intent
          // will carry once created, not a guess.
          const syntheticSteps = Array.from({ length: swapLegCount }, () => ({ action: 'SWAP' as const }));
          const signing = candidate.executionMode
            ? deriveSigningExpectation({ executionMode: candidate.executionMode, steps: syntheticSteps as never })
            : null;

          return (
            <button
              key={candidate.id}
              type="button"
              onClick={() => onSelect(candidate.providerId)}
              style={{
                textAlign: 'left',
                padding: '10px 12px',
                borderRadius: 10,
                cursor: 'pointer',
                border: `1px solid ${isSelected ? 'var(--gold, #D9B98B)' : 'var(--line-soft, rgba(255,255,255,0.08))'}`,
                background: isSelected ? 'rgba(217,185,139,0.08)' : 'transparent',
                color: 'var(--ink, #F6F3EC)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>{providerDisplayName(candidate.providerId)}</span>
                {tags.length > 0 && (
                  <span style={{ display: 'flex', gap: 6 }}>
                    {tags.map((tag) => (
                      <span
                        key={tag}
                        style={{
                          fontSize: 10,
                          fontWeight: 600,
                          color: '#7AC88C',
                          border: '1px solid rgba(122,200,140,0.4)',
                          borderRadius: 999,
                          padding: '2px 7px',
                        }}
                      >
                        {RANKING_LABELS[tag] ?? tag}
                      </span>
                    ))}
                  </span>
                )}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, fontSize: 11.5, color: 'var(--ink-soft, #B4AEA2)' }}>
                {/* Provider-specific output, labelled by what it actually is — a simulation is never shown as a quote, and neither as a guarantee. */}
                {candidate.metrics?.quotedOutputUsd != null && (
                  <span>
                    ~${formatDecimalStringUsd(String(candidate.metrics.quotedOutputUsd))} {candidate.metrics.quotedOutputBasis === 'SIMULATION' ? 'simulated' : 'expected'}
                  </span>
                )}
                {candidate.metrics?.minimumGuaranteedOutputUsd != null ? (
                  <span>≥${formatDecimalStringUsd(String(candidate.metrics.minimumGuaranteedOutputUsd))} guaranteed min</span>
                ) : (
                  candidate.metrics && <span>no guaranteed minimum</span>
                )}
                {candidate.metrics?.estimatedGasUsd != null && <span>~${formatDecimalStringUsd(String(candidate.metrics.estimatedGasUsd))} gas</span>}
                {candidate.metrics?.estimatedDurationSeconds != null && <span>~{Math.round(candidate.metrics.estimatedDurationSeconds)}s</span>}
                {signing && <span>{signing.summary}</span>}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Phase 17 — real execution status, rendered above the button once a
// purchase has been started. Mirrors spec Aşama 6's suggested UI states
// (READY -> Wallet Confirmation Required -> Approve Token -> Confirm Swap
// -> Transaction Submitted -> Confirming -> Completed) without inventing
// any state this component doesn't actually have from the hook.
// -----------------------------------------------------------------------------

const FAILURE_MESSAGES: Partial<Record<string, string>> = {
  USER_REJECTED: 'You rejected the request in your wallet.',
  INSUFFICIENT_BALANCE: 'Insufficient balance to complete this purchase.',
  INSUFFICIENT_ALLOWANCE: 'Token approval failed or was insufficient.',
  SLIPPAGE_EXCEEDED: 'Price moved beyond the allowed slippage.',
  ROUTE_EXPIRED: 'This quote expired. Start a new purchase.',
  TRANSACTION_REVERTED: 'The transaction reverted on-chain.',
  EXECUTION_TIMEOUT: 'The transaction took too long to confirm.',
  UNSUPPORTED_ROUTE: 'This route is not currently supported.',
  PROVIDER_ERROR: 'The routing provider is temporarily unavailable.',
  VERIFICATION_FAILED: 'Received asset did not match what was quoted — no funds were credited.',
  UNKNOWN_ERROR: 'Something went wrong completing this purchase.',
};

function PurchaseExecutionPanel({
  state,
  inputSymbol,
}: {
  state: ReturnType<typeof usePurchaseExecution>['state'];
  inputSymbol: string;
}) {
  const swapSteps = state.intent?.steps.filter((s) => s.action === 'SWAP') ?? [];
  const activeSwapIndex = swapSteps.findIndex((s) => s.stepIndex === state.activeStepIndex);

  let label: string;
  if (state.phase === 'creating') label = 'Preparing your purchase…';
  else if (state.phase === 'preparing') label = 'Wallet confirmation required…';
  else if (state.phase === 'awaiting_signature') {
    const step = swapSteps[activeSwapIndex] ?? swapSteps[0];
    const position = swapSteps.length > 1 && activeSwapIndex >= 0 ? ` (${activeSwapIndex + 1}/${swapSteps.length})` : '';
    label = step ? `Confirm swap to ${step.targetSymbol} in your wallet${position}` : 'Confirm in your wallet…';
  } else if (state.phase === 'confirming') label = 'Confirming on-chain…';
  else if (state.phase === 'completed') label = 'Purchase complete';
  else if (state.phase === 'failed') {
    label = FAILURE_MESSAGES[state.failureCode ?? ''] ?? state.error ?? 'Purchase failed.';
    // The wallet/RPC's own reason (revert message, rejected, network error) —
    // trimmed; the full error is in the browser console.
    if (state.errorDetail) label += ` — ${state.errorDetail.split('\n')[0].slice(0, 180)}`;
    // The wallet extension itself crashed or was updated mid-session (seen with Rabby/MetaMask).
    if (state.errorDetail && /extension context invalidated/i.test(state.errorDetail)) {
      label += ' Your wallet extension restarted: reload it, refresh this page and try again.';
    }
  }
  else label = '';

  const isError = state.phase === 'failed';
  const isDone = state.phase === 'completed';

  return (
    <div
      role="status"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '10px 12px',
        borderRadius: 10,
        marginBottom: 14,
        fontSize: 12.5,
        border: `1px solid ${isError ? 'rgba(226,125,96,0.4)' : isDone ? 'rgba(122,200,140,0.4)' : 'var(--line-soft, rgba(255,255,255,0.08))'}`,
        background: isError ? 'rgba(226,125,96,0.08)' : isDone ? 'rgba(122,200,140,0.08)' : 'var(--gold-tint, rgba(217,185,139,0.06))',
        color: isError ? '#E27D60' : isDone ? '#7AC88C' : 'var(--ink, #F6F3EC)',
      }}
    >
      {isError ? <AlertTriangle size={14} /> : isDone ? <CheckCircle2 size={14} /> : <Loader2 size={14} className="spin" />}
      <span>{label}</span>
      {!isError && !isDone && inputSymbol && state.phase === 'creating' && (
        <span style={{ marginLeft: 'auto', color: 'var(--ink-soft, #B4AEA2)' }}>from {inputSymbol}</span>
      )}
    </div>
  );
}

/**
 * Shown when LI.FI Composer refused the single-transaction route because of
 * price impact. Uses only the figures Composer reported. Continuing recompiles
 * the SAME single transaction with the accepted limit — a purchase never turns
 * into one transaction per asset. Nothing is signed until the buyer ticks the
 * box and continues.
 */
function PriceImpactConfirmation({
  notice,
  onContinue,
  onCancel,
}: {
  notice: ComposerFallbackNotice;
  onContinue: () => void;
  onCancel: () => void;
}) {
  const [understood, setUnderstood] = useState(false);
  const bps = notice.priceImpactBps ?? 0;
  const impactPct = (bps / 100).toFixed(2);
  const tooHigh = bps > MAX_ACCEPTABLE_PRICE_IMPACT_BPS;
  const loss =
    notice.inputUsd !== null && notice.outputUsd !== null ? Math.max(0, Number(notice.inputUsd) - Number(notice.outputUsd)) : null;

  return (
    <div role="alertdialog" aria-label="High price impact" style={{ marginBottom: 4 }}>
      <div
        style={{
          padding: '12px 14px',
          borderRadius: 10,
          border: '1px solid rgba(226,125,96,0.45)',
          background: 'rgba(226,125,96,0.08)',
          color: 'var(--ink)',
          fontSize: 12.5,
          lineHeight: 1.5,
          marginBottom: 12,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600, color: '#C8553A', marginBottom: 6 }}>
          <AlertTriangle size={14} />
          High price impact
          <span style={{ marginLeft: 'auto' }}>-{impactPct}%</span>
        </div>
        <p style={{ margin: 0 }}>
          {notice.inputUsd !== null && notice.outputUsd !== null ? (
            <>
              For this amount you would get back about <b>${Number(notice.outputUsd).toFixed(2)}</b> for <b>${Number(notice.inputUsd).toFixed(2)}</b>
              {loss !== null && (
                <>
                  {' '}
                  — you are losing about <b>${loss.toFixed(2)}</b>
                </>
              )}
              .
            </>
          ) : (
            <>The price impact for this amount is {impactPct}%.</>
          )}{' '}
          {tooHigh
            ? `That is above the ${MAX_ACCEPTABLE_PRICE_IMPACT_BPS / 100}% maximum, so this purchase can't go ahead. Try a smaller amount or a different composition.`
            : 'Try a different amount or composition, or continue anyway — it is still one transaction and one signature.'}
        </p>
      </div>
      {!tooHigh && (
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, marginBottom: 10, cursor: 'pointer' }}>
          <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} />I understand the risks and want to continue
        </label>
      )}
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          type="button"
          onClick={onCancel}
          style={{ ...primaryButtonStyle, flex: 1, background: 'transparent', color: 'var(--ink)', border: '1px solid var(--line-soft)' }}
        >
          Cancel
        </button>
        {!tooHigh && (
          <button
            type="button"
            onClick={onContinue}
            disabled={!understood}
            style={{ ...primaryButtonStyle, flex: 2, opacity: understood ? 1 : 0.5, cursor: understood ? 'pointer' : 'not-allowed' }}
          >
            Continue anyway
          </button>
        )}
      </div>
    </div>
  );
}
