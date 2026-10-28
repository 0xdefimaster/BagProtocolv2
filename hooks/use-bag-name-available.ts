'use client';

import { useEffect, useState } from 'react';

// Whether a Bag name is still free, checked as the creator types (GET /api/bags/name-available). Names are unique
// across the project, ignoring case and spacing (migration 0058). A hint only: creating the Bag checks again, and
// 'unknown' (network error, not configured) never blocks.

export type BagNameAvailability = 'idle' | 'checking' | 'available' | 'taken' | 'unknown';

const DEBOUNCE_MS = 400;

export function useBagNameAvailable(name: string): BagNameAvailability {
  const trimmed = name.trim();
  const [result, setResult] = useState<{ name: string; state: BagNameAvailability }>({ name: '', state: 'idle' });

  useEffect(() => {
    if (!trimmed) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetch(`/api/bags/name-available?name=${encodeURIComponent(trimmed)}`, { signal: controller.signal })
        .then(async (res) => {
          const body = (await res.json().catch(() => null)) as { available?: unknown } | null;
          const state: BagNameAvailability = res.ok && typeof body?.available === 'boolean' ? (body.available ? 'available' : 'taken') : 'unknown';
          setResult({ name: trimmed, state });
        })
        .catch((err: unknown) => {
          if ((err as { name?: string })?.name !== 'AbortError') setResult({ name: trimmed, state: 'unknown' });
        });
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [trimmed]);

  if (!trimmed) return 'idle';
  return result.name === trimmed ? result.state : 'checking';
}
