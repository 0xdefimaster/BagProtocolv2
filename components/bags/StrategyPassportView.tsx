'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ArrowDown, Copy, GitBranch, GitCommitVertical } from 'lucide-react';
import type { PassportForkNode, SourceInfo, StrategyPassport } from '@/types/strategy-passport';
import type { DataSource, Enforcement, PolicyRule, RuleValueSource, StrategyPolicy, StrategyPolicyKey } from '@/types/strategy-policy';

// -----------------------------------------------------------------------------
// Bag page → Passport: the canonical Strategy Passport (GET /api/bags/:id/passport)
// — the same JSON the future MCP get_strategy() returns. Every section shows
// where its data comes from; every rule shows who enforces it, with on-chain
// guarantees kept apart from BAG-validated / attested / declared rules.
// "On-chain record" means BAG's record of a confirmed transaction — this page
// never claims the chain was re-read for the request.
// -----------------------------------------------------------------------------

const SOURCE_LABEL: Record<DataSource, string> = {
  ONCHAIN: 'On-chain record',
  DATABASE: 'BAG database',
  BAG_DERIVED: 'BAG derived',
  BAG_ATTESTED: 'BAG attested',
};
const SOURCE_CLASS: Record<DataSource, string> = {
  ONCHAIN: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400',
  DATABASE: 'border-white/15 bg-white/5 text-white/60',
  BAG_DERIVED: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
  BAG_ATTESTED: 'border-orange-500/30 bg-orange-500/10 text-orange-300',
};
const ENFORCEMENT_LABEL: Record<Enforcement, string> = {
  ONCHAIN_ENFORCED: 'On-chain guaranteed',
  COMPOSER_ENFORCED: 'LI.FI Composer enforced',
  DATABASE_TRIGGER: 'Database enforced',
  SERVER_ENFORCED: 'BAG validated',
  ATTESTED_ONLY: 'BAG attested',
  DECLARED_ONLY: 'Declared only',
};
const ENFORCEMENT_HINT: Record<Enforcement, string> = {
  ONCHAIN_ENFORCED: 'The transaction reverts if this is broken.',
  COMPOSER_ENFORCED: 'LI.FI Composer refuses to build the transaction otherwise.',
  DATABASE_TRIGGER: "BAG's database rejects any write that breaks it.",
  SERVER_ENFORCED: "BAG's server checks it before building anything. Not a chain guarantee.",
  ATTESTED_ONLY: 'BAG states it; nothing blocks on it.',
  DECLARED_ONLY: 'Stated by the creator; nothing executes it today.',
};
const ENFORCEMENT_CLASS: Record<Enforcement, string> = {
  ONCHAIN_ENFORCED: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400',
  COMPOSER_ENFORCED: 'border-violet-500/30 bg-violet-500/10 text-violet-300',
  DATABASE_TRIGGER: 'border-sky-500/30 bg-sky-500/10 text-sky-300',
  SERVER_ENFORCED: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
  ATTESTED_ONLY: 'border-orange-500/30 bg-orange-500/10 text-orange-300',
  DECLARED_ONLY: 'border-white/15 bg-white/5 text-white/50',
};
const VALUE_SOURCE_LABEL: Record<RuleValueSource, string> = { CREATOR_RECIPE: 'set by creator', BAG_PROTOCOL: 'BAG protocol', LIFI_COMPOSER: 'LI.FI default' };

const pct = (bps: number) => `${(bps / 100).toFixed(2).replace(/\.?0+$/, '')}%`;
const short = (v: string | null | undefined, n = 6) => (v ? `${v.slice(0, n)}…${v.slice(-4)}` : '—');
const signed = (v: number | null) => (v === null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`);

/** Human labels and value formatting for each policy rule (presentation only — the API stays raw). */
const RULES: { key: StrategyPolicyKey; label: string; format: (policy: StrategyPolicy) => string }[] = [
  { key: 'maxSingleAssetWeightBps', label: 'Max single asset', format: (p) => pct(p.maxSingleAssetWeightBps.value) },
  { key: 'minSingleAssetWeightBps', label: 'Min single asset', format: (p) => pct(p.minSingleAssetWeightBps.value) },
  { key: 'maxAssets', label: 'Max assets', format: (p) => String(p.maxAssets.value) },
  { key: 'minInvestmentUsd', label: 'Min investment', format: (p) => (p.minInvestmentUsd.value > 0 ? `$${p.minInvestmentUsd.value}` : 'None') },
  { key: 'maxSlippageBps', label: 'Max slippage per swap', format: (p) => `${p.maxSlippageBps.value} bps` },
  { key: 'maxPriceImpactBps', label: 'Max price impact', format: (p) => `${pct(p.maxPriceImpactBps.value)} (buyer may accept up to ${pct(p.maxPriceImpactBps.consentCeilingBps)})` },
  { key: 'performanceFeeBps', label: 'Performance fee', format: (p) => `${pct(p.performanceFeeBps.value)} of realized profit (max ${pct(p.performanceFeeBps.maxBps)})` },
  { key: 'noRouteAssetPolicy', label: 'If an asset has no route', format: (p) => `${p.noRouteAssetPolicy.value} (skip at most ${pct(p.noRouteAssetPolicy.maxUnroutableWeightBps)})` },
  { key: 'compositionChanges', label: 'Composition changes', format: (p) => p.compositionChanges.value.replace(/_/g, ' ').toLowerCase() },
  { key: 'rebalanceRule', label: 'Rebalance rule', format: (p) => `${p.rebalanceRule.value.frequency}, drift ${pct(p.rebalanceRule.value.driftThresholdBps)}` },
];

function Badge({ className, title, children }: { className: string; title?: string; children: React.ReactNode }) {
  return (
    <span title={title} className={`inline-block rounded-full border px-2 py-0.5 text-[11px] ${className}`}>
      {children}
    </span>
  );
}

function SourceBadge({ info }: { info: SourceInfo }) {
  const title =
    info.source === 'ONCHAIN'
      ? `Recorded by BAG from a confirmed transaction${info.asOf ? ` (${new Date(info.asOf).toLocaleString()})` : ''}; checkable via its tx hash. Not re-read from the chain for this page.`
      : info.asOf
        ? `As of ${new Date(info.asOf).toLocaleString()}`
        : undefined;
  return (
    <Badge className={SOURCE_CLASS[info.source]} title={title}>
      {SOURCE_LABEL[info.source]}
      {info.source === 'ONCHAIN' && !info.readFromChainThisRequest ? ' · cached' : ''}
    </Badge>
  );
}

function Section({ title, sourceInfo, children }: { title: string; sourceInfo?: SourceInfo; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-white/10 bg-white/5 p-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-white/70">{title}</h3>
        {sourceInfo && <SourceBadge info={sourceInfo} />}
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

function PolicyRow({ label, display, rule }: { label: string; display: string; rule: PolicyRule<unknown> }) {
  return (
    <li className="border-t border-white/5 pt-2 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="text-white/70">{label}</span>
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-white">{display}</span>
          <Badge className={ENFORCEMENT_CLASS[rule.enforcement]}>{ENFORCEMENT_LABEL[rule.enforcement]}</Badge>
        </span>
      </div>
      <p className="mt-0.5 text-xs text-white/40">
        {ENFORCEMENT_HINT[rule.enforcement]} Value: {VALUE_SOURCE_LABEL[rule.source]}
        {rule.status === 'LOCKED' ? ' · locked' : rule.status === 'NOT_EXECUTED' ? ' · not executed' : ''}.
      </p>
    </li>
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
  const policy = p.policy;
  const guaranteed = policy ? RULES.filter((r) => policy[r.key].enforcement === 'ONCHAIN_ENFORCED') : [];
  const offchain = policy ? RULES.filter((r) => policy[r.key].enforcement !== 'ONCHAIN_ENFORCED') : [];
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
        <Section title="Identity" sourceInfo={p.identity.sourceInfo}>
          <Row label="Name">{p.identity.name}</Row>
          <Row label="Symbol">{p.identity.symbol}</Row>
          <Row label="Chain">{p.identity.chain}</Row>
          <Row label="Strategy type">{p.identity.strategyType}</Row>
          <Row label="Mutability">{p.identity.mutability}</Row>
          <Row label="Status">{p.identity.status}</Row>
        </Section>

        <Section title="Creator" sourceInfo={p.creator.sourceInfo}>
          <Row label="Name">{p.creator.name ?? '—'}</Row>
          <Row label="Wallet">{short(p.creator.walletAddress)}</Row>
        </Section>

        <Section title="On-chain record" sourceInfo={p.onchain?.sourceInfo}>
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
              <p className="mt-2 text-xs text-white/40">BAG&apos;s record of the confirmed deployment. Check it on the explorer; it was not re-read from the chain for this page.</p>
            </>
          ) : (
            <p className="text-sm text-white/50">Not deployed on-chain yet.</p>
          )}
        </Section>

        <Section title={`Current version${p.currentVersion ? ` · v${p.currentVersion.version}` : ''}`} sourceInfo={p.currentVersion?.sourceInfo}>
          {p.currentVersion ? (
            <>
              <Row label="Reason">{p.currentVersion.reason || '—'}</Row>
              <Row label="Created">{new Date(p.currentVersion.createdAt).toLocaleDateString()}</Row>
              <Row label="On-chain composition hash">{p.currentVersion.onchainCompositionHash ? short(p.currentVersion.onchainCompositionHash, 10) : 'not recorded on-chain'}</Row>
            </>
          ) : (
            <p className="text-sm text-white/50">No version yet.</p>
          )}
        </Section>
      </div>

      <Section title="Composition" sourceInfo={p.composition.sourceInfo}>
        <table className="w-full text-left text-sm">
          <tbody>
            {p.composition.assets.map((a) => (
              <tr key={`${a.chain}:${a.address}`} className="border-t border-white/5 first:border-t-0">
                <td className="py-1.5 font-medium text-white">{a.symbol}</td>
                <td className="py-1.5 text-white/50">{a.name ?? ''}</td>
                <td className="py-1.5 text-white/50">{a.assetType ?? ''}</td>
                <td className="py-1.5 text-xs" title="BAG attested: background route check, may be stale; purchases re-quote live.">
                  {a.routeStatus === 'NO_ROUTE' ? <span className="text-red-400">No route*</span> : a.routeStatus === 'ROUTABLE' ? <span className="text-emerald-400">Routable*</span> : <span className="text-white/40">Unchecked</span>}
                </td>
                <td className="py-1.5 text-right font-mono text-white">{pct(a.weightBps)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-xs text-white/40">* Route status is BAG attested (background check); purchases quote live.</p>
      </Section>

      <Section title="Performance" sourceInfo={p.performance.sourceInfo}>
        <Row label="TVL">{p.performance.tvlUsd !== null ? `$${Number(p.performance.tvlUsd).toFixed(2)}` : '—'}</Row>
        <Row label="NAV per share">{p.performance.navPerShare ?? '—'}</Row>
        <Row label="7D / 30D / YTD">
          {signed(p.performance.returns?.['7D'] ?? null)} / {signed(p.performance.returns?.['30D'] ?? null)} / {signed(p.performance.returns?.YTD ?? null)}
        </Row>
        <Row label="Holders">{p.performance.holders ?? '—'}</Row>
        <p className="mt-2 text-xs text-white/40">Computed by BAG from its price providers and recorded NAV snapshots; periods before the first snapshot show —.</p>
      </Section>

      <Section title="Strategy rules">
        {policy ? (
          <div className="space-y-4">
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-emerald-400">On-chain guaranteed</p>
              <ul className="space-y-2">
                {guaranteed.map((r) => (
                  <PolicyRow key={r.key} label={r.label} display={r.format(policy)} rule={policy[r.key]} />
                ))}
              </ul>
            </div>
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-white/50">Enforced off-chain, attested or declared</p>
              <ul className="space-y-2">
                {offchain.map((r) => (
                  <PolicyRow key={r.key} label={r.label} display={r.format(policy)} rule={policy[r.key]} />
                ))}
              </ul>
            </div>
          </div>
        ) : (
          <p className="text-sm text-white/50">No rules until the Bag has a version.</p>
        )}
      </Section>

      <div className="grid gap-4 md:grid-cols-2">
        <Section title="Version lineage" sourceInfo={p.lineage.versions.sourceInfo}>
          <p className="mb-3 text-xs text-white/50">This Bag, edited over time. Same strategy identity.</p>
          <ol className="space-y-2">
            {[...p.lineage.versions.nodes].reverse().map((v) => (
              <li key={v.version} className="flex items-start gap-2 text-sm">
                <GitCommitVertical className="mt-0.5 h-4 w-4 shrink-0 text-white/40" />
                <div>
                  <span className="font-semibold text-white">v{v.version}</span>
                  {v.isCurrent && <span className="ml-2 text-xs text-emerald-400">current</span>}
                  {v.onchain && <Badge className={`ml-2 ${SOURCE_CLASS.ONCHAIN}`}>on-chain record v{v.onchain.onchainVersion}</Badge>}
                  <div className="text-xs text-white/50">
                    {new Date(v.createdAt).toLocaleDateString()} · {v.reason || 'no reason given'}
                  </div>
                </div>
              </li>
            ))}
          </ol>
        </Section>

        <Section title="Fork lineage" sourceInfo={forks.sourceInfo}>
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
            {!forks.isOriginal && <div>Which parent version was copied is not recorded.</div>}
          </div>
        </Section>
      </div>
    </div>
  );
}
