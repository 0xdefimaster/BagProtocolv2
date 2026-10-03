'use client';

import { useEffect, useState } from 'react';
import { GitCommitVertical } from 'lucide-react';
import type { VersionTimelineEntry } from '@/lib/server/bag-version-timeline';
import type { AssetWeightChange } from '@/lib/domain/basket-protocol/strategy-diff';

// -----------------------------------------------------------------------------
// Bag page → History: every version of the strategy, newest first — why it
// changed, who changed it, what changed (Strategy Diff) and how NAV per share
// moved while that version was live. Data: GET /api/bags/:id/versions.
// -----------------------------------------------------------------------------

const pct = (bps: number | null) => (bps === null ? '—' : `${(bps / 100).toFixed(2).replace(/\.?0+$/, '')}%`);
const signedPct = (bps: number) => `${bps > 0 ? '+' : bps < 0 ? '−' : ''}${pct(Math.abs(bps))}`;
const KIND_LABEL: Record<AssetWeightChange['kind'], string> = { ADDED: 'Added', REMOVED: 'Removed', REWEIGHTED: 'Re-weighted', UNCHANGED: 'Unchanged' };

function shortAddress(address: string | null) {
  return address ? `${address.slice(0, 6)}…${address.slice(-4)}` : null;
}

function DiffRow({ change }: { change: AssetWeightChange }) {
  const color = change.deltaBps > 0 ? 'text-emerald-400' : change.deltaBps < 0 ? 'text-red-400' : 'text-white/50';
  return (
    <tr className="border-t border-white/5">
      <td className="py-1.5 pr-3 font-medium text-white">{change.symbol}</td>
      <td className="py-1.5 pr-3 text-xs text-white/50">{KIND_LABEL[change.kind]}</td>
      <td className="py-1.5 pr-3 font-mono text-sm text-white/70">
        {pct(change.fromBps)} → {pct(change.toBps)}
      </td>
      <td className={`py-1.5 font-mono text-sm ${color}`}>{change.kind === 'UNCHANGED' ? '' : signedPct(change.deltaBps)}</td>
    </tr>
  );
}

function Entry({ entry, isFirst }: { entry: VersionTimelineEntry; isFirst: boolean }) {
  const [showUnchanged, setShowUnchanged] = useState(false);
  const changed = entry.diff.assets.filter((a) => a.kind !== 'UNCHANGED');
  const unchanged = entry.diff.assets.filter((a) => a.kind === 'UNCHANGED');
  const author = entry.createdBy.name ?? shortAddress(entry.createdBy.address) ?? 'Unknown';
  const perf = entry.performance;

  return (
    <li className="relative pl-8">
      <span className="absolute left-0 top-1 text-white/40">
        <GitCommitVertical className="w-5 h-5" />
      </span>
      <div className="rounded-xl border border-white/10 bg-white/5 p-5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-lg font-bold text-white">v{entry.version}</span>
          {entry.isCurrent && <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-400">Current</span>}
          <span className="text-xs text-white/50">{new Date(entry.createdAt).toLocaleString()}</span>
          <span className="text-xs text-white/50">by {author}</span>
          {perf && (
            <span
              className={`ml-auto font-mono text-sm ${perf.returnPct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}
              title={`NAV per share ${perf.fromNavPerShare} → ${perf.toNavPerShare} (${new Date(perf.fromAt).toLocaleDateString()} – ${new Date(perf.toAt).toLocaleDateString()})`}
            >
              {perf.returnPct >= 0 ? '+' : ''}
              {perf.returnPct.toFixed(2)}% {entry.isCurrent ? 'since this version' : 'while live'}
            </span>
          )}
        </div>

        <p className="mt-2 text-sm text-white/70">{entry.reason ? `“${entry.reason}”` : <span className="text-white/40">No reason given.</span>}</p>

        {isFirst ? (
          <p className="mt-3 text-xs uppercase tracking-wider text-white/50">Initial composition</p>
        ) : entry.diff.unchanged ? (
          <p className="mt-3 text-sm text-white/50">No composition or setting changes.</p>
        ) : null}

        {(isFirst ? entry.diff.assets.length > 0 : changed.length > 0) && (
          <table className="mt-2 w-full text-left">
            <tbody>
              {(isFirst ? entry.diff.assets : changed).map((c) => (
                <DiffRow key={c.identityKey} change={c} />
              ))}
              {!isFirst && showUnchanged && unchanged.map((c) => <DiffRow key={c.identityKey} change={c} />)}
            </tbody>
          </table>
        )}
        {!isFirst && unchanged.length > 0 && (
          <button type="button" onClick={() => setShowUnchanged((v) => !v)} className="mt-2 text-xs text-white/50 underline">
            {showUnchanged ? 'Hide' : 'Show'} unchanged ({unchanged.length})
          </button>
        )}

        {entry.diff.settings.length > 0 && (
          <ul className="mt-3 space-y-1 text-sm">
            {entry.diff.settings.map((s) => (
              <li key={s.field} className="text-white/70">
                {s.label}: <span className="font-mono">{s.from}</span> → <span className="font-mono text-white">{s.to}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </li>
  );
}

export function VersionTimeline({ bagId }: { bagId: string }) {
  const [entries, setEntries] = useState<VersionTimelineEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setEntries(null);
    setError(null);
    fetch(`/api/bags/${encodeURIComponent(bagId)}/versions`, { credentials: 'same-origin' })
      .then(async (res) => {
        const body = await res.json().catch(() => null);
        if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status}).`);
        return body.versions as VersionTimelineEntry[];
      })
      .then((v) => !cancelled && setEntries(v))
      .catch((err: Error) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, [bagId]);

  if (error) return <p className="text-sm text-red-400">Could not load the version history: {error}</p>;
  if (entries === null) return <p className="text-sm text-white/50">Loading version history…</p>;
  if (entries.length === 0) return <p className="text-sm text-white/50">This Bag has no recorded versions yet.</p>;

  const oldest = entries[entries.length - 1].version;
  return (
    <div>
      <p className="mb-4 text-sm text-white/50">
        {entries.length} version{entries.length === 1 ? '' : 's'}. Performance per version is measured from recorded NAV snapshots only.
      </p>
      <ol className="space-y-4">
        {entries.map((e) => (
          <Entry key={e.versionId} entry={e} isFirst={e.version === oldest} />
        ))}
      </ol>
    </div>
  );
}
