'use client';

import { useEffect, useState } from 'react';
import { formatDecimalStringUsd } from '@/lib/format';
import { useWallet } from '@/lib/wallet-context';

// -----------------------------------------------------------------------------
// The signed-in user's REAL position in one Bag, via GET
// /api/portfolio/positions — the same numbers the Portfolio page shows. A4:
// valued from holdings (exposure vs what the wallet really holds, drift
// flagged), cost basis and realized P&L from the ledger; never shares × NAV.
// -----------------------------------------------------------------------------

interface PositionView {
  bagId: string;
  strategyExposure: string | null;
  effectivePosition: string | null;
  hasDrift: boolean;
  costBasis: string | null;
  realizedPnl: string | null;
}

const usdOrDash = (v: string | null) => (v === null ? '—' : formatDecimalStringUsd(v));

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

  const pnl = position && position.strategyExposure !== null && position.costBasis !== null ? Number(position.strategyExposure) - Number(position.costBasis) : null;

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
        <>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            <Stat label="Invested" value={usdOrDash(position.costBasis)} />
            <Stat label="Exposure" value={usdOrDash(position.strategyExposure)} />
            <Stat label="In wallet" value={usdOrDash(position.effectivePosition)} />
            <Stat
              label="Unrealized"
              value={pnl === null ? '—' : `${pnl >= 0 ? '+' : '-'}${formatDecimalStringUsd(Math.abs(pnl).toFixed(2))}`}
              tone={pnl === null ? undefined : pnl >= 0 ? 'up' : 'down'}
            />
            <Stat label="Realized" value={usdOrDash(position.realizedPnl)} />
          </div>
          {position.hasDrift && (
            <p className="mt-3 text-xs text-amber-300">
              Your wallet holds less than BAG tracks for this strategy. Only what is in the wallet can be sold.
            </p>
          )}
        </>
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
