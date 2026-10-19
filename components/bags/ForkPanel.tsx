'use client';

import { useMemo, useState } from 'react';
import { GitFork, Loader2, X, AlertTriangle } from 'lucide-react';
import { useForkBag } from '@/hooks/useForkBag';
import { useBagNameAvailable } from '@/hooks/use-bag-name-available';
import { CompositionEditor, rowsFromBag, summarizeComposition, type CompositionRow } from '@/components/bags/CompositionEditor';
import type { Bag } from '@/types';

// -----------------------------------------------------------------------------
// "Fork": a new Bag of your own that starts from this one. Same editor as "Edit strategy" (CompositionEditor), so the
// fork's assets and weights are chosen BEFORE it exists: the new DRAFT is created with them and deployed once
// (creation fee), instead of deploying a copy and then paying again for a version. Nothing changes for this Bag or
// its holders. The server resolves the assets with the same rules as Edit strategy (lib/server/strategy-edit.ts).
// -----------------------------------------------------------------------------

export function ForkPanel({ bag, onClose }: { bag: Bag; onClose: () => void }) {
  const chain = bag.chains[0] ?? 'robinhood';
  const { fork, isForking, forkError } = useForkBag();
  const original = useMemo(() => rowsFromBag(bag), [bag]);
  const [rows, setRows] = useState<CompositionRow[]>(original);
  const [name, setName] = useState(`${bag.name} (Fork)`);
  const [buyAfter, setBuyAfter] = useState(false);
  const [buyAmount, setBuyAmount] = useState('50');
  const buyValid = !buyAfter || (/^\d+(\.\d+)?$/.test(buyAmount.trim()) && Number(buyAmount) > 0);
  const availability = useBagNameAvailable(name);
  const summary = useMemo(() => summarizeComposition(original, rows), [original, rows]);
  const nameTaken = availability === 'taken';
  const canCreate = !isForking && name.trim().length > 0 && !nameTaken && summary.complete && buyValid;

  const create = () => {
    if (!canCreate || !summary.entries) return;
    // Unchanged weights: a plain copy (the server copies the source's recipe exactly).
    void fork(bag, {
      name,
      ...(summary.changedAny ? { composition: summary.entries } : {}),
      ...(buyAfter ? { launchBuy: buyAmount.trim() } : {}),
    });
  };

  return (
    <div data-testid="fork-panel" className="rounded-xl bg-white/5 border border-white/10 p-5 space-y-4">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 className="text-lg font-semibold text-white inline-flex items-center gap-2">
          <GitFork size={18} /> Fork this Bag
        </h2>
        <button type="button" aria-label="Close" onClick={onClose} disabled={isForking} style={{ background: 'none', border: 'none', color: 'var(--ink-soft)', cursor: 'pointer' }}>
          <X size={18} />
        </button>
      </div>
      <p className="text-sm text-white/60">
        Your own Bag, starting from this one: pick its name, assets and weights now. Then it is deployed, registered on-chain and (if you choose)
        bought in one flow, each step confirmed in your wallet. This Bag and its holders are not affected.
      </p>

      <div className="field">
        <label className="text-sm text-white/70">Name</label>
        <input type="text" aria-label="Fork name" value={name} maxLength={64} disabled={isForking} onChange={(e) => setName(e.target.value)} aria-invalid={nameTaken} />
        {nameTaken && (
          <div role="alert" data-testid="fork-name-taken" style={{ marginTop: 6, fontSize: 12, color: 'var(--red, #E5786D)' }}>
            A Bag with this name already exists. Pick another name.
          </div>
        )}
      </div>

      <CompositionEditor chain={chain} original={original} rows={rows} onChange={setRows} disabled={isForking} />

      <div className="field">
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
          <input type="checkbox" data-testid="fork-buy-after" checked={buyAfter} disabled={isForking} onChange={(e) => setBuyAfter(e.target.checked)} />
          Be the first buyer: buy into it right after it&apos;s deployed (amount in $)
        </label>
        {buyAfter && (
          <input
            type="text"
            inputMode="decimal"
            aria-label="Launch buy amount in dollars"
            data-testid="fork-buy-amount"
            value={buyAmount}
            disabled={isForking}
            onChange={(e) => setBuyAmount(e.target.value)}
            aria-invalid={!buyValid}
            style={{ marginTop: 6, maxWidth: 160 }}
          />
        )}
      </div>

      {forkError && (
        <div role="alert" style={{ display: 'flex', gap: 8, color: 'var(--red, #E5786D)', fontSize: 13 }}>
          <AlertTriangle size={16} /> {forkError}
        </div>
      )}

      <button type="button" data-testid="fork-create" className="btn btn-primary" disabled={!canCreate} onClick={create} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
        {isForking && <Loader2 size={16} className="animate-spin" />}
        {isForking ? 'Creating…' : buyAfter ? 'Create, deploy & buy' : 'Create & deploy fork'}
      </button>
    </div>
  );
}
