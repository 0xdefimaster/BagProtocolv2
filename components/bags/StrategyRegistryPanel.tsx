'use client';

import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Loader2, ShieldCheck, AlertTriangle, BadgeCheck } from 'lucide-react';
import { useWallet } from '@/lib/wallet-context';
import { useStrategyRegistration } from '@/hooks/use-strategy-registration';
import { useRegistryBrowserVerification } from '@/hooks/use-registry-browser-verification';

// -----------------------------------------------------------------------------
// The Bag's StrategyRegistry status (docs/STRATEGY_REGISTRY_DESIGN.md): which
// versions' bag.json definitionHash is committed on-chain, as BAG verified it
// from the creator-signed transaction. Anyone can re-check a registered
// version without BAG (packages/bag-sdk/examples/verify-registry.ts), and the
// panel does exactly that in the viewer's browser with the SDK: each registered
// version gets an independent "verified in your browser" result. The creator
// can register what is missing from their own wallet; nobody else sees the button.
// "Weights on-chain": the version's allocations are also published to
// StrategyCompositions (docs/STRATEGY_COMPOSITIONS_DESIGN.md), so any app or
// contract can read the assets and weights, not only the hash.
// -----------------------------------------------------------------------------

interface Status {
  configured: boolean;
  viewerIsCreator: boolean;
  registryAddress: string | null;
  chain?: string;
  creatorWallet?: string | null;
  registryStrategyId: string | null;
  versions: { version: number; definitionHash: string; registered: boolean; txHash: string | null; compositionPublished?: boolean }[];
  fork: { parentStrategyId: string; parentVersion: number | null } | null;
  compositionPending?: boolean;
}

export function StrategyRegistryPanel({ bagId }: { bagId: string }) {
  const { isConnected, walletAddress, connect } = useWallet();
  const [status, setStatus] = useState<Status | null>(null);
  const { phase, error, step, register } = useStrategyRegistration(bagId);
  const registeredVersions = (status?.versions ?? []).filter((v) => v.registered).map((v) => v.version);
  const { result: browser, checking } = useRegistryBrowserVerification({
    bagId,
    chain: status?.chain ?? null,
    creatorWallet: status?.creatorWallet ?? null,
    serverRegistryAddress: status?.registryAddress ?? null,
    versions: registeredVersions,
  });
  const browserCheck = (version: number) => browser?.checks.find((c) => c.version === version) ?? null;

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
              <span className="inline-flex items-center gap-3">
                <span className="inline-flex items-center gap-1 text-emerald-400">
                  <CheckCircle2 size={14} /> Registered
                </span>
                {v.compositionPublished && (
                  <span className="inline-flex items-center gap-1 text-emerald-300 text-xs" title="Assets and weights are readable on-chain (StrategyCompositions)">
                    <CheckCircle2 size={12} /> Weights on-chain
                  </span>
                )}
                <BrowserBadge check={browserCheck(v.version)} checking={checking} />
              </span>
            ) : (
              <span className="text-white/40">Not registered</span>
            )}
          </li>
        ))}
      </ul>
      {browser?.registry && registered.length > 0 && (
        <p className="text-xs text-white/50 mb-4">
          Checked in your browser with the open-source BAG SDK: the registry at <span className="font-mono">{browser.registry}</span> holds each
          version&apos;s definition hash, committed by <span className="font-mono">{status.creatorWallet}</span>. BAG&apos;s own record is not used for this check.
        </p>
      )}
      {browser?.registryMismatch && (
        <p className="text-xs text-amber-400 mb-4 inline-flex items-center gap-1">
          <AlertTriangle size={12} /> BAG is configured with a different registry address than the SDK knows for this chain.
        </p>
      )}
      {status.fork && (
        <p className="text-xs text-white/50 mb-4">
          Fork of {status.fork.parentStrategyId.slice(0, 8)}… {status.fork.parentVersion ? `v${status.fork.parentVersion}` : '(parent version not recorded)'}
        </p>
      )}
      {status.viewerIsCreator && (missing.length > 0 || status.compositionPending) && (
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
                missing.length > 0
                  ? `Register ${missing.length === 1 ? `v${missing[0].version}` : `${missing.length} versions`} on-chain`
                  : `Publish v${registered[registered.length - 1]?.version ?? ''} weights on-chain`
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

function BrowserBadge({ check, checking }: { check: { state: 'VERIFIED' | 'MISMATCH' | 'UNAVAILABLE'; detail?: string } | null; checking: boolean }) {
  if (!check) return checking ? <span className="inline-flex items-center gap-1 text-white/40 text-xs"><Loader2 size={12} className="spin" /> Checking…</span> : null;
  if (check.state === 'VERIFIED') {
    return (
      <span className="inline-flex items-center gap-1 text-emerald-300 text-xs" title="Recomputed and read from the chain in your browser">
        <BadgeCheck size={14} /> Verified in your browser
      </span>
    );
  }
  if (check.state === 'MISMATCH') {
    return (
      <span className="inline-flex items-center gap-1 text-red-400 text-xs" title={check.detail}>
        <AlertTriangle size={12} /> Does not match the chain
      </span>
    );
  }
  return (
    <span className="text-white/40 text-xs" title={check.detail}>
      Could not check
    </span>
  );
}
