'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { CalendarClock, Loader2, CheckCircle2 } from 'lucide-react';
import type { DcaTrialBag } from '@/lib/dca/reference';
import { buildDcaPlan, displayUsdg, type DcaSettings } from '@/lib/dca/plan';
import { supportsDcaTrial } from '@/lib/dca/profile';
import type { DcaTrialState } from '@/lib/dca/types';

const initial: DcaSettings = { budget: '100', amount: '10', purchases: '10', interval: '1', unit: 'days' };
const date = (value: string) => new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const headers = { 'Content-Type': 'application/json', 'x-bag-local-trial': '1' };

export function DcaTrialPanel({ bag }: { bag: DcaTrialBag }) {
  const [settings, setSettings] = useState(initial);
  const [trial, setTrial] = useState<DcaTrialState | null>(null);
  const [starting, setStarting] = useState(false), [error, setError] = useState<string | null>(null);
  const [clock, setClock] = useState(() => Date.now());
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { setSettings(initial); setTrial(null); setError(null); setClock(Date.now()); }, [bag.id]);
  const preview = useMemo(() => {
    try { return { plan: buildDcaPlan(settings, clock), error: null }; }
    catch (err) { return { plan: null, error: (err as Error).message }; }
  }, [settings, clock]);
  const busy = starting || trial?.state === 'RUNNING';
  const supported = supportsDcaTrial(bag);
  const endpoint = `/api/bags/${encodeURIComponent(bag.id)}/dca-trial`;
  const update = (key: keyof DcaSettings, value: string) => {
    setSettings(old => ({ ...old, [key]: value })); setTrial(null); setError(null); setClock(Date.now());
  };
  useEffect(() => {
    if (trial?.state !== 'RUNNING') return;
    const controller = new AbortController();
    let stopped = false, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const response = await fetch(`${endpoint}?trial=${trial.id}`, { headers, cache: 'no-store', signal: controller.signal });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || 'Could not read the local trial.');
        if (!stopped) { setTrial(body.trial); setError(null); }
        if (!stopped && body.trial.state === 'RUNNING') timer = setTimeout(poll, 2000);
      } catch (err) {
        if (!stopped) { setError((err as Error).message); timer = setTimeout(poll, 5000); }
      }
    };
    timer = setTimeout(poll, 1000);
    return () => { stopped = true; controller.abort(); clearTimeout(timer); };
  }, [endpoint, trial?.id, trial?.state]);
  async function run() {
    if (!preview.plan || !supported || busy) return;
    setStarting(true); setError(null);
    const bagId = bag.id;
    try {
      const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(settings) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Could not start the local trial.');
      if (alive.current && bagId === bag.id) setTrial(body.trial);
    } catch (err) { if (alive.current) setError((err as Error).message); }
    finally { if (alive.current) setStarting(false); }
  }
  return (
    <section aria-labelledby="dca-trial-heading" className="rounded-xl border border-emerald-400/20 bg-emerald-400/[0.04] p-5 md:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-5">
        <div><h2 id="dca-trial-heading" className="flex items-center gap-2 text-lg font-semibold text-white"><CalendarClock className="h-5 w-5 text-emerald-400" /> Scheduled purchases</h2>
          <p className="mt-1 text-sm text-white/60">Choose the purchase count, amount, total budget and interval.</p></div>
        <span className="rounded-full border border-amber-400/25 px-3 py-1 text-xs text-amber-200">Local trial</span>
      </div>
      <p className="mb-5 text-sm text-white/60">This trial uses a local copy of the chain with real Composer quotes. Time is advanced locally. Your wallet is not charged and live purchases are not activated.</p>
      <fieldset disabled={busy} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 disabled:opacity-60">
        <label className="text-sm text-white/70">Total budget (USDG)
          <input value={settings.budget} onChange={e => update('budget', e.target.value)} inputMode="decimal" autoComplete="off" className="mt-2 w-full rounded-lg border border-white/15 bg-black/40 px-3 py-2.5 text-white" /></label>
        <label className="text-sm text-white/70">Amount per purchase (USDG)
          <input value={settings.amount} onChange={e => update('amount', e.target.value)} inputMode="decimal" autoComplete="off" className="mt-2 w-full rounded-lg border border-white/15 bg-black/40 px-3 py-2.5 text-white" /></label>
        <label className="text-sm text-white/70">Number of purchases
          <input value={settings.purchases} onChange={e => update('purchases', e.target.value)} inputMode="numeric" autoComplete="off" className="mt-2 w-full rounded-lg border border-white/15 bg-black/40 px-3 py-2.5 text-white" /></label>
        <div className="text-sm text-white/70"><label htmlFor="dca-interval">Purchase every</label>
          <div className="mt-2 flex gap-2"><input id="dca-interval" value={settings.interval} onChange={e => update('interval', e.target.value)} inputMode="numeric" className="w-20 rounded-lg border border-white/15 bg-black/40 px-3 py-2.5 text-white" />
            <select aria-label="Interval unit" value={settings.unit} onChange={e => update('unit', e.target.value)} className="min-w-0 flex-1 rounded-lg border border-white/15 bg-black px-3 py-2.5 text-white"><option value="minutes">minutes</option><option value="hours">hours</option><option value="days">days</option><option value="weeks">weeks</option></select></div></div>
      </fieldset>
      {preview.error && <p role="alert" className="mt-4 text-sm text-amber-200">{preview.error}</p>}
      {preview.plan && <div className="mt-5 grid gap-3 rounded-lg bg-black/25 p-4 text-sm sm:grid-cols-2" aria-label="Purchase schedule">
        <p className="text-white"><strong>{preview.plan.purchases} purchases</strong> × {displayUsdg(preview.plan.amountRaw)} USDG</p>
        <p className="text-white/60">Total planned: {displayUsdg(preview.plan.budgetRaw)} USDG</p>
        <p className="text-white/60">First: {date((trial?.plan ?? preview.plan).firstAt)}</p><p className="text-white/60">Last: {date((trial?.plan ?? preview.plan).lastAt)}</p>
      </div>}
      <p className="mt-3 text-xs leading-relaxed text-white/50">Total budget must equal the purchase count × amount per purchase. The first purchase is due after one interval; the last date follows from your count and interval. The Bag’s USDG allocation stays reserved in the account.</p>
      {!supported && <p className="mt-4 text-sm text-amber-200">This first trial supports 40% WETH / 30% cbBTC / 30% USDG on Robinhood. This Bag is not supported; its allocation will not be substituted.</p>}
      <div className="mt-5 flex flex-wrap items-center gap-4"><button type="button" onClick={run} disabled={!preview.plan || !supported || busy} className="inline-flex items-center gap-2 rounded-lg bg-emerald-400 px-4 py-2.5 font-semibold text-black disabled:cursor-not-allowed disabled:opacity-40">{busy && <Loader2 className="h-4 w-4 animate-spin" />}{busy ? 'Trial running…' : 'Run local trial'}</button>
        {trial?.state === 'RUNNING' && <p role="status" className="text-sm text-white/70">{trial.completedPurchases}/{trial.plan.purchases} purchases · {trial.completedChecks} checks passed</p>}</div>
      {error && <p role="alert" className="mt-4 text-sm text-amber-200">{error}</p>}
      {trial?.state === 'FAILED' && <p role="alert" className="mt-4 text-sm text-amber-200">{trial.error}</p>}
      {trial?.state === 'SUCCEEDED' && trial.result && <div role="status" className="mt-5 space-y-2 rounded-lg border border-emerald-400/20 p-4 text-sm text-white/75">
        <p className="flex items-center gap-2 font-semibold text-emerald-300"><CheckCircle2 className="h-4 w-4" />Local trial verified · {trial.result.checks.pass} checks passed</p>
        <p>{trial.completedPurchases} purchases · {displayUsdg(trial.result.spentUsdgRaw)} USDG swapped · {displayUsdg(trial.result.finalUsdgRaw)} USDG remaining</p>
        <p>{displayUsdg(trial.result.reservedUsdgRaw)} USDG of the remaining balance belongs to the Bag’s cash allocation. No public-chain transactions were sent.</p>
        <p className="text-xs text-white/45">Local account/session model. MetaMask/Rabby permission screens and live automation are a separate step.</p>
      </div>}
    </section>
  );
}
