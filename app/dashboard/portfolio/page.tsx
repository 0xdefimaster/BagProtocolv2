'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { formatDecimalStringUsd, formatRawAmount } from '@/lib/format';
import { useWallet } from '@/lib/wallet-context';
import { WalletAssetsPanel } from '@/components/portfolio/WalletAssetsPanel';

// -----------------------------------------------------------------------------
// Portfolio — the signed-in user's real Bag positions (GET
// /api/portfolio/positions: bag_investor_positions + live NAV). Replaces the
// old paper-trading demo ($10,000 of play money and BTC/ETH "trades" that
// never touched a chain). Values come from the same NAV math as redeem; a
// Bag whose prices are unavailable right now shows its cost basis only.
// -----------------------------------------------------------------------------

interface PositionView {
  bagId: string;
  bagName: string;
  bagSymbol: string;
  bagStatus: string;
  sharesRaw: string;
  shareDecimals: number;
  costBasis: string;
  currentValue: string | null;
  quoteCurrency: string;
}

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
  const totalCost = list.reduce((sum, p) => sum + Number(p.costBasis), 0);
  const priced = list.filter((p) => p.currentValue !== null);
  const totalValue = priced.reduce((sum, p) => sum + Number(p.currentValue), 0);
  const pricedCost = priced.reduce((sum, p) => sum + Number(p.costBasis), 0);
  const pnl = totalValue - pricedCost;
  const allPriced = priced.length === list.length;

  return (
    <main className="wrap" style={{ paddingBottom: 80, paddingTop: 44 }}>
      <div className="app-intro">
        <h1 style={{ marginTop: 16 }}>Portfolio</h1>
        <p className="lead">Your positions in Bags and the tokens in your wallet, valued at live prices.</p>
      </div>

      <div className="portfolio-summary" style={{ marginTop: 32 }}>
        <div className="dash-stat">
          <span className="l">Current Value</span>
          <div className="v">{formatDecimalStringUsd(totalValue.toFixed(2))}{!allPriced && '*'}</div>
        </div>
        <div className="dash-stat">
          <span className="l">Invested</span>
          <div className="v">{formatDecimalStringUsd(totalCost.toFixed(2))}</div>
        </div>
        <div className="dash-stat">
          <span className="l">Unrealized PnL</span>
          <div className="v" style={{ color: pnl >= 0 ? 'var(--emerald)' : '#E0847A' }}>
            {pnl >= 0 ? '+' : '-'}
            {formatDecimalStringUsd(Math.abs(pnl).toFixed(2))}
          </div>
        </div>
        <div className="dash-stat">
          <span className="l">Bags</span>
          <div className="v">{list.length}</div>
        </div>
      </div>
      {!allPriced && (
        <p style={{ color: 'var(--mute)', fontSize: 12.5, marginTop: 8 }}>
          * Live prices are unavailable for some Bags right now; they are left out of the value and PnL above.
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
                  <th>Shares</th>
                  <th>Invested</th>
                  <th>Value</th>
                  <th>PnL</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {list.map((p) => {
                  const value = toNumber(p.currentValue);
                  const rowPnl = value === null ? null : value - Number(p.costBasis);
                  return (
                    <tr key={p.bagId}>
                      <td>
                        <Link href={`/dashboard/bag/${p.bagId}`} style={{ fontWeight: 600 }}>
                          {p.bagName}
                        </Link>
                        <div className="mono" style={{ fontSize: 11, color: 'var(--mute)' }}>{p.bagSymbol}</div>
                      </td>
                      <td className="mono">{formatRawAmount(p.sharesRaw, p.shareDecimals, { maxFractionDigits: 4 })}</td>
                      <td className="mono">{formatDecimalStringUsd(p.costBasis)}</td>
                      <td className="mono">{value === null ? '—' : formatDecimalStringUsd(p.currentValue!)}</td>
                      <td className="mono" style={{ color: rowPnl === null ? 'var(--mute)' : rowPnl >= 0 ? 'var(--emerald)' : '#E0847A' }}>
                        {rowPnl === null ? '—' : `${rowPnl >= 0 ? '+' : '-'}${formatDecimalStringUsd(Math.abs(rowPnl).toFixed(2))}`}
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
