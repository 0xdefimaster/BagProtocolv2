'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useWallet } from '@/lib/wallet-context';
import { useActivity } from '@/lib/activity-store';

/**
 * Forks a Bag through POST /api/bags/[id]/fork — the only place a fork is
 * created. The server copies the source's current recipe into a new DRAFT
 * Bag owned by the signed-in wallet, with real parent/root lineage, and the
 * user is taken to it. There is deliberately no local "saved on this
 * device" copy: it never reached Explore or Portfolio and could not be
 * invested in, so a failure is shown instead.
 */
export function useForkBag() {
  const router = useRouter();
  const { addActivity } = useActivity();
  const { isConnected, connect, signIn } = useWallet();
  const [isForking, setIsForking] = useState(false);
  const [forkError, setForkError] = useState<string | null>(null);

  const fork = useCallback(
    async (bag: { id: string; name: string }) => {
      if (isForking) return;
      setIsForking(true);
      setForkError(null);
      try {
        const res = await fetch(`/api/bags/${encodeURIComponent(bag.id)}/fork`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({}),
        });

        if (res.status === 401) {
          if (!isConnected) {
            setForkError('Connect your wallet, then press Fork again.');
            void connect();
          } else {
            setForkError('Sign in with your wallet — approve the signature request, then press Fork again.');
            void signIn();
          }
          return;
        }

        const body = (await res.json().catch(() => null)) as { bag?: { id: string }; error?: string } | null;
        if (!res.ok || !body?.bag) {
          setForkError(body?.error ?? `Fork failed (server responded ${res.status}).`);
          return;
        }

        addActivity(`Forked ${bag.name}`);
        router.push(`/dashboard/bag/${body.bag.id}`);
      } catch {
        setForkError('Could not fork: network error. Try again.');
      } finally {
        setIsForking(false);
      }
    },
    [isForking, isConnected, connect, signIn, addActivity, router]
  );

  return { fork, isForking, forkError };
}
