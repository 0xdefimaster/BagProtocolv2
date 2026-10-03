'use client';

import { useCallback, useEffect, useState } from 'react';
import { Bag } from '@/types';
import { useCurrentUserId } from './useCurrentUserId';

// -----------------------------------------------------------------------------
// Dashboard/My Bags now reads from Supabase (GET /api/bags?mine=1) instead
// of localStorage — same "session cookie decides identity" pattern
// usePaperPortfolio already uses for portfolio/trades. `isAuthenticated`
// here is the same wallet-signature check `useCurrentUserId` already does;
// this hook makes zero calls (and returns an empty list, not an error)
// until that's true, matching how usePaperPortfolio treats an
// unauthenticated caller.
//
// This hook does NOT read or merge localStorage — that's deliberate (see
// app/dashboard/create/page.tsx's header comment and lib/user-bags-store.ts).
// Callers that still want the localStorage fallback for signed-out/offline
// users compose `useUserBags()` themselves; mixing the two in here would
// risk exactly the "duplicate/ID conflict" merge this hook is meant to
// avoid.
// -----------------------------------------------------------------------------

export type MyBagsStatus = 'idle' | 'loading' | 'success' | 'error';

export function useMyBags() {
  const { isAuthenticated } = useCurrentUserId();
  const [bags, setBags] = useState<Bag[]>([]);
  const [status, setStatus] = useState<MyBagsStatus>('idle');
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    if (!isAuthenticated) {
      setBags([]);
      setStatus('idle');
      setError(null);
      return;
    }

    setStatus('loading');
    setError(null);

    fetch('/api/bags?mine=1', { credentials: 'same-origin' })
      .then(async (res) => {
        if (!res.ok) {
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
        setBags([]);
        setStatus('error');
        setError(err.message || 'Could not load your bags.');
      });
  }, [isAuthenticated]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return {
    bags,
    isLoading: status === 'loading',
    isError: status === 'error',
    error,
    isAuthenticated,
    refresh,
  };
}
