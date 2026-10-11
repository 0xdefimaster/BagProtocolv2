'use client';

import { useCallback, useEffect, useState } from 'react';
import { ProofView } from '@/components/proof/ProofView';
import type { ProtocolProof } from '@/lib/server/protocol-proof';

/** The API is cached for a minute and the passes behind it run every 5; refresh at the cache's pace while visible. */
const PROOF_REFRESH_MS = 60_000;

// Public proof page: protocol-wide figures anyone can check against the chain, each linked to its transaction.
export default function ProofPage() {
  const [proof, setProof] = useState<ProtocolProof | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/proof');
      const body = await res.json().catch(() => null);
      if (!res.ok || !body) throw new Error(body?.error ?? `HTTP ${res.status}`);
      setProof(body as ProtocolProof);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    load();
    const tick = () => {
      if (document.visibilityState === 'visible') load();
    };
    const t = setInterval(tick, PROOF_REFRESH_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [load]);

  return (
    <main className="wrap" style={{ paddingBottom: 80, paddingTop: 44 }}>
      <div className="app-intro">
        <span className="eyebrow">
          <span className="dot" />
          On-chain proof
        </span>
        <h1 style={{ marginTop: 16 }}>Proof</h1>
        <p className="lead">What BAG Protocol holds, executes and pays out, each figure linked to its transaction on-chain.</p>
      </div>

      {proof ? (
        <ProofView proof={proof} />
      ) : error ? (
        <div className="positions-empty" style={{ marginTop: 28 }}>
          Could not load the proof figures: {error}{' '}
          <button type="button" className="btn btn-ghost" style={{ padding: '4px 10px', fontSize: 12.5 }} onClick={() => load()}>
            Retry
          </button>
        </div>
      ) : (
        <div className="positions-empty" style={{ marginTop: 28 }}>
          Loading proof…
        </div>
      )}

      <p className="mono" style={{ fontSize: 11, color: 'var(--mute)', marginTop: 16, lineHeight: 1.6 }}>
        TVL and returns come from NAV snapshots taken every 5 minutes. A Bag counts as verified when every holder&apos;s
        wallet was checked against BAG&apos;s records on Robinhood Chain in the last 15 minutes with no outflow pending.
        Fees and exits come from the RedeemSettlement <span>Settled</span> and CreatorRewardsVault <span>Credited</span>{' '}
        events; execution outcomes cover the last {proof?.windowDays ?? 30} days. Returns are before any performance fee
        charged on exit. Not investment advice.
      </p>
    </main>
  );
}
