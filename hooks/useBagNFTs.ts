'use client';

import { useCallback, useEffect, useState } from 'react';
import { AccessorySlot, BagNFT } from '@/types/domain';
import { useCurrentUserId } from './useCurrentUserId';

// -----------------------------------------------------------------------------
// Phase 19 — server-enforced NFT read + assembly. Previously read/wrote
// lib/services/nft-service.ts's localStorage `bag_nfts` collection via
// lib/services/inventory-service.ts's ownership check, which nothing has
// populated since box-opening moved server-side (Phase 18) — assembly could
// never actually succeed for a real user (see supabase/MIGRATION.md).
// Now reads/writes `/api/nfts` and `/api/nfts/assemble`, backed by
// lib/server/nft-repo.ts.
// -----------------------------------------------------------------------------

export type SlotSelection = Partial<Record<AccessorySlot, string>>;

export interface AssembleResult {
  ok: boolean;
  error?: string;
  nft?: BagNFT;
}

export function useBagNFTs() {
  const { isAuthenticated } = useCurrentUserId();
  const [nfts, setNfts] = useState<BagNFT[]>([]);

  const refresh = useCallback(() => {
    if (!isAuthenticated) {
      setNfts([]);
      return;
    }
    fetch('/api/nfts')
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { nfts: BagNFT[] } | null) => {
        if (data) setNfts(data.nfts);
      })
      .catch(() => {});
  }, [isAuthenticated]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const assemble = useCallback(
    async (selection: SlotSelection): Promise<AssembleResult> => {
      if (!isAuthenticated) {
        return { ok: false, error: 'Connect and sign in with your wallet first.' };
      }
      try {
        const res = await fetch('/api/nfts/assemble', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ selection }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) {
          return { ok: false, error: data.error ?? 'Failed to assemble your BAG NFT.' };
        }
        refresh();
        return { ok: true, nft: data.nft };
      } catch {
        return { ok: false, error: 'Network error — please try again.' };
      }
    },
    [isAuthenticated, refresh]
  );

  return { nfts, assemble, refresh };
}
