'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, CheckCircle2, AlertTriangle, Pencil, X } from 'lucide-react';
import { useWallet } from '@/lib/wallet-context';
import { useEditStrategy } from '@/hooks/use-edit-strategy';
import { useStrategyRegistration, type RegistrationOutcome } from '@/hooks/use-strategy-registration';
import { CompositionEditor, rowsFromBag, summarizeComposition, type CompositionRow } from '@/components/bags/CompositionEditor';
import type { Bag } from '@/types';

// -----------------------------------------------------------------------------
// "Edit strategy" on a deployed, MUTABLE Bag's page, for its creator: swap assets in or out and change target
// weights. Saving records a new version on chain from the creator's own wallet (hooks/use-edit-strategy.ts); the
// Bag then shows as "Name v2", "v3", …. Holders keep what they hold until they rebalance to the new weights.
// Everything else about the Bag (name, rules, fee) stays as it is.
// -----------------------------------------------------------------------------

export function EditStrategyPanel({
  bag,
  onSaved,
  open: openProp,
  onOpenChange,
  hideTrigger = false,
}: {
  bag: Bag;
  /** After a saved version (and its registry entry): the new version number, so the page can rebalance to it. */
  onSaved?: (newVersion?: number) => void;
  /** Controlled open state, for a page that shows its own "Edit strategy" button (with `hideTrigger`). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  hideTrigger?: boolean;
}) {
  const chain = bag.chains[0] ?? 'robinhood';
  const { isConnected, walletAddress, connect } = useWallet();
  const { state, submit, resumePending, reset, sync, checkStatus, recover } = useEditStrategy(bag.id);
  const [recoverTx, setRecoverTx] = useState('');
  // A failed status read alone (e.g. RPC briefly down) is not worth a banner on a closed panel; a failed recovery is.
  const [recoverTried, setRecoverTried] = useState(false);
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const setOpen = useCallback(
    (next: boolean) => {
      if (onOpenChange) onOpenChange(next);
      if (openProp === undefined) setOpenState(next);
    },
    [onOpenChange, openProp]
  );
  const [rows, setRows] = useState<CompositionRow[]>(() => rowsFromBag(bag));
  const [reason, setReason] = useState('');
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
  }, [resumePending, checkStatus, setOpen]);

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

  // Once per saved version, whatever the identity of `onSaved`: first the new version goes into the on-chain
  // StrategyRegistry (one more wallet confirmation, prompted right away; a skip or rejection does not block),
  // then the page is told, which rebalances the creator's own position to it.
  const registration = useStrategyRegistration(bag.id);
  const [registryStep, setRegistryStep] = useState<'registering' | RegistrationOutcome | null>(null);
  const savedRef = useRef(false);
  const onSavedRef = useRef(onSaved);
  useEffect(() => {
    onSavedRef.current = onSaved;
  }, [onSaved]);
  useEffect(() => {
    if (state.phase !== 'completed') {
      savedRef.current = false;
      return;
    }
    if (savedRef.current) return;
    savedRef.current = true;
    const newVersion = state.newVersion ?? undefined;
    if (!walletAddress) {
      onSavedRef.current?.(newVersion);
      return;
    }
    setRegistryStep('registering');
    void registration.register(walletAddress).then((outcome) => {
      setRegistryStep(outcome);
      onSavedRef.current?.(newVersion);
    });
    // Once per saved version; the wallet and registration hook are read at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.phase]);

  const original = useMemo(() => rowsFromBag(bag), [bag]);
  const summary = useMemo(() => summarizeComposition(original, rows), [original, rows]);
  const busy = state.phase === 'preparing' || state.phase === 'awaiting_signature' || state.phase === 'confirming';
  const canSave = !busy && summary.complete && summary.changedAny;

  const save = () => {
    if (!canSave) return;
    if (!isConnected || !walletAddress) {
      void connect();
      return;
    }
    if (summary.entries) void submit(walletAddress, summary.entries, reason.trim());
  };

  const close = () => {
    setOpen(false);
    setRows(rowsFromBag(bag));
    setReason('');
    reset();
  };

  if (!open) {
    if (hideTrigger) return syncPanel || null;
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
        {registryStep && (
          <p data-testid="edit-strategy-registry" className="text-sm text-white/70 mt-2">
            {registryStep === 'registering'
              ? registration.phase === 'awaiting_signature'
                ? 'Next: confirm the on-chain registry entry for this version in your wallet…'
                : 'Publishing this version to the on-chain strategy registry…'
              : registryStep === 'completed'
                ? 'Published to the on-chain registry: anyone can verify this version.'
                : 'Not published to the registry yet; you can do it from the Passport & verification tab.'}
          </p>
        )}
        <p className="text-sm text-white/60 mt-2">
          If you hold this Bag, your rebalance to the new weights opens below. Other holders keep their assets until they rebalance.
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
        Change which assets the Bag holds and their target weights. Saving records version v{(bag.version ?? 1) + 1} on chain, publishes it to the
        strategy registry and, if you hold this Bag, opens your rebalance to it. Each step is confirmed in your wallet (network fees only).
      </p>

      <CompositionEditor chain={chain} original={original} rows={rows} onChange={setRows} disabled={busy} />

      <div className="field">
        <label className="text-sm text-white/70">Why this change? (shown in the version history)</label>
        <textarea value={reason} maxLength={500} rows={2} disabled={busy} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Swapped X for Y, trimmed Z" />
      </div>

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
