'use client';

import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronUp, Plus, X } from 'lucide-react';
import { fetchRegistryAssetsForChain } from '@/lib/registry-assets-client';
import { AssetSelector } from '@/components/create/AssetSelector';
import { bpsToPercent, equalWeightsBps, normalizeToTotal, percentToBps, setWeightKeepingTotal } from '@/lib/weight-input';
import type { Asset } from '@/lib/create-assets-data';
import type { Bag } from '@/types';

// -----------------------------------------------------------------------------
// The one editor for a Bag's assets and target weights, shared by "Edit strategy" (a new version of your own Bag)
// and "Fork" (a new Bag of your own, starting from this one). Controlled: the parent holds the rows. Assets added here
// come from the verified registry of the Bag's chain; the server checks them again (lib/server/strategy-edit.ts).
// -----------------------------------------------------------------------------

export interface CompositionRow {
  address: string;
  symbol: string;
  percent: string;
}

export function rowsFromBag(bag: Bag): CompositionRow[] {
  return bag.composition
    .filter((p) => typeof p.address === 'string')
    .map((p) => ({ address: p.address as string, symbol: p.symbol, percent: bpsToPercent(p.weightBps ?? Math.round(p.weight * 100)) }));
}

export interface CompositionSummary {
  /** (address, weightBps) to send, or null while a weight is invalid. */
  entries: { address: string; weightBps: number }[] | null;
  totalBps: number;
  /** Weights valid and summing to exactly 100%. */
  complete: boolean;
  added: string[];
  removed: string[];
  changed: string[];
  changedAny: boolean;
}

export function summarizeComposition(original: CompositionRow[], rows: CompositionRow[]): CompositionSummary {
  const parsed = rows.map((r) => percentToBps(r.percent));
  const totalBps = parsed.reduce<number>((sum, bps) => sum + (bps ?? 0), 0);
  const valid = parsed.every((bps) => bps !== null);
  const before = new Map(original.map((r) => [r.address.toLowerCase(), r]));
  const after = new Map(rows.map((r) => [r.address.toLowerCase(), r]));
  const added = rows.filter((r) => !before.has(r.address.toLowerCase())).map((r) => r.symbol);
  const removed = original.filter((r) => !after.has(r.address.toLowerCase())).map((r) => r.symbol);
  const changed = rows
    .filter((r) => {
      const prev = before.get(r.address.toLowerCase());
      return prev && percentToBps(prev.percent) !== percentToBps(r.percent);
    })
    .map((r) => `${r.symbol} ${before.get(r.address.toLowerCase())!.percent}% → ${r.percent}%`);
  return {
    entries: valid ? rows.map((r, i) => ({ address: r.address, weightBps: parsed[i] as number })) : null,
    totalBps,
    complete: valid && rows.length > 0 && totalBps === 10_000,
    added,
    removed,
    changed,
    changedAny: added.length + removed.length + changed.length > 0,
  };
}

const idOf = (chain: string, address: string) => `${chain}:${address.toLowerCase()}`;

export function CompositionEditor({
  chain,
  original,
  rows,
  onChange,
  disabled,
}: {
  chain: string;
  original: CompositionRow[];
  rows: CompositionRow[];
  onChange: (rows: CompositionRow[]) => void;
  disabled?: boolean;
}) {
  const [pool, setPool] = useState<Asset[]>([]);
  const [poolLoading, setPoolLoading] = useState(true);
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setPoolLoading(true);
    void fetchRegistryAssetsForChain(chain).then((assets) => {
      if (cancelled) return;
      setPool(assets);
      setPoolLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [chain]);

  const summary = useMemo(() => summarizeComposition(original, rows), [original, rows]);
  const parsed = rows.map((r) => percentToBps(r.percent));
  // The selector matches its own ids exactly; take the pool's id for each held asset (address case may differ).
  const selectedIds = rows.map((r) => pool.find((a) => a.address?.toLowerCase() === r.address.toLowerCase())?.id ?? idOf(chain, r.address));

  const addAsset = (assetId: string) => {
    const asset = pool.find((a) => a.id.toLowerCase() === assetId.toLowerCase());
    if (!asset?.address || rows.some((r) => r.address.toLowerCase() === asset.address!.toLowerCase())) return;
    onChange([...rows, { address: asset.address, symbol: asset.symbol, percent: '0' }]);
  };
  // Sliders keep the total at exactly 100%: the other weights absorb the change in proportion.
  const slide = (i: number, bps: number) => {
    const next = setWeightKeepingTotal(parsed.map((b) => b ?? 0), i, bps);
    onChange(rows.map((r, j) => ({ ...r, percent: bpsToPercent(next[j]) })));
  };
  // Removing an asset from a complete (100%) Bag scales the rest back up to 100%.
  const removeAsset = (address: string) => {
    const kept = rows.filter((r) => r.address.toLowerCase() !== address.toLowerCase());
    if (summary.complete && kept.length > 0) {
      const next = normalizeToTotal(kept.map((r) => percentToBps(r.percent) ?? 0));
      onChange(kept.map((r, j) => ({ ...r, percent: bpsToPercent(next[j]) })));
    } else {
      onChange(kept);
    }
  };
  const equalize = () => onChange(equalWeightsBps(rows.length).map((bps, i) => ({ ...rows[i], percent: bpsToPercent(bps) })));

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        {rows.map((r, i) => (
          <div key={r.address} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ width: 72, flex: 'none', color: 'var(--ink)', fontWeight: 600 }}>{r.symbol}</span>
            <input
              type="range"
              min={0}
              max={10_000}
              step={100}
              aria-label={`${r.symbol} weight slider`}
              value={parsed[i] ?? 0}
              disabled={disabled || rows.length <= 1}
              onChange={(e) => slide(i, Number(e.target.value))}
              className="weight-slider"
              style={{ flex: 1, minWidth: 80 }}
            />
            <input
              type="text"
              inputMode="decimal"
              aria-label={`${r.symbol} weight in percent`}
              value={r.percent}
              disabled={disabled}
              onChange={(e) => onChange(rows.map((x, j) => (j === i ? { ...x, percent: e.target.value } : x)))}
              style={{ width: 90, textAlign: 'right', borderColor: parsed[i] === null ? 'var(--red, #E5786D)' : undefined }}
            />
            <span className="text-white/60">%</span>
            <button type="button" aria-label={`Remove ${r.symbol}`} disabled={disabled || rows.length <= 1} onClick={() => removeAsset(r.address)} style={{ background: 'none', border: 'none', color: 'var(--ink-soft)', cursor: 'pointer' }}>
              <X size={16} />
            </button>
          </div>
        ))}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13 }}>
          <button type="button" className="btn btn-secondary" disabled={disabled || rows.length === 0} onClick={equalize}>
            Equal weights
          </button>
          <span data-testid="edit-strategy-total" style={{ color: summary.totalBps === 10_000 ? 'var(--green, #6FCF97)' : 'var(--red, #E5786D)' }}>
            Total {bpsToPercent(summary.totalBps)}%
          </span>
        </div>
      </div>

      <div>
        <button
          type="button"
          data-testid="composition-add-remove"
          aria-expanded={pickerOpen}
          disabled={disabled}
          onClick={() => setPickerOpen((o) => !o)}
          className="composition-picker-toggle"
        >
          <Plus size={16} aria-hidden="true" />
          Add or remove assets
          {pickerOpen ? <ChevronUp size={16} aria-hidden="true" /> : <ChevronDown size={16} aria-hidden="true" />}
        </button>
        {pickerOpen && (
          <div className="mt-3">
            <AssetSelector
              assets={pool}
              selectedIds={selectedIds}
              onSelect={addAsset}
              onDeselect={(assetId) => {
                const asset = pool.find((a) => a.id.toLowerCase() === assetId.toLowerCase());
                if (asset?.address && rows.length > 1) removeAsset(asset.address);
              }}
              loadingRegistryAssets={poolLoading}
            />
          </div>
        )}
      </div>

      {summary.changedAny && (
        <div data-testid="edit-strategy-diff" className="text-sm text-white/70">
          {summary.added.length > 0 && <div>Added: {summary.added.join(', ')}</div>}
          {summary.removed.length > 0 && <div>Removed: {summary.removed.join(', ')}</div>}
          {summary.changed.length > 0 && <div>Changed: {summary.changed.join(', ')}</div>}
        </div>
      )}
    </div>
  );
}
