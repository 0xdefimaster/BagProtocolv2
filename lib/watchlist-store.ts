'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

// Bags the viewer is watching, kept in this browser only (same pattern as creator-follow-store.ts).
// No account or server state: clearing site data clears it, another device does not see it.

const WATCHLIST_KEY = 'bag-protocol:watchlist'; // string[] of Bag ids
const LOCAL_EVENT = 'bag-protocol:watchlist-updated';
/** Upper bound on stored ids, so a runaway list cannot grow storage without limit. */
export const WATCHLIST_MAX = 200;

function readWatchlist(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(WATCHLIST_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function writeWatchlist(ids: string[]) {
  try {
    window.localStorage.setItem(WATCHLIST_KEY, JSON.stringify(ids));
  } catch {
    // Storage blocked (private mode, quota): the toggle still works for this page view.
  }
}

export function useWatchlist() {
  const [ids, setIds] = useState<string[]>([]);

  useEffect(() => {
    setIds(readWatchlist());
    const sync = () => setIds(readWatchlist());
    window.addEventListener('storage', sync);
    window.addEventListener(LOCAL_EVENT, sync);
    return () => {
      window.removeEventListener('storage', sync);
      window.removeEventListener(LOCAL_EVENT, sync);
    };
  }, []);

  const watchlist = useMemo(() => new Set(ids), [ids]);
  const isWatching = useCallback((bagId: string) => watchlist.has(bagId), [watchlist]);

  const toggleWatch = useCallback((bagId: string): boolean => {
    const current = readWatchlist();
    const already = current.includes(bagId);
    const next = already ? current.filter((id) => id !== bagId) : [bagId, ...current].slice(0, WATCHLIST_MAX);
    writeWatchlist(next);
    setIds(next);
    window.dispatchEvent(new Event(LOCAL_EVENT));
    return !already;
  }, []);

  return { watchlist, isWatching, toggleWatch };
}
