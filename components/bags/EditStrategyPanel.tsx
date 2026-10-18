'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, CheckCircle2, AlertTriangle, Pencil, X } from 'lucide-react';
import { useWallet } from '@/lib/wallet-context';
import { useEditStrategy } from '@/hooks/use-edit-strategy';
import { fetchRegistryAssetsForChain } from '@/lib/registry-assets-client';
import { AssetSelector } from '@/components/create/AssetSelector';
import { bpsToPercent, equalWeightsBps, percentToBps } from '@/lib/weight-input';
import type { Asset } from '@/lib/create-assets-data';
import type { Bag } from '@/types';

// -----------------------------------------------------------------------------
// "Edit strategy" on a deployed, MUTABLE Bag's page, for its creator: swap assets in or out and change target
// weights. Saving records a new version on chain from the creator's own wallet (hooks/use-edit-strategy.ts); the
// Bag then shows as "Name v2", "v3", …. Holders keep what they hold until they rebalance to the new weights.
// Everything else about the Bag (name, rules, fee) stays as it is.
// -----------------------------------------------------------------------------

interface Row {
  address: string;
  symbol: string;
  percent: string;
}

const idOf = (chain: string, address: string) => `${chain}:${address.toLowerCase()}`;

function rowsFromBag(bag: Bag): Row[] {
  return bag.composition
    .filter((p) => typeof p.address === 'string')
    .map((p) => ({ address: p.address as string, symbol: p.symbol, percent: bpsToPercent(p.weightBps ?? Math.round(p.weight * 100)) }));
}

export function EditStrategyPanel({ bag, onSaved }: { bag: Bag; onSaved?: () => void }) {
  const chain = bag.chains[0] ?? 'robinhood';
  const { isConnected, walletAddress, connect } = useWallet();
  const { state, submit, resumePending, reset, sync, checkStatus, recover } = useEditStrategy(bag.id);
  const [recoverTx, setRecoverTx] = useState('');
  // A failed status read alone (e.g. RPC briefly down) is not worth a banner on a closed panel; a failed recovery is.
  const [recoverTried, setRecoverTried] = useState(false);
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Row[]>(() => rowsFromBag(bag));
  const [reason, setReason] = useState('');
  const [pool, setPool] = useState<Asset[]>([]);
  const [poolLoading, setPoolLoading] = useState(false);
  const resumed = useRef(false);

  // A version transaction sent before a refresh is confirmed without asking for another signature; otherwise the
  // server is asked whether the chain is ahead of it (a version recorded on chain but not saved here).
  useEffect(() => {
    if (resumed.current) return;
    resumed.current = true;
    void resumePending().then((had) => {
      if (had) setOpen(true);
      else void checkStatus();
    });
  }, [resumePending, checkStatus]);

  const behind = sync.kind === 'ready' && sync.sync.chainVersion > sync.sync.recordedVersion;
  const syncPanel = (behind || sync.kind === 'recovering' || (sync.kind === 'error' && (open || recoverTried))) && (
    <div data-testid="version-sync" role="status" className="rounded-xl border p-4 text-sm" style={{ borderColor: 'var(--gold, #D9B98B)', background: 'rgba(217,185,139,0.08)' }}>
      {behind && sync.kind === 'ready' && (
        <p className="text-white/80">
          Version v{sync.sync.chainVersion} is recorded on chain, but this page still shows v{sync.sync.recordedVersion}. Complete the update to save it here; your
          wallet is not asked to sign again.
        </p>
      )}
      {sync.kind === 'recovering' && <p className="text-white/80">Checking the chain and saving the update…</p>}
      {sync.kind === 'error' && <p style={{ color: 'var(--red, #E5786D)' }}>{sync.message}</p>}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10, alignItems: 'center' }}>
        <button type="button" data-testid="version-recover" className="btn btn-primary" disabled={sync.kind === 'recovering'} onClick={() => {
            setRecoverTried(true);
            void recover(recoverTx.trim() || undefined);
          }}>
          Complete update
        </button>
        <button type="button" data-testid="version-check" className="btn btn-secondary" disabled={sync.kind === 'recovering'} onClick={() => void checkStatus()}>
          Check status
        </button>
      </div>
      <details className="mt-2">
        <summary style={{ cursor: 'pointer' }} className="text-white/60">I have the transaction hash</summary>
        <input type="text" aria-label="Transaction hash" placeholder="0x…" value={recoverTx} onChange={(e) => setRecoverTx(e.target.value)} style={{ marginTop: 6, width: '100%' }} />
      </details>
    </div>
  );

  // Once per saved version, whatever the identity of `onSaved`.
  const savedRef = useRef(false);
  useEffect(() => {
    if (state.phase !== 'completed') {
      savedRef.current = false;
      return;
    }
    if (savedRef.current) return;
    savedRef.current = true;
    onSaved?.();
  }, [state.phase, onSaved]);

  useEffect(() => {
    if (!open || pool.length > 0) return;
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
  }, [open, chain, pool.length]);

  const original = useMemo(() => rowsFromBag(bag), [bag]);
  const parsed = rows.map((r) => percentToBps(r.percent));
  const totalBps = parsed.reduce<number>((sum, bps) => sum + (bps ?? 0), 0);
  const allValid = parsed.every((bps) => bps !== null);

  const diff = useMemo(() => {
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
    return { added, removed, changed, any: added.length + removed.length + changed.length > 0 };
  }, [original, rows]);

  const busy = state.phase === 'preparing' || state.phase === 'awaiting_signature' || state.phase === 'confirming';
  const canSave = !busy && rows.length > 0 && allValid && totalBps === 10_000 && diff.any;
  // The selector matches its own ids exactly; take the pool's id for each held asset (address case may differ).
  const selectedIds = rows.map((r) => pool.find((a) => a.address?.toLowerCase() === r.address.toLowerCase())?.id ?? idOf(chain, r.address));

  const addAsset = (assetId: string) => {
    const asset = pool.find((a) => a.id.toLowerCase() === assetId.toLowerCase());
    if (!asset?.address || rows.some((r) => r.address.toLowerCase() === asset.address!.toLowerCase())) return;
    setRows((prev) => [...prev, { address: asset.address!, symbol: asset.symbol, percent: '0' }]);
  };
  const removeAsset = (address: string) => setRows((prev) => prev.filter((r) => r.address.toLowerCase() !== address.toLowerCase()));
  const equalize = () => setRows((prev) => equalWeightsBps(prev.length).map((bps, i) => ({ ...prev[i], percent: bpsToPercent(bps) })));

  const save = () => {
    if (!canSave) return;
    if (!isConnected || !walletAddress) {
      void connect();
      return;
    }
    void submit(
      walletAddress,
      rows.map((r, i) => ({ address: r.address, weightBps: parsed[i] as number })),
      reason.trim()
    );
  };

  const close = () => {
    setOpen(false);
    setRows(rowsFromBag(bag));
    setReason('');
    reset();
  };

  if (!open) {
    return (
      <div className="space-y-3">
        {syncPanel}
        <button type="button" data-testid="edit-strategy-open" className="btn btn-secondary" onClick={() => setOpen(true)} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <Pencil size={16} /> Edit strategy
        </button>
      </div>
    );
  }

  if (state.phase === 'completed') {
    return (
      <div data-testid="edit-strategy-done" className="rounded-xl bg-white/5 border border-white/10 p-5">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--green, #6FCF97)', fontWeight: 600 }}>
          <CheckCircle2 size={18} /> Saved{state.newVersion ? ` as v${state.newVersion}` : ''}.
        </div>
        <p className="text-sm text-white/60 mt-2">
          Holders keep their current assets until they rebalance; the Rebalance card shows each holder how far they are from the new weights.
        </p>
        <button type="button" className="btn btn-secondary mt-3" onClick={close}>
          Close
        </button>
      </div>
    );
  }

  return (
    <div data-testid="edit-strategy-panel" className="rounded-xl bg-white/5 border border-white/10 p-5 space-y-4">
      {syncPanel}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 className="text-lg font-semibold text-white">Edit strategy{bag.version ? ` (now v${bag.version})` : ''}</h2>
        <button type="button" aria-label="Close" onClick={close} disabled={busy} style={{ background: 'none', border: 'none', color: 'var(--ink-soft)', cursor: 'pointer' }}>
          <X size={18} />
        </button>
      </div>
      <p className="text-sm text-white/60">
        Change which assets the Bag holds and their target weights. Saving records version v{(bag.version ?? 1) + 1} on chain from your wallet (one
        signature, network fee only).
      </p>

      <div className="space-y-2">
        {rows.map((r, i) => (
          <div key={r.address} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ flex: 1, color: 'var(--ink)', fontWeight: 600 }}>{r.symbol}</span>
            <input
              type="text"
              inputMode="decimal"
              aria-label={`${r.symbol} weight in percent`}
              value={r.percent}
              disabled={busy}
              onChange={(e) => setRows((prev) => prev.map((x, j) => (j === i ? { ...x, percent: e.target.value } : x)))}
              style={{ width: 90, textAlign: 'right', borderColor: parsed[i] === null ? 'var(--red, #E5786D)' : undefined }}
            />
            <span className="text-white/60">%</span>
            <button type="button" aria-label={`Remove ${r.symbol}`} disabled={busy || rows.length <= 1} onClick={() => removeAsset(r.address)} style={{ background: 'none', border: 'none', color: 'var(--ink-soft)', cursor: 'pointer' }}>
              <X size={16} />
            </button>
          </div>
        ))}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13 }}>
          <button type="button" className="btn btn-secondary" disabled={busy || rows.length === 0} onClick={equalize}>
            Equal weights
          </button>
          <span data-testid="edit-strategy-total" style={{ color: totalBps === 10_000 ? 'var(--green, #6FCF97)' : 'var(--red, #E5786D)' }}>
            Total {bpsToPercent(totalBps)}%
          </span>
        </div>
      </div>

      <details>
        <summary className="text-sm text-white/70" style={{ cursor: 'pointer' }}>Add or remove assets</summary>
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
      </details>

      <div className="field">
        <label className="text-sm text-white/70">Why this change? (shown in the version history)</label>
        <textarea value={reason} maxLength={500} rows={2} disabled={busy} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Swapped X for Y, trimmed Z" />
      </div>

      {diff.any && (
        <div data-testid="edit-strategy-diff" className="text-sm text-white/70">
          {diff.added.length > 0 && <div>Added: {diff.added.join(', ')}</div>}
          {diff.removed.length > 0 && <div>Removed: {diff.removed.join(', ')}</div>}
          {diff.changed.length > 0 && <div>Changed: {diff.changed.join(', ')}</div>}
        </div>
      )}

      {state.phase === 'failed' && state.error && (
        <div role="alert" style={{ display: 'flex', gap: 8, color: 'var(--red, #E5786D)', fontSize: 13 }}>
          <AlertTriangle size={16} /> {state.error}
        </div>
      )}
      {state.pending && <div className="text-sm text-white/60">Waiting for the transaction to be mined…</div>}

      <button type="button" data-testid="edit-strategy-save" className="btn btn-primary" disabled={!canSave} onClick={save} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
        {busy && <Loader2 size={16} className="animate-spin" />}
        {state.phase === 'preparing'
          ? 'Preparing…'
          : state.phase === 'awaiting_signature'
            ? 'Confirm in your wallet…'
            : state.phase === 'confirming'
              ? 'Verifying on chain…'
              : !isConnected
                ? 'Connect wallet'
                : `Save as v${(bag.version ?? 1) + 1}`}
      </button>
    </div>
  );
}
