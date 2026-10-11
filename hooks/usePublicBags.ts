'use client';

import { useCallback, useEffect, useState } from 'react';
import { Bag } from '@/types';

// -----------------------------------------------------------------------------
// Production-hardening P0-5 — Explore's real data source. Mirrors
// hooks/useMyBags.ts's own conventions (status machine, error surfacing,
// never merging in anything else), but PUBLIC: `GET /api/bags` with no
// `mine=1` and no session requirement — `lib/server/bag-repo.ts`'s
// `listBags()` already defaults an unscoped call like this to ACTIVE-only,
// the exact same set the `bags` table's own public-read RLS policy allows,
// so this is not a new server-side concept, just the first real client of
// the read path Explore always should have used instead of `mockBags`
// (lib/mock-data.ts).
// -----------------------------------------------------------------------------

export type PublicBagsStatus = 'idle' | 'loading' | 'success' | 'error';

export function usePublicBags() {
  const [bags, setBags] = useState<Bag[]>([]);
  const [status, setStatus] = useState<PublicBagsStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  /** HTTP status of the failed request (e.g. 503 = this deployment has no database configured), null on a network error. */
  const [errorStatus, setErrorStatus] = useState<number | null>(null);

  /** `silent`: a background refresh — the current list stays on screen, and a failed refresh keeps it. */
  const refresh = useCallback((options: { silent?: boolean } = {}) => {
    const silent = options.silent === true;
    if (!silent) {
      setStatus('loading');
      setError(null);
      setErrorStatus(null);
    }

    fetch('/api/bags', { credentials: 'same-origin' })
      .then(async (res) => {
        if (!res.ok) {
          if (!silent) setErrorStatus(res.status);
          const body = await res.json().catch(() => ({}) as { error?: string });
          throw new Error(body.error ?? `Request failed (${res.status}).`);
        }
        return res.json() as Promise<{ bags: Bag[] }>;
      })
      .then((data) => {
        setBags(data.bags);
        setStatus('success');
      })
      .catch((err: Error) => {
        if (silent) return;
        setBags([]);
        setStatus('error');
        setError(err.message || 'Could not load bags.');
      });
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return {
    bags,
    isLoading: status === 'loading' || status === 'idle',
    isError: status === 'error',
    error,
    errorStatus,
    /** The deployment is not connected to its database (Supabase) — not a transient failure. */
    isNotConfigured: status === 'error' && errorStatus === 503,
    refresh,
  };
}
