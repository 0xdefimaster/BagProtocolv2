'use client';

import { useEffect, useState } from 'react';
import { Scale, CheckCircle2, AlertTriangle } from 'lucide-react';
import { formatDecimalStringUsd } from '@/lib/format';
import type { PositionRebalancePreview } from '@/lib/domain/basket-protocol/rebalance/position-rebalance';

// -----------------------------------------------------------------------------
// R1 — the signed-in investor's allocation in this strategy against its current
// version (GET /api/bags/:id/rebalance-preview). Read-only: it shows the drift
// and what a rebalance would trade; nothing is quoted or traded here. Renders
// nothing for a visitor without a position.
// -----------------------------------------------------------------------------

interface Response {
  symbols: Record<string, string>;
  preview: PositionRebalancePreview;
}

const pct = (bps: number) => `${(bps / 100).toFixed(1)}%`;

export function RebalancePreviewCard({ bagId }: { bagId: string }) {
  const [data, setData] = useState<Response | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/bags/${encodeURIComponent(bagId)}/rebalance-preview`, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => !cancelled && setData(d))
      .catch(() => !cancelled && setData(null));
    return () => {
      cancelled = true;
    };
  }, [bagId]);

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
      {preview.requiresRebalance ? (
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
            , in your own wallet, with no creator fee. One-click rebalance is coming next.
          </p>
        </div>
      ) : (
        <p className="text-sm text-emerald-400 inline-flex items-center gap-1">
          <CheckCircle2 size={14} /> Within this strategy&apos;s {pct(preview.driftThresholdBps)} drift threshold (largest drift {pct(preview.maxAbsDriftBps)}).
        </p>
      )}
    </div>
  );
}
