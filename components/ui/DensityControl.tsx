'use client';

import { useEffect, useState } from 'react';

// How much the app shows at once on a wide screen, like the browser's zoom but only for the app (the landing page
// is left alone) and only above 1100px wide (phones and tablets never shrink). "Auto" picks by screen width:
// 67% from 1800px, 80% from 1400px, otherwise 100%. The choice is remembered in this browser.

export type Density = 'auto' | '100' | '80' | '67';
export const DENSITY_STORAGE_KEY = 'bag-protocol:density';
const ORDER: Density[] = ['auto', '100', '80', '67'];

/** Inline script for <head>: applies a saved density before the first paint. */
export const DENSITY_BOOT_SCRIPT = `try{var d=localStorage.getItem('${DENSITY_STORAGE_KEY}');if(d==='100'||d==='80'||d==='67'){document.documentElement.dataset.density=d}}catch(e){}`;

function readDensity(): Density {
  if (typeof document === 'undefined') return 'auto';
  const d = document.documentElement.dataset.density;
  return d === '100' || d === '80' || d === '67' ? d : 'auto';
}

export function applyDensity(density: Density): void {
  if (density === 'auto') delete document.documentElement.dataset.density;
  else document.documentElement.dataset.density = density;
  try {
    window.localStorage.setItem(DENSITY_STORAGE_KEY, density);
  } catch {
    // Storage blocked: the density still applies for this visit.
  }
}

/** What "auto" resolves to at this screen width. */
export function autoDensity(width: number): '100' | '80' | '67' {
  return width >= 1800 ? '67' : width >= 1400 ? '80' : '100';
}

const label = (d: Density) => (d === 'auto' ? 'Auto' : `${d}%`);

/** One button that steps through Auto → 100% → 80% → 67%. */
export function DensityControl() {
  const [density, setDensity] = useState<Density>('auto');
  const [autoValue, setAutoValue] = useState<'100' | '80' | '67'>('100');
  useEffect(() => {
    setDensity(readDensity());
    const update = () => setAutoValue(autoDensity(window.innerWidth));
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  const next = ORDER[(ORDER.indexOf(density) + 1) % ORDER.length];
  const now = density === 'auto' ? `Auto (${autoValue}%)` : label(density);
  return (
    <button
      type="button"
      className="theme-toggle density-toggle mono"
      aria-label={`Screen density: ${now}. Switch to ${label(next)}`}
      title={`Screen density: ${now}. Click for ${label(next)}`}
      onClick={() => {
        applyDensity(next);
        setDensity(next);
      }}
    >
      {density === 'auto' ? `A·${autoValue}` : `${density}%`}
    </button>
  );
}
