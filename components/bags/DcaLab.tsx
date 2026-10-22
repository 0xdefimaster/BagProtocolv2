'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { Bag } from '@/types';
import { DcaTrialPanel } from './DcaTrialPanel';
import { DCA_REFERENCE_BAG, DCA_REFERENCE_ID, type DcaTrialBag } from '@/lib/dca/reference';

export function DcaLab() {
  const [bags, setBags] = useState<Pick<Bag, 'id' | 'name'>[]>([]), [id, setId] = useState(DCA_REFERENCE_ID);
  const [bag, setBag] = useState<DcaTrialBag | null>(DCA_REFERENCE_BAG), [error, setError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/bags', { signal: controller.signal, cache: 'no-store' }).then(async r => {
      const body = await r.json(); if (!r.ok) throw new Error(body.error || 'Could not load Bags.');
      setBags(body.bags); setLoaded(true);
    }).catch(err => { if (!controller.signal.aborted) { setListError(err.message); setLoaded(true); } });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    setBag(null); setError(null); if (!id) return;
    if (id === DCA_REFERENCE_ID) { setBag(DCA_REFERENCE_BAG); return; }
    const controller = new AbortController();
    fetch(`/api/bags/${encodeURIComponent(id)}`, { signal: controller.signal, cache: 'no-store' }).then(async r => {
      const body = await r.json(); if (!r.ok) throw new Error(body.error || 'Could not load this Bag.');
      if (!controller.signal.aborted) setBag(body.bag);
    }).catch(err => { if (!controller.signal.aborted) setError(err.message); });
    return () => controller.abort();
  }, [id]);
  return <div className="space-y-6">
    <label className="block max-w-xl text-sm text-white/70">Choose a Bag
      <select value={id} onChange={e => setId(e.target.value)} className="mt-2 w-full rounded-lg border border-white/15 bg-black p-3 text-white">
        <option value={DCA_REFERENCE_ID}>{DCA_REFERENCE_BAG.name}</option>
        <optgroup label={loaded ? 'Live Bags' : 'Loading live Bags…'}>{bags.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}</optgroup>
      </select></label>
    {listError && <p className="text-sm text-white/50">Live Bags could not be loaded. You can still use the explicitly selected local reference basket.</p>}
    {loaded && !bags.length && !listError && <p className="text-sm text-white/60">No live Bags are available. <Link href="/dashboard/explore" className="text-emerald-300">Explore Bags</Link></p>}
    {error && <p role="alert" className="text-sm text-amber-200">{error}</p>}
    {id && !bag && !error && <p role="status" className="text-white/60">Loading strategy…</p>}
    {bag && <div><div className="mb-4 flex flex-wrap items-center justify-between gap-2"><h2 className="text-xl font-semibold text-white">{bag.name}{bag.version ? ` · v${bag.version}` : ''}</h2>{bag.id !== DCA_REFERENCE_ID && <Link href={`/dashboard/bag/${encodeURIComponent(bag.id)}`} className="text-sm text-emerald-300">View Bag →</Link>}</div><DcaTrialPanel key={bag.id} bag={bag} /></div>}
  </div>;
}
