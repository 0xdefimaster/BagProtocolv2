'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ArrowDown, Copy, GitBranch, GitCommitVertical } from 'lucide-react';
import type { Enforcement, PassportForkNode, Provenance, StrategyPassport } from '@/types/strategy-passport';

// -----------------------------------------------------------------------------
// Bag page → Passport: the canonical Strategy Passport (GET /api/bags/:id/passport)
// — the same JSON the future MCP get_strategy() returns — with each section's
// provenance and each policy rule's enforcement shown, and version lineage
// (this Bag over time) kept visually separate from fork lineage (other Bags).
// -----------------------------------------------------------------------------

const PROVENANCE_LABEL: Record<Provenance, string> = { ONCHAIN_RECORDED: 'On-chain recorded', DATABASE: 'BAG database', BAG_COMPUTED: 'BAG computed' };
const PROVENANCE_CLASS: Record<Provenance, string> = {
  ONCHAIN_RECORDED: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400',
  DATABASE: 'border-white/15 bg-white/5 text-white/60',
  BAG_COMPUTED: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
};
const ENFORCEMENT_LABEL: Record<Enforcement, string> = {
  ONCHAIN: 'On-chain enforced',
  DATABASE: 'Database enforced',
  BAG_SERVER: 'BAG validated',
  PROVIDER: 'LI.FI enforced',
  DECLARED: 'Declared only',
};
const ENFORCEMENT_CLASS: Record<Enforcement, string> = {
  ONCHAIN: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400',
  DATABASE: 'border-sky-500/30 bg-sky-500/10 text-sky-300',
  BAG_SERVER: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
  PROVIDER: 'border-violet-500/30 bg-violet-500/10 text-violet-300',
  DECLARED: 'border-white/15 bg-white/5 text-white/50',
};

const pct = (bps: number) => `${(bps / 100).toFixed(2).replace(/\.?0+$/, '')}%`;
const short = (v: string | null | undefined, n = 6) => (v ? `${v.slice(0, n)}…${v.slice(-4)}` : '—');
const signed = (v: number | null) => (v === null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`);

function Badge({ className, children }: { className: string; children: React.ReactNode }) {
  return <span className={`inline-block rounded-full border px-2 py-0.5 text-[11px] ${className}`}>{children}</span>;
}

function Section({ title, provenance, children }: { title: string; provenance?: Provenance; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-white/10 bg-white/5 p-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-white/70">{title}</h3>
        {provenance && <Badge className={PROVENANCE_CLASS[provenance]}>{PROVENANCE_LABEL[provenance]}</Badge>}
      </div>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 border-t border-white/5 py-1.5 text-sm first:border-t-0">
      <span className="text-white/50">{label}</span>
      <span className="text-right font-mono text-white/90">{children}</span>
    </div>
  );
}

function ForkNode({ node: n, self }: { node: PassportForkNode; self?: boolean }) {
  if (!n.visible) return <div className="rounded-lg border border-dashed border-white/15 px-3 py-2 text-sm text-white/40">Not public</div>;
  return (
    <div className={`rounded-lg border px-3 py-2 text-sm ${self ? 'border-emerald-500/40 bg-emerald-500/10' : 'border-white/10 bg-white/5'}`}>
      {self ? (
        <span className="font-semibold text-white">{n.name} (this Bag)</span>
      ) : (
        <Link href={`/dashboard/bag/${n.bagId}`} className="font-semibold text-white hover:underline">
          {n.name}
        </Link>
      )}
      {!self && n.creator && <span className="ml-2 text-xs text-white/50">by {n.creator.name ?? short(n.creator.walletAddress)}</span>}
    </div>
  );
}

export function StrategyPassportView({ bagId }: { bagId: string }) {
  const [passport, setPassport] = useState<StrategyPassport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setPassport(null);
    setError(null);
    fetch(`/api/bags/${encodeURIComponent(bagId)}/passport`, { credentials: 'same-origin' })
      .then(async (res) => {
        const body = await res.json().catch(() => null);
        if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status}).`);
        return body.passport as StrategyPassport;
      })
      .then((p) => !cancelled && setPassport(p))
      .catch((err: Error) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, [bagId]);

  if (error) return <p className="text-sm text-red-400">Could not load the Strategy Passport: {error}</p>;
  if (!passport) return <p className="text-sm text-white/50">Loading Strategy Passport…</p>;

  const p = passport;
  const forks = p.lineage.forks;
  const copy = () => {
    navigator.clipboard?.writeText(JSON.stringify(p, null, 2)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-white/50">One canonical description of this strategy. Each section says where its data comes from.</p>
        <button type="button" onClick={copy} className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-white/70 hover:bg-white/10">
          <Copy className="h-3.5 w-3.5" /> {copied ? 'Copied' : 'Copy passport JSON'}
        </button>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Section title="Identity" provenance="DATABASE">
          <Row label="Name">{p.identity.name}</Row>
          <Row label="Symbol">{p.identity.symbol}</Row>
          <Row label="Chain">{p.identity.chain}</Row>
          <Row label="Strategy type">{p.identity.strategyType}</Row>
          <Row label="Mutability">{p.identity.mutability}</Row>
          <Row label="Status">{p.identity.status}</Row>
          <Row label="Creator">{p.creator.name ?? short(p.creator.walletAddress)}</Row>
        </Section>

        <Section title="On-chain record" provenance="ONCHAIN_RECORDED">
          {p.onchain ? (
            <>
              <Row label="Bag id">{short(p.onchain.onChainBagId, 10)}</Row>
              <Row label="Contract">{short(p.onchain.contractAddress)}</Row>
              <Row label="Creator wallet">{short(p.onchain.onChainCreator)}</Row>
              <Row label="On-chain version">{p.onchain.onChainVersion}</Row>
              <Row label="Deployed in block">{p.onchain.deploymentBlock ?? '—'}</Row>
              <Row label="Deployment tx">
                {p.onchain.explorerUrl ? (
                  <a href={p.onchain.explorerUrl} target="_blank" rel="noreferrer" className="underline">
                    {short(p.onchain.deploymentTxHash, 10)}
                  </a>
                ) : (
                  short(p.onchain.deploymentTxHash, 10)
                )}
              </Row>
            </>
          ) : (
            <p className="text-sm text-white/50">Not deployed on-chain yet.</p>
          )}
        </Section>

        <Section title={`Current version${p.currentVersion ? ` · v${p.currentVersion.version}` : ''}`} provenance="DATABASE">
          {p.currentVersion ? (
            <>
              <Row label="Reason">{p.currentVersion.reason || '—'}</Row>
              <Row label="Created">{new Date(p.currentVersion.createdAt).toLocaleDateString()}</Row>
              <Row label="BAG composition hash">{p.currentVersion.compositionHash}</Row>
              <Row label="On-chain composition hash">{p.currentVersion.onchainCompositionHash ? short(p.currentVersion.onchainCompositionHash, 10) : 'not recorded on-chain'}</Row>
            </>
          ) : (
            <p className="text-sm text-white/50">No version yet.</p>
          )}
        </Section>

        <Section title="Performance" provenance="BAG_COMPUTED">
          <Row label="TVL">{p.performance.tvlUsd !== null ? `$${Number(p.performance.tvlUsd).toFixed(2)}` : '—'}</Row>
          <Row label="NAV per share">{p.performance.navPerShare ?? '—'}</Row>
          <Row label="7D / 30D / YTD">
            {signed(p.performance.returns?.['7D'] ?? null)} / {signed(p.performance.returns?.['30D'] ?? null)} / {signed(p.performance.returns?.YTD ?? null)}
          </Row>
          <Row label="Holders">{p.performance.holders ?? '—'}</Row>
          <p className="mt-2 text-xs text-white/40">Returns use recorded NAV snapshots only; periods before the first snapshot show —.</p>
        </Section>
      </div>

      <Section title="Composition" provenance="DATABASE">
        <table className="w-full text-left text-sm">
          <tbody>
            {p.composition.assets.map((a) => (
              <tr key={`${a.chain}:${a.address}`} className="border-t border-white/5 first:border-t-0">
                <td className="py-1.5 font-medium text-white">{a.symbol}</td>
                <td className="py-1.5 text-white/50">{a.name ?? ''}</td>
                <td className="py-1.5 text-white/50">{a.assetType ?? ''}</td>
                <td className="py-1.5 text-xs">{a.routeStatus === 'NO_ROUTE' ? <span className="text-red-400">No route</span> : a.routeStatus === 'ROUTABLE' ? <span className="text-emerald-400">Routable</span> : <span className="text-white/40">Unchecked</span>}</td>
                <td className="py-1.5 text-right font-mono text-white">{pct(a.weightBps)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title="Policy">
        <ul className="space-y-2">
          {p.policy.rules.map((r) => (
            <li key={r.key} className="border-t border-white/5 pt-2 first:border-t-0 first:pt-0">
              <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className="text-white/70">{r.label}</span>
                <span className="flex items-center gap-2">
                  <span className="font-mono text-white">{r.display}</span>
                  <Badge className={ENFORCEMENT_CLASS[r.enforcement]}>{ENFORCEMENT_LABEL[r.enforcement]}</Badge>
                </span>
              </div>
              {r.note && <p className="mt-0.5 text-xs text-white/40">{r.note}</p>}
            </li>
          ))}
        </ul>
      </Section>

      <div className="grid gap-4 md:grid-cols-2">
        <Section title="Version lineage" provenance="DATABASE">
          <p className="mb-3 text-xs text-white/50">This Bag, edited over time. Same strategy identity.</p>
          <ol className="space-y-2">
            {[...p.lineage.versions.nodes].reverse().map((v) => (
              <li key={v.versionId} className="flex items-start gap-2 text-sm">
                <GitCommitVertical className="mt-0.5 h-4 w-4 shrink-0 text-white/40" />
                <div>
                  <span className="font-semibold text-white">v{v.version}</span>
                  {v.isCurrent && <span className="ml-2 text-xs text-emerald-400">current</span>}
                  {v.onchain && <Badge className={`ml-2 ${PROVENANCE_CLASS.ONCHAIN_RECORDED}`}>on-chain v{v.onchain.onchainVersion}</Badge>}
                  <div className="text-xs text-white/50">
                    {new Date(v.createdAt).toLocaleDateString()} · {v.reason || 'no reason given'}
                  </div>
                </div>
              </li>
            ))}
          </ol>
        </Section>

        <Section title="Fork lineage" provenance="DATABASE">
          <p className="mb-3 text-xs text-white/50">Other Bags copied from this one, or that this one was copied from. Separate strategies.</p>
          <div className="space-y-2">
            {[...forks.ancestors].reverse().map((a) => (
              <div key={a.bagId}>
                <ForkNode node={a} />
                <ArrowDown className="mx-auto my-1 h-3.5 w-3.5 text-white/30" />
              </div>
            ))}
            <ForkNode
              node={{ bagId: p.identity.bagId, visible: true, name: p.identity.name, symbol: p.identity.symbol, status: p.identity.status, creator: null, createdAt: p.identity.createdAt }}
              self
            />
            {forks.children.length > 0 && (
              <div className="ml-4 space-y-2 border-l border-white/10 pl-3">
                {forks.children.map((c) => (
                  <div key={c.bagId} className="flex items-center gap-2">
                    <GitBranch className="h-3.5 w-3.5 text-white/30" />
                    <ForkNode node={c} />
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="mt-3 space-y-1 text-xs text-white/50">
            <div>{forks.isOriginal ? 'Original strategy (not a fork).' : `Fork of ${forks.ancestors.length} ancestor${forks.ancestors.length === 1 ? '' : 's'}.`}</div>
            <div>
              {forks.childCount} direct fork{forks.childCount === 1 ? '' : 's'}
              {forks.childCount > forks.children.length ? ` (${forks.childCount - forks.children.length} not public)` : ''}.
            </div>
            <div>Forks pay the root creator {pct(forks.forkRoyaltyBps)} of every deposit.</div>
          </div>
        </Section>
      </div>
    </div>
  );
}
