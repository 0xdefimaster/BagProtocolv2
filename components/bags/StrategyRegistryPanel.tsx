'use client';

import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Loader2, ShieldCheck, AlertTriangle } from 'lucide-react';
import { useWallet } from '@/lib/wallet-context';
import { useStrategyRegistration } from '@/hooks/use-strategy-registration';

// -----------------------------------------------------------------------------
// The Bag's StrategyRegistry status (docs/STRATEGY_REGISTRY_DESIGN.md): which
// versions' bag.json definitionHash is committed on-chain, as BAG verified it
// from the creator-signed transaction. Anyone can re-check a registered
// version without BAG (scripts/verify-strategy-commitment.ts). The creator can
// register what is missing from their own wallet; nobody else sees the button.
// -----------------------------------------------------------------------------

interface Status {
  configured: boolean;
  viewerIsCreator: boolean;
  registryAddress: string | null;
  registryStrategyId: string | null;
  versions: { version: number; definitionHash: string; registered: boolean; txHash: string | null }[];
  fork: { parentStrategyId: string; parentVersion: number | null } | null;
}

export function StrategyRegistryPanel({ bagId }: { bagId: string }) {
  const { isConnected, walletAddress, connect } = useWallet();
  const [status, setStatus] = useState<Status | null>(null);
  const { phase, error, step, register } = useStrategyRegistration(bagId);

  const load = useCallback(() => {
    fetch(`/api/bags/${bagId}/registry`, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then(setStatus)
      .catch(() => setStatus(null));
  }, [bagId]);

  useEffect(() => load(), [load]);
  useEffect(() => {
    if (phase === 'completed' || phase === 'failed') load();
  }, [phase, load]);

  if (!status || !status.configured) return null;
  const registered = status.versions.filter((v) => v.registered);
  const missing = status.versions.filter((v) => !v.registered);
  if (!status.viewerIsCreator && registered.length === 0) return null;
  const busy = phase === 'preparing' || phase === 'awaiting_signature' || phase === 'confirming';

  return (
    <div className="rounded-xl border border-white/10 bg-white/5 p-6">
      <h3 className="text-lg font-bold text-white mb-1 flex items-center gap-2">
        <ShieldCheck size={18} /> On-chain strategy registry
      </h3>
      <p className="text-sm text-white/60 mb-4">
        Each registered version&apos;s definition hash is committed on-chain by the creator. Anyone can verify a version&apos;s bag.json against it
        without trusting BAG.
      </p>
      <ul className="space-y-1 mb-4">
        {status.versions.map((v) => (
          <li key={v.version} className="flex items-center justify-between text-sm">
            <span className="text-white/80">v{v.version}</span>
            <span className="font-mono text-xs text-white/40">{v.definitionHash.slice(0, 10)}…</span>
            {v.registered ? (
              <span className="inline-flex items-center gap-1 text-emerald-400">
                <CheckCircle2 size={14} /> Registered
              </span>
            ) : (
              <span className="text-white/40">Not registered</span>
            )}
          </li>
        ))}
      </ul>
      {status.fork && (
        <p className="text-xs text-white/50 mb-4">
          Fork of {status.fork.parentStrategyId.slice(0, 8)}… {status.fork.parentVersion ? `v${status.fork.parentVersion}` : '(parent version not recorded)'}
        </p>
      )}
      {status.viewerIsCreator && missing.length > 0 && (
        <>
          {!isConnected || !walletAddress ? (
            <button onClick={() => connect()} className="btn btn-primary">Connect wallet</button>
          ) : (
            <button onClick={() => void register(walletAddress)} disabled={busy} className="btn btn-primary">
              {busy ? (
                <span className="inline-flex items-center gap-2">
                  <Loader2 size={14} className="spin" /> {phase === 'awaiting_signature' ? `Confirm in your wallet — ${step ?? ''}` : phase === 'confirming' ? 'Verifying on-chain…' : 'Preparing…'}
                </span>
              ) : (
                `Register ${missing.length === 1 ? `v${missing[0].version}` : `${missing.length} versions`} on-chain`
              )}
            </button>
          )}
          <p className="text-xs text-white/40 mt-2">Signed by your wallet; BAG never signs on your behalf. A small network fee applies.</p>
        </>
      )}
      {error && (
        <p className="mt-3 text-sm text-red-400 inline-flex items-center gap-1">
          <AlertTriangle size={14} /> {error}
        </p>
      )}
    </div>
  );
}
