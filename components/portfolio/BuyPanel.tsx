'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, Search } from 'lucide-react';
import { parseUnits } from 'viem';
import { formatRawAmount } from '@/lib/format';
import { describeWalletError } from '@/lib/blockchain/wallet-error';
import { executeWalletSweep, SweepProgress } from '@/lib/blockchain/wallet-sweep-client';
import { BAG_CHAINS, BAG_CHAINS_LIST, type BagChain } from '@/lib/config/chains';
import type { ComposerFallbackNotice } from '@/types/purchase-intent';
import { MAX_ACCEPTABLE_PRICE_IMPACT_BPS } from '@/types/purchase-intent';

// -----------------------------------------------------------------------------
// Buy side of the Swap page: pick one or several registry tokens on one chain,
// enter what to spend, and buy them all in ONE LI.FI Composer transaction
// (POST /api/wallet/buy-quote). Paying with ETH needs no approval: one
// signature. Paying with the stablecoin adds one exact-amount approval. The
// spend is split equally across the picked tokens; the tokens land in the
// same wallet. The server compiles; only the wallet signs.
// -----------------------------------------------------------------------------

interface RegistryAsset {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  logoUrl?: string | null;
}

interface BuyQuote {
  transaction: { to: string; data: string; value: string; chainId: number };
  approvals: { token: string; spender: string; amountRaw: string }[];
  payToken: { address: string; symbol: string; decimals: number; native: boolean };
  amountRaw: string;
  legs: { address: string; symbol: string; decimals: number; weightBps: number; expectedOutRaw: string | null; minOutRaw: string | null }[];
  priceImpactBps: number | null;
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'quoting' }
  | { kind: 'quoted'; quote: BuyQuote }
  | { kind: 'impact'; notice: ComposerFallbackNotice }
  | { kind: 'executing'; step: SweepProgress; quote: BuyQuote }
  | { kind: 'done'; txHash: string; quote: BuyQuote }
  | { kind: 'error'; message: string };

export const MAX_BUY_TOKENS = 12;

const PROGRESS: Record<SweepProgress, string> = {
  approving: 'Approve the exact amount in your wallet…',
  batching: 'Confirm the approval and the purchase in your wallet (one confirmation)…',
  simulating: 'Checking the transaction…',
  signing: 'Confirm the purchase in your wallet…',
  confirming: 'Confirming on-chain…',
};

/** Equal shares in bps summing to exactly 10000 (the remainder goes to the first tokens). */
export function equalShares(n: number): number[] {
  const base = Math.floor(10000 / n);
  return Array.from({ length: n }, (_, i) => base + (i < 10000 - base * n ? 1 : 0));
}

export function BuyPanel({ walletAddress }: { walletAddress: string }) {
  const [chain, setChain] = useState<BagChain>('robinhood');
  const [pay, setPay] = useState<'NATIVE' | 'STABLE'>('NATIVE');
  const [assets, setAssets] = useState<RegistryAsset[] | null>(null);
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [amount, setAmount] = useState('');
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [acceptImpact, setAcceptImpact] = useState(false);

  const cfg = BAG_CHAINS[chain];
  const payToken = pay === 'NATIVE' ? { symbol: cfg.nativeCurrency.symbol, decimals: cfg.nativeCurrency.decimals } : { symbol: cfg.sweepOutputToken.symbol, decimals: cfg.sweepOutputToken.decimals };
  const busy = phase.kind === 'quoting' || phase.kind === 'executing';

  useEffect(() => {
    let cancelled = false;
    setAssets(null);
    fetch(`/api/assets?chain=${chain}`)
      .then((r) => (r.ok ? r.json() : { assets: [] }))
      .then((b) => !cancelled && setAssets((b.assets ?? []) as RegistryAsset[]))
      .catch(() => !cancelled && setAssets([]));
    return () => {
      cancelled = true;
    };
  }, [chain]);

  const stable = cfg.sweepOutputToken.address.toLowerCase();
  const buyable = useMemo(
    () => (assets ?? []).filter((a) => /^0x[0-9a-fA-F]{40}$/.test(a.address) && !(pay === 'STABLE' && a.address.toLowerCase() === stable)),
    [assets, pay, stable]
  );
  const q = query.trim().toLowerCase();
  const shown = buyable.filter((a) => !q || a.symbol.toLowerCase().includes(q) || a.name.toLowerCase().includes(q)).slice(0, 60);
  const bySymbol = new Map(buyable.map((a) => [a.address, a] as const));

  let amountRaw: string | null = null;
  try {
    amountRaw = /^\d+(\.\d+)?$/.test(amount.trim()) ? parseUnits(amount.trim(), payToken.decimals).toString() : null;
    if (amountRaw !== null && BigInt(amountRaw) <= BigInt(0)) amountRaw = null;
  } catch {
    amountRaw = null;
  }

  const reset = () => {
    setPicked([]);
    setPhase({ kind: 'idle' });
  };

  const toggle = (address: string) =>
    setPicked((prev) => (prev.includes(address) ? prev.filter((a) => a !== address) : prev.length < MAX_BUY_TOKENS ? [...prev, address] : prev));

  const requestQuote = useCallback(
    async (acceptedPriceImpactBps?: number) => {
      if (!amountRaw || picked.length === 0) return;
      setAcceptImpact(false);
      setPhase({ kind: 'quoting' });
      const shares = equalShares(picked.length);
      try {
        const res = await fetch('/api/wallet/buy-quote', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chain,
            pay,
            amountRaw,
            buys: picked.map((address, i) => ({ address, weightBps: shares[i] })),
            ...(acceptedPriceImpactBps !== undefined ? { acceptedPriceImpactBps } : {}),
          }),
        });
        const body = await res.json().catch(() => null);
        if (res.status === 422 && body?.composerFallback) {
          setPhase({ kind: 'impact', notice: body.composerFallback as ComposerFallbackNotice });
          return;
        }
        if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status}).`);
        setPhase({ kind: 'quoted', quote: body as BuyQuote });
      } catch (err) {
        setPhase({ kind: 'error', message: (err as Error).message });
      }
    },
    [amountRaw, picked, chain, pay]
  );

  const confirm = useCallback(
    async (quote: BuyQuote) => {
      setPhase({ kind: 'executing', step: 'simulating', quote });
      try {
        const hash = await executeWalletSweep(walletAddress, quote, (step) => setPhase({ kind: 'executing', step, quote }));
        setPhase({ kind: 'done', txHash: hash, quote });
      } catch (err) {
        const { message, rejected } = describeWalletError(err);
        setPhase({ kind: 'error', message: rejected ? 'You rejected the request in your wallet.' : message });
      }
    },
    [walletAddress]
  );

  const legOut = (l: BuyQuote['legs'][number]) => (l.expectedOutRaw === null ? '—' : `${formatRawAmount(l.expectedOutRaw, l.decimals, { maxFractionDigits: 6 })} ${l.symbol}`);

  return (
    <div style={{ marginTop: 32 }}>
      <div className="sweep-chains" role="tablist" aria-label="Network">
        {BAG_CHAINS_LIST.map((c) => (
          <button
            key={c}
            role="tab"
            aria-selected={c === chain}
            className={c === chain ? 'sweep-chain active' : 'sweep-chain'}
            disabled={busy}
            onClick={() => {
              setChain(c);
              reset();
            }}
          >
            <span>{BAG_CHAINS[c].name}</span>
          </button>
        ))}
      </div>

      <div className="sweep-receive" role="radiogroup" aria-label="Pay with">
        <span>Pay with</span>
        {(['NATIVE', 'STABLE'] as const).map((p) => (
          <button
            key={p}
            role="radio"
            aria-checked={pay === p}
            className={pay === p ? 'sweep-chain active' : 'sweep-chain'}
            disabled={busy}
            onClick={() => {
              setPay(p);
              reset();
            }}
          >
            {p === 'NATIVE' ? cfg.nativeCurrency.symbol : cfg.sweepOutputToken.symbol}
          </button>
        ))}
        <span style={{ color: 'var(--mute)' }}>{pay === 'NATIVE' ? 'No approval — one signature.' : 'One exact-amount approval, then the purchase.'}</span>
      </div>

      <div className="leaderboard-card" style={{ padding: 16 }}>
        <label style={{ display: 'block', fontSize: 12.5, color: 'var(--ink-soft)', marginBottom: 6 }} htmlFor="buy-amount">
          You spend ({payToken.symbol})
        </label>
        <input
          id="buy-amount"
          className="buy-input mono"
          inputMode="decimal"
          placeholder="0.0"
          value={amount}
          disabled={busy}
          onChange={(e) => setAmount(e.target.value.replace(',', '.'))}
          style={{ width: '100%', maxWidth: 260 }}
        />

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '16px 0 8px' }}>
          <Search size={14} aria-hidden="true" />
          <input
            className="buy-input"
            placeholder={`Search tokens on ${cfg.name}`}
            aria-label="Search tokens"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{ flex: 1 }}
          />
        </div>

        {assets === null ? (
          <p style={{ fontSize: 13, color: 'var(--ink-soft)' }}>Loading tokens…</p>
        ) : buyable.length === 0 ? (
          <p style={{ fontSize: 13, color: 'var(--ink-soft)' }}>No tokens are listed on {cfg.name} yet.</p>
        ) : (
          <ul className="buy-token-list">
            {shown.map((a) => (
              <li key={a.address}>
                <label>
                  <input
                    type="checkbox"
                    aria-label={`Buy ${a.symbol}`}
                    checked={picked.includes(a.address)}
                    disabled={busy || (!picked.includes(a.address) && picked.length >= MAX_BUY_TOKENS)}
                    onChange={() => toggle(a.address)}
                  />
                  <span style={{ fontWeight: 600 }}>{a.symbol}</span>
                  <span style={{ fontSize: 11.5, color: 'var(--mute)' }}>{a.name}</span>
                </label>
              </li>
            ))}
          </ul>
        )}

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginTop: 12, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12.5, color: 'var(--ink-soft)' }}>
            {picked.length === 0 ? 'Pick up to 12 tokens.' : `${picked.map((p) => bySymbol.get(p)?.symbol ?? '?').join(', ')} — split equally.`}
          </span>
          <button className="btn btn-primary" disabled={busy || picked.length === 0 || !amountRaw} onClick={() => requestQuote()}>
            Buy {picked.length > 0 ? `${picked.length} token${picked.length === 1 ? '' : 's'}` : ''} with {payToken.symbol}
          </button>
        </div>
      </div>

      {phase.kind !== 'idle' && (
        <div className="leaderboard-card" style={{ marginTop: 14, padding: 16 }} role="status">
          {phase.kind === 'quoting' && (
            <p style={{ margin: 0, fontSize: 13.5 }}>
              <Loader2 size={14} className="animate-spin" style={{ verticalAlign: '-2px' }} /> Finding the best route…
            </p>
          )}

          {(phase.kind === 'quoted' || phase.kind === 'executing') && (
            <>
              <div style={{ fontWeight: 600, marginBottom: 8 }}>
                Spend {formatRawAmount(phase.quote.amountRaw, phase.quote.payToken.decimals, { maxFractionDigits: 6 })} {phase.quote.payToken.symbol} in one transaction
              </div>
              <table className="positions-table" style={{ marginBottom: 10 }}>
                <tbody>
                  {phase.quote.legs.map((l) => (
                    <tr key={l.address}>
                      <td>{l.symbol}</td>
                      <td className="mono">{(l.weightBps / 100).toFixed(2)}%</td>
                      <td className="mono">≈ {legOut(l)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div style={{ fontSize: 13, color: 'var(--ink-soft)', display: 'grid', gap: 4 }}>
                <div>Each swap has an on-chain minimum; below it the whole purchase reverts.</div>
                {phase.quote.priceImpactBps !== null && <div>Price impact: {(phase.quote.priceImpactBps / 100).toFixed(2)}%</div>}
                {phase.quote.approvals.length === 0 ? <div>No approval needed: one signature.</div> : <div>One exact-amount approval first, then the purchase.</div>}
              </div>
              {phase.kind === 'quoted' ? (
                <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
                  <button className="btn btn-primary" onClick={() => confirm(phase.quote)}>
                    Confirm purchase
                  </button>
                  <button className="btn btn-ghost" onClick={() => setPhase({ kind: 'idle' })}>
                    Cancel
                  </button>
                </div>
              ) : (
                <p style={{ margin: '12px 0 0', fontSize: 13.5 }}>
                  <Loader2 size={14} className="animate-spin" style={{ verticalAlign: '-2px' }} /> {PROGRESS[phase.step]}
                </p>
              )}
            </>
          )}

          {phase.kind === 'impact' && (
            <>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>High price impact</div>
              <p style={{ margin: '0 0 8px', fontSize: 13 }}>{phase.notice.message}</p>
              {phase.notice.priceImpactBps !== null && phase.notice.priceImpactBps <= MAX_ACCEPTABLE_PRICE_IMPACT_BPS ? (
                <>
                  <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
                    <input type="checkbox" checked={acceptImpact} onChange={(e) => setAcceptImpact(e.target.checked)} />I accept a {(phase.notice.priceImpactBps / 100).toFixed(2)}% price impact
                  </label>
                  <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
                    <button className="btn btn-primary" disabled={!acceptImpact} onClick={() => requestQuote(phase.notice.priceImpactBps ?? undefined)}>
                      Continue anyway
                    </button>
                    <button className="btn btn-ghost" onClick={() => setPhase({ kind: 'idle' })}>
                      Cancel
                    </button>
                  </div>
                </>
              ) : (
                <p style={{ margin: 0, fontSize: 13, color: '#E0847A' }}>Above {MAX_ACCEPTABLE_PRICE_IMPACT_BPS / 100}% — try a smaller amount.</p>
              )}
            </>
          )}

          {phase.kind === 'done' && (
            <p style={{ margin: 0, fontSize: 13.5, color: 'var(--emerald)' }}>
              Bought. The tokens are in your wallet.{' '}
              <a href={`${cfg.explorerUrl}/tx/${phase.txHash}`} target="_blank" rel="noreferrer">
                View transaction →
              </a>
            </p>
          )}

          {phase.kind === 'error' && (
            <p style={{ margin: 0, fontSize: 13.5, color: '#E0847A' }}>
              {phase.message}{' '}
              <button onClick={() => setPhase({ kind: 'idle' })} style={{ background: 'none', border: 'none', color: 'inherit', textDecoration: 'underline', cursor: 'pointer' }}>
                Dismiss
              </button>
            </p>
          )}
        </div>
      )}
    </div>
  );
}
