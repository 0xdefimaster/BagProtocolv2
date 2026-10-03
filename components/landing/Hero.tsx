'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import ArrowIcon from '@/components/ui/ArrowIcon';
import { usePublicBags } from '@/hooks/usePublicBags';
import { BagPosition } from '@/types';

// -----------------------------------------------------------------------------
// Hero: category (eyebrow) → value prop (h1 + lead) → differentiator (the line
// under the lead), one primary and one secondary CTA.
//
// The visual is a working mini-demo of the product: an amount field, the
// strategy's allocation recomputed for that amount, the route, and the
// resulting portfolio. The amount cycles through a few values until the
// visitor types their own (no fixed "$1,000"). It uses a REAL published Bag
// when one exists (usePublicBags → GET /api/bags) and a clearly labelled
// EXAMPLE otherwise. Dollar splits are display arithmetic only; real
// purchases are priced and quoted server-side.
// -----------------------------------------------------------------------------

const EXAMPLE_BAG = {
  name: 'AI Growth',
  creator: '@example',
  composition: [
    { symbol: 'NVDA', weight: 40 },
    { symbol: 'MSFT', weight: 30 },
    { symbol: 'TSLA', weight: 30 },
  ] as BagPosition[],
};

const DEMO_AMOUNTS = [250, 1000, 10000];
const STAGES = ['Strategy', 'Amount', 'Allocation', 'Route', 'Portfolio'];

const usd = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: n >= 100 ? 0 : 2 });

function prefersReducedMotion() {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export default function Hero() {
  const { bags } = usePublicBags();
  const realBag = bags.length > 0 ? bags[0] : null;
  const isExample = !realBag;
  const bag = realBag
    ? { name: realBag.name, creator: realBag.creator?.name ?? null, composition: realBag.composition }
    : EXAMPLE_BAG;
  const rows = useMemo(() => [...bag.composition].sort((a, b) => b.weight - a.weight).slice(0, 4), [bag.composition]);
  const buyHref = realBag ? `/dashboard/bag/${realBag.id}` : '/dashboard/explore';

  const [input, setInput] = useState(String(DEMO_AMOUNTS[1]));
  const [touched, setTouched] = useState(false);
  const [stage, setStage] = useState(STAGES.length - 1);
  const demoIndex = useRef(1);

  // Cycle demo amounts until the visitor edits the field.
  useEffect(() => {
    if (touched || prefersReducedMotion()) return;
    const t = setInterval(() => {
      demoIndex.current = (demoIndex.current + 1) % DEMO_AMOUNTS.length;
      setInput(String(DEMO_AMOUNTS[demoIndex.current]));
    }, 4200);
    return () => clearInterval(t);
  }, [touched]);

  // Walk the pipeline each time the amount changes.
  useEffect(() => {
    if (prefersReducedMotion()) {
      setStage(STAGES.length - 1);
      return;
    }
    setStage(1);
    let s = 1;
    const t = setInterval(() => {
      s += 1;
      setStage(s);
      if (s >= STAGES.length - 1) clearInterval(t);
    }, 380);
    return () => clearInterval(t);
  }, [input]);

  const amount = Number(input.replace(/,/g, ''));
  const valid = Number.isFinite(amount) && amount > 0;

  return (
    <section className="hero wrap" aria-labelledby="hero-title">
      <div className="hero-grid">
        <div>
          <span className="eyebrow">
            <span className="dot"></span>Programmable portfolios for onchain assets
          </span>
          <h1 id="hero-title">
            One strategy.
            <br />
            <span className="accent">A complete portfolio.</span>
          </h1>
          <p className="lead">
            Choose a strategy, enter an amount, and Bag turns it into a complete
            portfolio — allocated, routed and executed from your own wallet.
          </p>
          <p className="hero-diff">
            Every strategy is a <b>Bag</b>: published by a creator, invested in with one action,
            forked with its lineage intact, and paying royalties to the creator who started it.
          </p>
          <div className="hero-ctas">
            <Link className="btn btn-primary btn-lg" href="/dashboard/explore">
              Explore Bags
              <ArrowIcon />
            </Link>
            <Link className="btn btn-ghost btn-lg" href="/dashboard/create">
              Create a Bag
            </Link>
          </div>
          <span className="hero-sub">Ethereum · Arbitrum · Base · Robinhood Chain</span>
        </div>

        <div className="hero-card-stage" data-reveal>
          <div className="hero-demo">
            <ol className="demo-stages" aria-label="What happens to your amount">
              {STAGES.map((s, i) => (
                <li key={s} className={i <= stage ? 'on' : ''}>
                  {s}
                </li>
              ))}
            </ol>

            <div className="hero-product-card">
              <div className="hpc-head">
                <span className="hpc-name">{bag.name}</span>
                {isExample && <span className="hpc-example-badge">EXAMPLE</span>}
              </div>
              {bag.creator && <div className="hpc-creator mono">by {bag.creator}</div>}

              <label className="demo-amount">
                <span className="hpc-invest-label">AMOUNT (USD)</span>
                <span className="demo-amount-field">
                  <span aria-hidden="true">$</span>
                  <input
                    inputMode="decimal"
                    autoComplete="off"
                    value={input}
                    placeholder="Enter amount"
                    onChange={(e) => {
                      setTouched(true);
                      setInput(e.target.value.replace(/[^0-9.,]/g, '').slice(0, 12));
                    }}
                    onFocus={() => setTouched(true)}
                  />
                </span>
              </label>

              <div className={`hpc-rows${stage >= 2 ? ' live' : ''}`}>
                {rows.map((row) => (
                  <div className="hpc-row" key={row.symbol}>
                    <div className="hpc-row-label">
                      <span>{row.symbol}</span>
                      <span className="hpc-row-values">
                        <span className="mono">{valid ? usd((amount * row.weight) / 100) : '—'}</span>
                        <b>{row.weight}%</b>
                      </span>
                    </div>
                    <div className="hpc-bar-track">
                      <div className="hpc-bar-fill" style={{ width: `${stage >= 2 ? Math.min(100, row.weight) : 0}%` }} />
                    </div>
                  </div>
                ))}
              </div>

              <div className={`demo-route${stage >= 3 ? ' on' : ''}`}>
                <span className="mono">route</span>
                <span>BAG Router · LI.FI</span>
                <span className="mono">→ your wallet</span>
              </div>

              <Link href={buyHref} className="hpc-cta">
                Buy this Bag
                <ArrowIcon size={14} />
              </Link>
            </div>
            <p className="demo-note">
              Illustrative split. Real purchases are priced and quoted before you sign.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
