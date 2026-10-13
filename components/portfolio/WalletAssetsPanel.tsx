'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, RefreshCw, Wallet } from 'lucide-react';
import { formatDecimalString, formatDecimalStringUsd, formatRawAmount } from '@/lib/format';
import { describeWalletError } from '@/lib/blockchain/wallet-error';
import { executeWalletSweep, SweepProgress } from '@/lib/blockchain/wallet-sweep-client';
import type { ChainHoldingsResult, WalletHoldings, WalletTokenBalance } from '@/lib/server/wallet-holdings';
import { BAG_CHAINS, BAG_CHAINS_LIST, type BagChain } from '@/lib/config/chains';
import type { ComposerFallbackNotice } from '@/types/purchase-intent';
import { MAX_ACCEPTABLE_PRICE_IMPACT_BPS } from '@/types/purchase-intent';

// -----------------------------------------------------------------------------
// The wallet's tokens on every BAG chain (Robinhood Chain, Ethereum, Arbitrum,
// Base), read from the chain, one tab per chain with its total. Selling any of
// them — one, or several at once like a dust sweeper — happens on that chain,
// for that chain's stablecoin (USDG on Robinhood Chain, USDC elsewhere), in ONE
// LI.FI Composer transaction. Used by the Swap page and Portfolio's Wallet section.
// -----------------------------------------------------------------------------

interface SweepQuote {
  transaction: { to: string; data: string; value: string; chainId: number };
  approvals: { token: string; spender: string; amountRaw: string }[];
  legs: { address: string; symbol: string; amountRaw: string; decimals: number; expectedOutRaw: string | null; minOutRaw: string | null }[];
  outputToken: { address: string; symbol: string; decimals: number; native?: boolean };
  expectedOutRaw: string | null;
  minOutRaw: string | null;
  priceImpactBps: number | null;
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'quoting' }
  | { kind: 'quoted'; quote: SweepQuote; acceptedPriceImpactBps?: number }
  | { kind: 'impact'; notice: ComposerFallbackNotice }
  | { kind: 'executing'; step: SweepProgress; quote: SweepQuote; approval?: { index: number; total: number; symbol: string | null } }
  | { kind: 'done'; txHash: string; received: string | null }
  | { kind: 'error'; message: string };

const MAX_SWEEP_TOKENS = 12;
const PROGRESS_LABEL: Record<SweepProgress, string> = {
  approving: 'Approve each token in your wallet…',
  batching: 'Confirm the approvals and the sale in your wallet (one confirmation)…',
  simulating: 'Checking the transaction…',
  signing: 'Confirm the sale in your wallet…',
  confirming: 'Confirming on-chain…',
};

function explorerTx(chain: BagChain, hash: string) {
  return `${BAG_CHAINS[chain].explorerUrl}/tx/${hash}`;
}

const isHoldings = (r: ChainHoldingsResult): r is WalletHoldings => !('error' in r);
const chainTotal = (h: WalletHoldings) => h.tokens.reduce((sum, t) => sum + Number(t.usdValue ?? 0), 0);

export function WalletAssetsPanel({ walletAddress }: { walletAddress: string }) {
  const [all, setAll] = useState<ChainHoldingsResult[] | null>(null);
  const [active, setActive] = useState<BagChain>('robinhood');
  // What the sale pays out: the chain's stablecoin, or its native ETH (then the stablecoin can be sold too).
  const [receive, setReceive] = useState<'STABLE' | 'NATIVE'>('STABLE');
  const [lastOut, setLastOut] = useState<{ symbol: string; decimals: number } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [acceptImpact, setAcceptImpact] = useState(false);
  // The exact token list being quoted, so accepting a price impact re-quotes the same sale.
  const [pending, setPending] = useState<WalletTokenBalance[]>([]);

  const load = useCallback(() => {
    setLoading(true);
    setLoadError(null);
    fetch('/api/wallet/holdings?chain=all', { credentials: 'same-origin' })
      .then(async (res) => {
        const body = await res.json().catch(() => null);
        if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status}).`);
        return body.chains as ChainHoldingsResult[];
      })
      .then((chains) => {
        setAll(chains);
        setSelected(new Set());
        // First load: open the chain holding the most value (Robinhood Chain when nothing is held).
        setActive((current) => {
          if (chains.some((c) => c.chain === current && isHoldings(c) && c.tokens.length > 0)) return current;
          const best = chains.filter(isHoldings).sort((a, b) => chainTotal(b) - chainTotal(a))[0];
          return best && chainTotal(best) > 0 ? best.chain : current;
        });
      })
      .catch((err: Error) => setLoadError(err.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load, walletAddress]);

  const activeResult = all?.find((c) => c.chain === active) ?? null;
  const holdings = activeResult && isHoldings(activeResult) ? activeResult : null;
  const chainError = activeResult && !isHoldings(activeResult) ? activeResult.error : null;
  const chainName = BAG_CHAINS[active].name;
  const tokens = holdings?.tokens ?? [];
  const grandTotal = (all ?? []).filter(isHoldings).reduce((sum, h) => sum + chainTotal(h), 0);
  const canSell = (t: WalletTokenBalance) => t.sellable || receive === 'NATIVE';
  const sellable = tokens.filter(canSell);
  const totalUsd = tokens.reduce((sum, t) => sum + Number(t.usdValue ?? 0), 0);
  const selectedTokens = useMemo(() => sellable.filter((t) => selected.has(t.address)), [sellable, selected]);
  const selectedUsd = selectedTokens.reduce((sum, t) => sum + Number(t.usdValue ?? 0), 0);
  const busy = phase.kind === 'quoting' || phase.kind === 'executing';

  const requestQuote = useCallback(async (list: WalletTokenBalance[], acceptedPriceImpactBps?: number) => {
    setPending(list);
    setAcceptImpact(false);
    setPhase({ kind: 'quoting' });
    try {
      const res = await fetch('/api/wallet/sweep-quote', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chain: active,
          receive,
          tokens: list.map((t) => ({ address: t.address, amountRaw: t.balanceRaw })),
          ...(acceptedPriceImpactBps !== undefined ? { acceptedPriceImpactBps } : {}),
        }),
      });
      const body = await res.json().catch(() => null);
      if (res.status === 422 && body?.composerFallback) {
        setPhase({ kind: 'impact', notice: body.composerFallback as ComposerFallbackNotice });
        return;
      }
      if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status}).`);
      setLastOut({ symbol: (body as SweepQuote).outputToken.symbol, decimals: (body as SweepQuote).outputToken.decimals });
      setPhase({ kind: 'quoted', quote: body as SweepQuote, acceptedPriceImpactBps });
    } catch (err) {
      setPhase({ kind: 'error', message: (err as Error).message });
    }
  }, [active, receive]);

  const confirm = useCallback(
    async (quote: SweepQuote) => {
      setPhase({ kind: 'executing', step: 'simulating', quote });
      try {
        const hash = await executeWalletSweep(walletAddress, quote, (step) => setPhase({ kind: 'executing', step, quote }), {
          // Wallets without batching (Rabby): one confirmation per approval still missing, then the sale.
          onApproval: (index, total, token) =>
            setPhase({
              kind: 'executing',
              step: 'approving',
              quote,
              approval: { index, total, symbol: quote.legs.find((l) => l.address.toLowerCase() === token.toLowerCase())?.symbol ?? null },
            }),
        });
        setPhase({ kind: 'done', txHash: hash, received: quote.expectedOutRaw });
        load();
      } catch (err) {
        const { message, rejected } = describeWalletError(err);
        setPhase({ kind: 'error', message: rejected ? 'You rejected the request in your wallet.' : message });
      }
    },
    [walletAddress, load]
  );

  const toggle = (address: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(address)) next.delete(address);
      else if (next.size < MAX_SWEEP_TOKENS) next.add(address);
      return next;
    });

  const out = holdings?.outputToken;
  const stableSymbol = out?.symbol ?? BAG_CHAINS[active].sweepOutputToken.symbol;
  const nativeSymbol = BAG_CHAINS[active].nativeCurrency.symbol;
  const outSymbol = receive === 'NATIVE' ? nativeSymbol : stableSymbol;
  const shownOut = lastOut ?? out;
  const fmtOut = (raw: string | null) =>
    raw === null || !shownOut ? '—' : `${formatRawAmount(raw, shownOut.decimals, { maxFractionDigits: shownOut.decimals > 6 ? 6 : 2 })} ${shownOut.symbol}`;

  return (
    <div style={{ marginTop: 40 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <span className="section-label">
          <Wallet size={13} style={{ verticalAlign: '-2px', marginRight: 6 }} />
          Wallet · {chainName}
        </span>
        <button className="btn btn-ghost" onClick={load} disabled={loading || busy} style={{ padding: '6px 12px', fontSize: 12.5 }}>
          <RefreshCw size={13} className={loading ? 'animate-spin' : undefined} /> Refresh
        </button>
      </div>
      <p style={{ color: 'var(--ink-soft)', fontSize: 13, margin: '6px 0 14px' }}>
        Tokens in your wallet, read from each chain. Select several to sell them all for {outSymbol} on {chainName} in one transaction.
      </p>

      {all && (
        <div className="sweep-chains" role="tablist" aria-label="Network">
          {BAG_CHAINS_LIST.map((c) => {
            const r = all.find((x) => x.chain === c);
            const total = r && isHoldings(r) ? chainTotal(r) : null;
            return (
              <button
                key={c}
                role="tab"
                aria-selected={c === active}
                className={c === active ? 'sweep-chain active' : 'sweep-chain'}
                disabled={busy}
                onClick={() => {
                  setActive(c);
                  setSelected(new Set());
                  setPhase({ kind: 'idle' });
                }}
              >
                <span>{BAG_CHAINS[c].name}</span>
                <span className="mono">{total === null ? '—' : formatDecimalStringUsd(total.toFixed(2))}</span>
              </button>
            );
          })}
          <span className="sweep-chains-total mono">All networks {formatDecimalStringUsd(grandTotal.toFixed(2))}</span>
        </div>
      )}

      {all && (
        <div className="sweep-receive" role="radiogroup" aria-label="Receive">
          <span>Receive</span>
          {(['STABLE', 'NATIVE'] as const).map((r) => (
            <button
              key={r}
              role="radio"
              aria-checked={receive === r}
              className={receive === r ? 'sweep-chain active' : 'sweep-chain'}
              disabled={busy}
              onClick={() => {
                setReceive(r);
                setSelected(new Set());
                setPhase({ kind: 'idle' });
              }}
            >
              {r === 'STABLE' ? stableSymbol : nativeSymbol}
            </button>
          ))}
        </div>
      )}

      {active === 'ethereum' && (
        <p style={{ color: 'var(--ink-soft)', fontSize: 12.5, margin: '0 0 12px' }}>
          Network fees on Ethereum can be higher than small balances are worth. Check the fee in your wallet before you confirm.
        </p>
      )}

      {chainError && <p style={{ color: '#E0847A', fontSize: 13 }}>Could not read your wallet on {chainName}: {chainError}</p>}

      {loadError && (
        <p style={{ color: '#E0847A', fontSize: 13 }}>
          Could not read your wallet: {loadError}{' '}
          <button onClick={load} style={{ background: 'none', border: 'none', color: 'inherit', textDecoration: 'underline', cursor: 'pointer' }}>
            Retry
          </button>
        </p>
      )}

      {all === null && !loadError ? (
        <p style={{ color: 'var(--ink-soft)', fontSize: 13.5 }}>Reading your wallet…</p>
      ) : holdings && tokens.length === 0 ? (
        <div className="leaderboard-card" style={{ padding: 24, textAlign: 'center', color: 'var(--ink-soft)', fontSize: 13.5 }}>
          No supported tokens in this wallet on {chainName}. {BAG_CHAINS[active].nativeCurrency.symbol} balance:{' '}
          {formatDecimalString(holdings.nativeBalance, { maxFractionDigits: 5 })}
        </div>
      ) : holdings ? (
        <div className="leaderboard-card">
          <table className="positions-table">
            <thead>
              <tr>
                <th style={{ width: 28 }} />
                <th>Token</th>
                <th>Balance</th>
                <th>Price</th>
                <th>Value</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {tokens.map((t) => (
                <tr key={t.address}>
                  <td>
                    {canSell(t) && (
                      <input
                        type="checkbox"
                        aria-label={`Select ${t.symbol}`}
                        checked={selected.has(t.address)}
                        disabled={busy || (!selected.has(t.address) && selected.size >= MAX_SWEEP_TOKENS)}
                        onChange={() => toggle(t.address)}
                      />
                    )}
                  </td>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      {t.logoUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element -- registry logo URL
                        <img src={t.logoUrl} alt="" width={20} height={20} style={{ borderRadius: '50%' }} />
                      ) : null}
                      <div>
                        <div style={{ fontWeight: 600 }}>{t.symbol}</div>
                        <div style={{ fontSize: 11, color: 'var(--mute)' }}>{t.name}</div>
                      </div>
                    </div>
                  </td>
                  <td className="mono">{formatDecimalString(t.balance, { maxFractionDigits: 6 })}</td>
                  <td className="mono">{t.priceUsd === null ? '—' : formatDecimalString(t.priceUsd, { maxFractionDigits: Number(t.priceUsd) < 1 ? 6 : 2, prefix: '$' })}</td>
                  <td className="mono">{t.usdValue === null ? '—' : formatDecimalStringUsd(t.usdValue)}</td>
                  <td>
                    {canSell(t) ? (
                      <button className="btn btn-ghost" disabled={busy} onClick={() => requestQuote([t])} style={{ padding: '6px 12px', fontSize: 12.5 }}>
                        Sell
                      </button>
                    ) : (
                      <span style={{ fontSize: 11.5, color: 'var(--mute)' }}>You receive this</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '12px 14px', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12.5, color: 'var(--ink-soft)' }}>
              Total on {chainName} {formatDecimalStringUsd(totalUsd.toFixed(2))} · {BAG_CHAINS[active].nativeCurrency.symbol}{' '}
              {formatDecimalString(holdings.nativeBalance, { maxFractionDigits: 5 })}
            </span>
            <button
              className="btn btn-primary"
              disabled={busy || selectedTokens.length === 0}
              onClick={() => requestQuote(selectedTokens)}
            >
              Sell selected ({selectedTokens.length}) · {formatDecimalStringUsd(selectedUsd.toFixed(2))} → {outSymbol}
            </button>
          </div>
        </div>
      ) : null}

      {phase.kind !== 'idle' && (
        <div className="leaderboard-card" style={{ marginTop: 14, padding: 16 }} role="status">
          {phase.kind === 'quoting' && (
            <p style={{ margin: 0, fontSize: 13.5 }}>
              <Loader2 size={14} className="animate-spin" style={{ verticalAlign: '-2px' }} /> Finding the best route…
            </p>
          )}

          {(phase.kind === 'quoted' || phase.kind === 'executing') && (
            <>
              <div style={{ fontWeight: 600, marginBottom: 8 }}>Sell {phase.quote.legs.length === 1 ? phase.quote.legs[0].symbol : `${phase.quote.legs.length} tokens`} in one transaction</div>
              <table className="positions-table" style={{ marginBottom: 10 }}>
                <tbody>
                  {phase.quote.legs.map((l) => (
                    <tr key={l.address}>
                      <td>{formatRawAmount(l.amountRaw, l.decimals, { maxFractionDigits: 6 })} {l.symbol}</td>
                      <td className="mono">≈ {fmtOut(l.expectedOutRaw)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div style={{ fontSize: 13, display: 'grid', gap: 4 }}>
                <div>You receive ≈ <b>{fmtOut(phase.quote.expectedOutRaw)}</b></div>
                <div style={{ color: 'var(--ink-soft)' }}>Minimum (enforced on-chain per swap): {fmtOut(phase.quote.minOutRaw)}</div>
                {phase.quote.priceImpactBps !== null && (
                  <div style={{ color: 'var(--ink-soft)' }}>Price impact: {(phase.quote.priceImpactBps / 100).toFixed(2)}%</div>
                )}
                {phase.quote.approvals.length > 0 && (
                  <div style={{ color: 'var(--ink-soft)' }}>
                    {phase.quote.approvals.length} token approval{phase.quote.approvals.length === 1 ? '' : 's'} first, then one sale transaction. Wallets
                    that support batching (e.g. MetaMask) ask for a single confirmation; others (e.g. Rabby) ask for each approval, then the sale.
                  </div>
                )}
              </div>
              {phase.kind === 'quoted' ? (
                <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
                  <button className="btn btn-primary" onClick={() => confirm(phase.quote)}>
                    Confirm sale
                  </button>
                  <button className="btn btn-ghost" onClick={() => setPhase({ kind: 'idle' })}>
                    Cancel
                  </button>
                </div>
              ) : (
                <p style={{ margin: '12px 0 0', fontSize: 13.5 }}>
                  <Loader2 size={14} className="animate-spin" style={{ verticalAlign: '-2px' }} />{' '}
                  {phase.kind === 'executing' && phase.step === 'approving' && phase.approval
                    ? `Step ${phase.approval.index} of ${phase.approval.total + 1}: approve ${phase.approval.symbol ?? 'a token'} in your wallet (exact amount)…`
                    : PROGRESS_LABEL[phase.step]}
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
                    <button className="btn btn-primary" disabled={!acceptImpact} onClick={() => requestQuote(pending, phase.notice.priceImpactBps ?? undefined)}>
                      Continue anyway
                    </button>
                    <button className="btn btn-ghost" onClick={() => setPhase({ kind: 'idle' })}>
                      Cancel
                    </button>
                  </div>
                </>
              ) : (
                <p style={{ margin: 0, fontSize: 13, color: '#E0847A' }}>
                  Above {MAX_ACCEPTABLE_PRICE_IMPACT_BPS / 100}% — try a smaller selection.
                </p>
              )}
            </>
          )}

          {phase.kind === 'done' && (
            <p style={{ margin: 0, fontSize: 13.5, color: 'var(--emerald)' }}>
              Sold. ≈ {fmtOut(phase.received)} sent to your wallet.{' '}
              <a href={explorerTx(active, phase.txHash)} target="_blank" rel="noreferrer">
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
