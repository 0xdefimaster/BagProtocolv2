'use client';

import { useCallback, useEffect, useState } from 'react';
import { Bag } from '@/types';

// -----------------------------------------------------------------------------
// Single-bag fetch for the Bag Detail page. Unlike useMyBags(), this one
// makes its call unconditionally — GET /api/bags/[id] is public for ACTIVE
// bags (no session needed), and the route itself enforces the
// owner-only-for-DRAFT/ARCHIVED rule server-side. This hook just reports
// whatever the route decides: 200 -> bag, 404 -> notFound, anything else ->
// error. It never guesses ownership client-side.
// -----------------------------------------------------------------------------

export type BagFetchStatus = 'idle' | 'loading' | 'success' | 'not_found' | 'error';

export function useBag(id: string | undefined) {
  const [bag, setBag] = useState<Bag | null>(null);
  const [status, setStatus] = useState<BagFetchStatus>('idle');
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    if (!id) {
      setBag(null);
      setStatus('idle');
      return;
    }

    setStatus('loading');
    setError(null);

    fetch(`/api/bags/${encodeURIComponent(id)}`, { credentials: 'same-origin' })
      .then(async (res) => {
        if (res.status === 404) {
          setStatus('not_found');
          return null;
        }
        if (!res.ok) {
          const body = await res.json().catch(() => ({}) as { error?: string });
          throw new Error(body.error ?? `Request failed (${res.status}).`);
        }
        return res.json() as Promise<{ bag: Bag }>;
      })
      .then((data) => {
        if (data) {
          setBag(data.bag);
          setStatus('success');
        }
      })
      .catch((err: Error) => {
        setBag(null);
        setStatus('error');
        setError(err.message || 'Could not load this bag.');
      });
  }, [id]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return {
    bag,
    isLoading: status === 'loading',
    isNotFound: status === 'not_found',
    isError: status === 'error',
    error,
    refresh,
  };
}
