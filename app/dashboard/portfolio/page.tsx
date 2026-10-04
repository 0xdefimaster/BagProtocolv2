'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { formatDecimalStringUsd } from '@/lib/format';
import { useWallet } from '@/lib/wallet-context';
import { WalletAssetsPanel } from '@/components/portfolio/WalletAssetsPanel';

// -----------------------------------------------------------------------------
// Portfolio — the signed-in user's real Bag positions (GET
// /api/portfolio/positions). A4: valued from holdings, not shares × NAV —
// strategy exposure (what BAG tracks) and the effective position (what the
// wallet really holds for it) are shown side by side, with drift flagged
// where they differ. Cost basis and realized P&L come from the ledger. A
// number the server could not know right now is shown as "—", never guessed.
// -----------------------------------------------------------------------------

interface PositionView {
  bagId: string;
  bagName: string;
  bagSymbol: string;
  bagStatus: string;
  strategyExposure: string | null;
  observedWallet: string | null;
  effectivePosition: string | null;
  hasDrift: boolean;
  hasUnreadable: boolean;
  costBasis: string | null;
  realizedPnl: string | null;
  quoteCurrency: string;
}

const signedUsd = (v: number) => `${v >= 0 ? '+' : '-'}${formatDecimalStringUsd(Math.abs(v).toFixed(2))}`;

const toNumber = (value: string | null) => (value === null ? null : Number(value));

export default function PortfolioPage() {
  const { isConnected, isConnecting, isSigningIn, authError, connect, signIn, authUser } = useWallet();
  const [positions, setPositions] = useState<PositionView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    fetch('/api/portfolio/positions', { credentials: 'same-origin' })
      .then(async (res) => {
        const body = await res.json().catch(() => null);
        if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status}).`);
        return body.positions as PositionView[];
      })
      .then(setPositions)
      .catch((err: Error) => {
        setPositions([]);
        setError(err.message);
      });
  }, []);

  useEffect(() => {
    if (authUser) load();
  }, [authUser, load]);

  if (!authUser) {
    return (
      <main className="wrap" style={{ paddingBottom: 80, paddingTop: 44 }}>
        <div className="app-intro">
          <h1 style={{ marginTop: 16 }}>Portfolio</h1>
          <p className="lead">Your Bag positions are tied to your wallet — connect and sign in to see them.</p>
        </div>
        <div className="create-card" style={{ marginTop: 32, maxWidth: 480 }}>
          <button className="btn btn-primary" onClick={isConnected ? signIn : connect} disabled={isConnecting || isSigningIn}>
            {isConnecting
              ? 'Connecting…'
              : isSigningIn
                ? 'Confirm the signature in your wallet…'
                : isConnected
                  ? 'Sign in with wallet'
                  : 'Connect wallet'}
          </button>
          {authError && <p style={{ color: '#E0847A', fontSize: 13, marginTop: 12 }}>{authError}</p>}
          <p style={{ color: 'var(--ink-soft)', fontSize: 12.5, marginTop: 12 }}>
            Signing in is free — it&apos;s a message signature, not a transaction, and never costs gas.
          </p>
        </div>
      </main>
    );
  }

  const list = positions ?? [];
  // Unrealized P&L compares like with like: exposure and cost basis are over the same tracked quantities.
  const complete = list.filter((p) => p.strategyExposure !== null && p.costBasis !== null && p.effectivePosition !== null);
  const totalEffective = complete.reduce((sum, p) => sum + Number(p.effectivePosition), 0);
  const totalCost = complete.reduce((sum, p) => sum + Number(p.costBasis), 0);
  const pnl = complete.reduce((sum, p) => sum + Number(p.strategyExposure) - Number(p.costBasis), 0);
  const allKnown = complete.length === list.length;
  const anyDrift = list.some((p) => p.hasDrift);

  return (
    <main className="wrap" style={{ paddingBottom: 80, paddingTop: 44 }}>
      <div className="app-intro">
        <h1 style={{ marginTop: 16 }}>Portfolio</h1>
        <p className="lead">Your positions in Bags and the tokens in your wallet, valued at live prices.</p>
      </div>

      <div className="portfolio-summary" style={{ marginTop: 32 }}>
        <div className="dash-stat">
          <span className="l">In Wallet</span>
          <div className="v">{formatDecimalStringUsd(totalEffective.toFixed(2))}{!allKnown && '*'}</div>
        </div>
        <div className="dash-stat">
          <span className="l">Invested</span>
          <div className="v">{formatDecimalStringUsd(totalCost.toFixed(2))}</div>
        </div>
        <div className="dash-stat">
          <span className="l">Unrealized PnL</span>
          <div className="v" style={{ color: pnl >= 0 ? 'var(--emerald)' : '#E0847A' }}>
            {signedUsd(pnl)}
          </div>
        </div>
        <div className="dash-stat">
          <span className="l">Bags</span>
          <div className="v">{list.length}</div>
        </div>
      </div>
      {!allKnown && (
        <p style={{ color: 'var(--mute)', fontSize: 12.5, marginTop: 8 }}>
          * Live prices or wallet balances are unavailable for some Bags right now; they are left out of the totals above.
        </p>
      )}
      {anyDrift && (
        <p style={{ color: '#E0B97A', fontSize: 12.5, marginTop: 8 }}>
          Drift: your wallet holds less than BAG tracks for some strategies (tokens moved out of the wallet). Only what is really in
          the wallet can be sold; if the difference persists it is booked as an external outflow, not as a gain or loss.
        </p>
      )}

      <div style={{ marginTop: 40 }}>
        <span className="section-label">Positions</span>
        {error && (
          <p style={{ color: '#E0847A', fontSize: 13 }}>
            Could not load your positions: {error}{' '}
            <button onClick={load} style={{ background: 'none', border: 'none', color: 'inherit', textDecoration: 'underline', cursor: 'pointer' }}>
              Retry
            </button>
          </p>
        )}
        {positions === null ? (
          <p style={{ color: 'var(--ink-soft)', fontSize: 13.5 }}>Loading…</p>
        ) : list.length === 0 ? (
          <div className="leaderboard-card" style={{ padding: 24, textAlign: 'center', color: 'var(--ink-soft)', fontSize: 13.5 }}>
            No positions yet — <Link href="/dashboard/explore">find a Bag to invest in</Link> or{' '}
            <Link href="/dashboard/create">create your own</Link>.
          </div>
        ) : (
          <div className="leaderboard-card">
            <table className="positions-table">
              <thead>
                <tr>
                  <th>Bag</th>
                  <th>Invested</th>
                  <th>Exposure</th>
                  <th>In Wallet</th>
                  <th>Unrealized</th>
                  <th>Realized</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {list.map((p) => {
                  const exposure = toNumber(p.strategyExposure);
                  const cost = toNumber(p.costBasis);
                  const realized = toNumber(p.realizedPnl);
                  const rowPnl = exposure === null || cost === null ? null : exposure - cost;
                  return (
                    <tr key={p.bagId}>
                      <td>
                        <Link href={`/dashboard/bag/${p.bagId}`} style={{ fontWeight: 600 }}>
                          {p.bagName}
                        </Link>
                        <div className="mono" style={{ fontSize: 11, color: 'var(--mute)' }}>{p.bagSymbol}</div>
                      </td>
                      <td className="mono">{p.costBasis === null ? '—' : formatDecimalStringUsd(p.costBasis)}</td>
                      <td className="mono">{p.strategyExposure === null ? '—' : formatDecimalStringUsd(p.strategyExposure)}</td>
                      <td className="mono">
                        {p.effectivePosition === null ? '—' : formatDecimalStringUsd(p.effectivePosition)}
                        {p.hasDrift && (
                          <div style={{ fontSize: 10.5, color: '#E0B97A' }} title="Your wallet holds less than BAG tracks for this strategy">
                            drift
                          </div>
                        )}
                        {p.hasUnreadable && <div style={{ fontSize: 10.5, color: 'var(--mute)' }}>balance unavailable</div>}
                      </td>
                      <td className="mono" style={{ color: rowPnl === null ? 'var(--mute)' : rowPnl >= 0 ? 'var(--emerald)' : '#E0847A' }}>
                        {rowPnl === null ? '—' : signedUsd(rowPnl)}
                      </td>
                      <td className="mono" style={{ color: realized === null ? 'var(--mute)' : realized >= 0 ? 'var(--emerald)' : '#E0847A' }}>
                        {realized === null ? '—' : signedUsd(realized)}
                      </td>
                      <td>
                        <Link href={`/dashboard/bag/${p.bagId}`} className="btn btn-ghost" style={{ padding: '6px 12px', fontSize: 12.5 }}>
                          Open
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <WalletAssetsPanel walletAddress={authUser.walletAddress} />
    </main>
  );
}
