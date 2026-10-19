'use client';

import { useEffect, useRef, useState } from 'react';
import { Scale, CheckCircle2, AlertTriangle, Loader2 } from 'lucide-react';
import { formatDecimalStringUsd, formatRawAmount, formatRawAmountUsd, parseDecimalToRaw } from '@/lib/format';
import type { PositionRebalancePreview } from '@/lib/domain/basket-protocol/rebalance/position-rebalance';
import { useWallet } from '@/lib/wallet-context';
import { executeWalletSweep, type SweepProgress } from '@/lib/blockchain/wallet-sweep-client';
import { describeWalletError } from '@/lib/blockchain/wallet-error';

// -----------------------------------------------------------------------------
// The signed-in investor's allocation in this strategy against its current
// version (R1, GET /api/bags/:id/rebalance-preview), a live quote of the
// rebalance (R2), and the rebalance itself (R3): BAG records the plan as an
// intent, the wallet signs ONE Composer transaction (approvals batched into the
// same confirmation where the wallet can), and BAG books it from the receipt.
// No creator fee. Renders nothing for a visitor without a position.
// -----------------------------------------------------------------------------

interface Response {
  symbols: Record<string, string>;
  preview: PositionRebalancePreview;
}

interface QuoteLeg {
  address: string;
  symbol: string;
  decimals: number;
  amountRaw: string | null;
  expectedOutRaw: string | null;
  minOutRaw: string | null;
}

interface Quote {
  sells: QuoteLeg[];
  buys: QuoteLeg[];
  slippageBps: number;
  priceImpactBps: number | null;
}

interface IntentView {
  id: string;
  status: 'READY' | 'SUBMITTED' | 'SUCCEEDED' | 'FAILED' | 'EXPIRED';
  expiresAt: string;
  failureMessage: string | null;
  composerTransaction: { to: string; data: string; value: string; chainId: number; approvals: { token: string; spender: string; amountRaw: string }[] } | null;
}

type RunPhase = 'idle' | 'planning' | 'wallet' | 'confirming' | 'done';

const pct = (bps: number) => `${(bps / 100).toFixed(1)}%`;

/** Below this much to sell, a rebalance is not worth a transaction (and the buys round to nothing). */
export const MIN_REBALANCE_USD = '1';
const usdUnits = (value: string) => BigInt(parseDecimalToRaw(value, 18) ?? '0');
/** The USD value the plan would sell, and whether that is too small to offer a rebalance at all. */
export function rebalanceSize(preview: { orders: { side: string; value: string }[] }): { sellUsd: bigint; tooSmall: boolean } {
  const sells = preview.orders.filter((o) => o.side === 'SELL');
  const buys = preview.orders.filter((o) => o.side === 'BUY');
  const sellUsd = sells.reduce((sum, o) => sum + usdUnits(o.value), BigInt(0));
  return { sellUsd, tooSmall: sells.length === 0 || buys.length === 0 || sellUsd < usdUnits(MIN_REBALANCE_USD) };
}
const VERIFY_POLL_MS = 3000;
const VERIFY_ATTEMPTS = 60;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A refused request; `acceptablePriceImpactBps` is set when the investor may accept the measured price impact. */
class RequestError extends Error {
  constructor(message: string, readonly acceptablePriceImpactBps: number | null) {
    super(message);
  }
}

async function postJson<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json().catch(() => ({}))) as { error?: string; acceptablePriceImpactBps?: unknown };
  if (!res.ok) {
    const acceptable = typeof json.acceptablePriceImpactBps === 'number' ? json.acceptablePriceImpactBps : null;
    throw new RequestError(json.error ?? 'Request failed.', acceptable);
  }
  return json as T;
}

export function RebalancePreviewCard({
  bagId,
  refreshKey,
  onRebalanced,
  autoRunVersion,
}: {
  bagId: string;
  refreshKey?: string | number;
  onRebalanced?: () => void;
  /**
   * Set right after the creator saved this version: once the preview targets it and a rebalance is needed, the
   * rebalance starts by itself (plan → the wallet asks for the signature). Once per version; a price impact above
   * the limit still stops and asks.
   */
  autoRunVersion?: number;
}) {
  const { authUser } = useWallet();
  const [data, setData] = useState<Response | null>(null);
  const [phase, setPhase] = useState<RunPhase>('idle');
  const [walletStep, setWalletStep] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  // A price impact above the default limit but within what may be accepted (10%): shown, and used only if the
  // investor presses "Rebalance anyway". Never applied silently.
  const [impactOffer, setImpactOffer] = useState<number | null>(null);
  const [acceptedImpact, setAcceptedImpact] = useState<number | null>(null);

  const getQuote = async (accept: number | null = acceptedImpact) => {
    setQuoting(true);
    setQuoteError(null);
    try {
      const body = await postJson<Quote>(`/api/bags/${encodeURIComponent(bagId)}/rebalance-quote`, accept !== null ? { acceptedPriceImpactBps: accept } : undefined);
      setQuote(body);
    } catch (err) {
      setQuote(null);
      setQuoteError((err as Error).message);
      if (err instanceof RequestError && err.acceptablePriceImpactBps !== null) setImpactOffer(err.acceptablePriceImpactBps);
    } finally {
      setQuoting(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/bags/${encodeURIComponent(bagId)}/rebalance-preview`, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => !cancelled && setData(d))
      .catch(() => !cancelled && setData(null));
    return () => {
      cancelled = true;
    };
  }, [bagId, refreshKey, reloadKey]);

  /** Plan → wallet signs the one transaction → BAG verifies it on-chain and books it. */
  const runRebalance = async (accept: number | null = acceptedImpact) => {
    const walletAddress = authUser?.walletAddress;
    if (!walletAddress) {
      setRunError('Sign in with your wallet first.');
      return;
    }
    setRunError(null);
    setPhase('planning');
    try {
      const { intent } = await postJson<{ intent: IntentView }>(
        `/api/bags/${encodeURIComponent(bagId)}/rebalance-intent`,
        accept !== null ? { acceptedPriceImpactBps: accept } : undefined
      );
      const tx = intent.composerTransaction;
      if (!tx || Date.parse(intent.expiresAt) <= Date.now()) throw new Error('This rebalance can no longer be signed. Try again.');
      const verifyUrl = `/api/rebalance-intent/${encodeURIComponent(intent.id)}/verify`;
      setPhase('wallet');
      const stepLabel: Record<SweepProgress, string> = {
        approving: 'Approve each token in your wallet…',
        batching: 'Confirm the rebalance in your wallet (approvals and swaps in one confirmation)…',
        simulating: 'Checking the transaction…',
        signing: 'Confirm the rebalance in your wallet…',
        confirming: 'Waiting for the transaction…',
      };
      await executeWalletSweep(
        walletAddress,
        { transaction: tx, approvals: tx.approvals },
        (step) => setWalletStep(stepLabel[step]),
        {
          onApproval: (index, total) => setWalletStep(`Approval ${index} of ${total} in your wallet…`),
          onSubmitted: (txHash) => postJson(verifyUrl, { txHash }),
        }
      );
      setPhase('confirming');
      setWalletStep('Confirming on-chain and updating your position…');
      for (let attempt = 0; attempt < VERIFY_ATTEMPTS; attempt++) {
        const { intent: now } = await postJson<{ intent: IntentView }>(verifyUrl).catch(() => ({ intent: null as IntentView | null }));
        if (now?.status === 'SUCCEEDED') {
          setPhase('done');
          setWalletStep(null);
          setQuote(null);
          setReloadKey((k) => k + 1);
          onRebalanced?.();
          return;
        }
        if (now?.status === 'FAILED' || now?.status === 'EXPIRED') throw new Error(now.failureMessage ?? 'The rebalance did not go through. Nothing was booked.');
        await sleep(VERIFY_POLL_MS);
      }
      throw new Error('Still confirming. Your position updates as soon as the transaction is confirmed.');
    } catch (err) {
      if (err instanceof RequestError) {
        setRunError(err.message);
        if (err.acceptablePriceImpactBps !== null) setImpactOffer(err.acceptablePriceImpactBps);
      } else {
        setRunError(describeWalletError(err).message ?? (err as Error).message);
      }
      setPhase('idle');
      setWalletStep(null);
    }
  };

  const autoRanRef = useRef<number | null>(null);
  useEffect(() => {
    if (autoRunVersion === undefined || autoRanRef.current === autoRunVersion) return;
    if (!data || data.preview.status !== 'OK' || data.preview.targetVersion < autoRunVersion) return;
    if (!data.preview.requiresRebalance || rebalanceSize(data.preview).tooSmall || phase !== 'idle') return;
    autoRanRef.current = autoRunVersion;
    void runRebalance();
    // Runs once per saved version, when the preview for it has loaded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRunVersion, data, phase]);

  const acceptImpact = () => {
    if (impactOffer === null) return;
    const accept = impactOffer;
    setAcceptedImpact(accept);
    setImpactOffer(null);
    setRunError(null);
    setQuoteError(null);
    void runRebalance(accept);
  };

  if (!data || data.preview.status === 'NO_POSITION') return null;
  const { preview, symbols } = data;
  const label = (chain: string, address: string, fallback: string) => symbols[`${chain}:${address.toLowerCase()}`] ?? fallback;

  if (preview.status !== 'OK') {
    return (
      <div className="rounded-xl border border-white/10 bg-white/5 p-6">
        <h3 className="text-lg font-bold text-white mb-1 flex items-center gap-2">
          <Scale size={18} /> Your allocation
        </h3>
        <p className="text-sm text-white/50">
          {preview.status === 'UNREADABLE_BALANCES'
            ? 'Your wallet balances could not be read right now, so your allocation is not shown.'
            : 'A verified price is missing for one of your assets, so your allocation is not shown.'}
        </p>
      </div>
    );
  }

  const sells = preview.orders.filter((o) => o.side === 'SELL');
  const buys = preview.orders.filter((o) => o.side === 'BUY');
  const size = rebalanceSize(preview);

  return (
    <div className="rounded-xl border border-white/10 bg-white/5 p-6">
      <h3 className="text-lg font-bold text-white mb-1 flex items-center gap-2">
        <Scale size={18} /> Your allocation vs. strategy v{preview.targetVersion}
      </h3>
      <p className="text-sm text-white/60 mb-4">
        What your wallet holds for this strategy, at verified prices, against the current version&apos;s target weights.
      </p>
      <table className="w-full text-sm mb-4">
        <thead>
          <tr className="text-white/40 text-xs text-left">
            <th className="font-normal pb-1">Asset</th>
            <th className="font-normal pb-1 text-right">Target</th>
            <th className="font-normal pb-1 text-right">Yours</th>
            <th className="font-normal pb-1 text-right">Drift</th>
          </tr>
        </thead>
        <tbody>
          {preview.allocations.map((a) => (
            <tr key={`${a.asset.chain}:${a.asset.address}`} className="text-white/80">
              <td className="py-0.5">{label(a.asset.chain, a.asset.address, a.symbol)}</td>
              <td className="py-0.5 text-right">{pct(a.targetWeightBps)}</td>
              <td className="py-0.5 text-right">{pct(a.currentWeightBps)}</td>
              <td className={`py-0.5 text-right ${Math.abs(a.driftBps) > preview.driftThresholdBps ? 'text-amber-400' : 'text-white/50'}`}>
                {a.driftBps > 0 ? '+' : ''}
                {pct(a.driftBps)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {preview.requiresRebalance && size.tooSmall ? (
        <p className="text-sm text-white/60" data-testid="rebalance-too-small">
          What your wallet holds for this strategy is worth {formatRawAmountUsd(size.sellUsd.toString(), 18)} to move,
          under ${MIN_REBALANCE_USD}: too little to rebalance. Buy into the Bag to hold strategy v{preview.targetVersion}.
        </p>
      ) : preview.requiresRebalance ? (
        <div className="text-sm">
          <p className="text-amber-400 inline-flex items-center gap-1 mb-2">
            <AlertTriangle size={14} /> Drift of {pct(preview.maxAbsDriftBps)} is beyond this strategy&apos;s {pct(preview.driftThresholdBps)} threshold.
          </p>
          <p className="text-white/60">
            A rebalance would sell{' '}
            {sells.map((o, i) => (
              <span key={o.asset.address}>
                {i > 0 ? ', ' : ''}
                {formatDecimalStringUsd(o.value)} of {label(o.asset.chain, o.asset.address, o.symbol)}
              </span>
            ))}{' '}
            and buy{' '}
            {buys.map((o, i) => (
              <span key={o.asset.address}>
                {i > 0 ? ', ' : ''}
                {formatDecimalStringUsd(o.value)} of {label(o.asset.chain, o.asset.address, o.symbol)}
              </span>
            ))}
            , in your own wallet, with no creator fee.
          </p>
          <button onClick={() => void getQuote()} disabled={quoting} className="btn btn-primary mt-3">
            {quoting ? (
              <span className="inline-flex items-center gap-2">
                <Loader2 size={14} className="spin" /> Getting a live quote…
              </span>
            ) : (
              'Get a live rebalance quote'
            )}
          </button>
          {quoteError && <p className="mt-2 text-red-400">{quoteError}</p>}
          <button onClick={() => void runRebalance()} disabled={phase !== 'idle' && phase !== 'done'} className="btn btn-primary mt-3 ml-2">
            {phase === 'idle' || phase === 'done' ? (
              'Rebalance now'
            ) : (
              <span className="inline-flex items-center gap-2">
                <Loader2 size={14} className="spin" /> {phase === 'planning' ? 'Planning…' : 'Rebalancing…'}
              </span>
            )}
          </button>
          {walletStep && <p className="mt-2 text-white/70">{walletStep}</p>}
          {runError && <p className="mt-2 text-red-400">{runError}</p>}
          {impactOffer !== null && phase === 'idle' && (
            <div data-testid="rebalance-impact-offer" className="mt-3 rounded-lg border border-amber-400/40 p-3 text-white/70">
              <p className="mb-2">
                Composer measures a {(impactOffer / 100).toFixed(2)}% price impact for this rebalance: you would get about that much less value
                than the tokens are worth at market prices. You can go ahead (at most {(Math.min(impactOffer + 100, 1000) / 100).toFixed(2)}% is allowed on the
                retry), or wait for deeper liquidity.
              </p>
              <button onClick={acceptImpact} className="btn btn-secondary">
                Rebalance anyway at {(impactOffer / 100).toFixed(2)}% impact
              </button>
            </div>
          )}
          {phase === 'done' && (
            <p className="mt-2 text-emerald-400 inline-flex items-center gap-1">
              <CheckCircle2 size={14} /> Rebalanced. Your position now follows strategy v{preview.targetVersion}.
            </p>
          )}
          {quote && (
            <div className="mt-3 rounded-lg border border-white/10 p-3 text-white/70">
              <p className="mb-1">
                Sell{' '}
                {quote.sells.map((l, i) => (
                  <span key={l.address}>
                    {i > 0 ? ', ' : ''}
                    {l.amountRaw ? formatRawAmount(l.amountRaw, l.decimals) : '?'} {l.symbol}
                  </span>
                ))}
              </p>
              <p className="mb-1">
                Receive about{' '}
                {quote.buys.map((l, i) => (
                  <span key={l.address}>
                    {i > 0 ? ', ' : ''}
                    {l.expectedOutRaw ? formatRawAmount(l.expectedOutRaw, l.decimals) : '?'} {l.symbol}
                    {l.minOutRaw ? ` (at least ${formatRawAmount(l.minOutRaw, l.decimals)})` : ''}
                  </span>
                ))}
              </p>
              <p className="text-xs text-white/50">
                One LI.FI Composer transaction, {quote.slippageBps / 100}% max slippage per swap
                {quote.priceImpactBps !== null ? `, ${(quote.priceImpactBps / 100).toFixed(2)}% price impact` : ''}. &quot;Rebalance now&quot;
                plans it again at live prices; your wallet shows exactly what it signs.
              </p>
            </div>
          )}
        </div>
      ) : (
        <p className="text-sm text-emerald-400 inline-flex items-center gap-1">
          <CheckCircle2 size={14} /> Within this strategy&apos;s {pct(preview.driftThresholdBps)} drift threshold (largest drift {pct(preview.maxAbsDriftBps)}).
        </p>
      )}
    </div>
  );
}
