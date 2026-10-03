'use client';

import { useEffect, useState } from 'react';
import { formatDecimalStringUsd, formatRawAmount } from '@/lib/format';
import { useWallet } from '@/lib/wallet-context';

// -----------------------------------------------------------------------------
// The signed-in user's REAL position in one Bag (bag_investor_positions +
// live NAV, via GET /api/portfolio/positions — the same numbers the Portfolio
// page shows). Replaces the old paper-trading block, which listed play-money
// trades that never touched a chain.
// -----------------------------------------------------------------------------

interface PositionView {
  bagId: string;
  sharesRaw: string;
  shareDecimals: number;
  costBasis: string;
  currentValue: string | null;
}

export function MyBagPosition({ bagId, refreshKey }: { bagId: string; refreshKey?: unknown }) {
  const { authUser } = useWallet();
  const [position, setPosition] = useState<PositionView | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!authUser) return;
    let cancelled = false;
    setError(null);
    fetch('/api/portfolio/positions', { credentials: 'same-origin' })
      .then(async (res) => {
        const body = await res.json().catch(() => null);
        if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status}).`);
        return (body.positions as PositionView[]).find((p) => p.bagId === bagId) ?? null;
      })
      .then((p) => {
        if (!cancelled) setPosition(p);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [authUser, bagId, refreshKey]);

  if (!authUser) return null;

  const value = position?.currentValue != null ? Number(position.currentValue) : null;
  const pnl = position && value !== null ? value - Number(position.costBasis) : null;

  return (
    <div className="rounded-xl border border-white/10 bg-white/5 p-6">
      <h3 className="text-lg font-bold text-white mb-4">Your position in this Bag</h3>
      {error ? (
        <p className="text-sm text-red-400">Could not load your position: {error}</p>
      ) : position === undefined ? (
        <p className="text-sm text-white/50">Loading…</p>
      ) : position === null ? (
        <p className="text-sm text-white/50">You don&apos;t hold this Bag yet.</p>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Stat label="Shares" value={formatRawAmount(position.sharesRaw, position.shareDecimals, { maxFractionDigits: 4 })} />
          <Stat label="Invested" value={formatDecimalStringUsd(position.costBasis)} />
          <Stat label="Value" value={value === null ? '—' : formatDecimalStringUsd(position.currentValue!)} />
          <Stat
            label="PnL"
            value={pnl === null ? '—' : `${pnl >= 0 ? '+' : '-'}${formatDecimalStringUsd(Math.abs(pnl).toFixed(2))}`}
            tone={pnl === null ? undefined : pnl >= 0 ? 'up' : 'down'}
          />
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'up' | 'down' }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-white/50">{label}</div>
      <div className={`mt-1 font-semibold ${tone === 'up' ? 'text-emerald-400' : tone === 'down' ? 'text-red-400' : 'text-white'}`}>{value}</div>
    </div>
  );
}
