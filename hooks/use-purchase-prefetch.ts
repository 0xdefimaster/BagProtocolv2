'use client';

import { useCallback, useEffect, useRef } from 'react';
import type { PurchaseIntent } from '@/types/purchase-intent';
import { preparePurchaseIntent } from '@/hooks/use-purchase-execution';

// -----------------------------------------------------------------------------
// Prepares the server half of a purchase (intent + route compile + the
// pre-signature checks) in the background once the amount has settled, so
// pressing Buy opens the wallet right away instead of waiting on it.
//
// - Keyed on exactly what the purchase uses (bag, input asset, amount,
//   chosen provider). Buy only reuses a prepared intent for the same key;
//   anything else prepares on click as before.
// - A newer preparation replaces the older one: the server cancels a user's
//   unsigned intent for the Bag when the next one is created
//   (settleOpenIntent), so abandoned preparations never block a purchase.
// - Best effort: a failed preparation (rate limit, quote error) is dropped
//   silently and Buy prepares on click, surfacing any error there.
// - Nothing here touches the wallet; signing still only happens on Buy.
// -----------------------------------------------------------------------------

/** How long the amount must stay unchanged before preparing (ms). */
export const PURCHASE_PREFETCH_IDLE_MS = 1200;

export function purchasePrefetchKey(bagId: string, inputAssetId: string, amount: string, providerId?: string | null): string {
  return [bagId, inputAssetId, amount.trim(), providerId ?? ''].join('|');
}

interface PrefetchParams {
  bagId: string;
  inputAssetId: string | null;
  amount: string;
  providerId?: string | null;
  /** Only when a purchase could start right now: preview ready, wallet signed in, nothing blocking, not already executing. */
  enabled: boolean;
}

export function usePurchasePrefetch({ bagId, inputAssetId, amount, providerId, enabled }: PrefetchParams) {
  const slot = useRef<{ key: string; promise: Promise<PurchaseIntent | null> } | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const key = inputAssetId ? purchasePrefetchKey(bagId, inputAssetId, amount, providerId) : null;

  useEffect(() => {
    if (!enabled || !key || !inputAssetId || amount.trim() === '') return;
    if (slot.current?.key === key) return;
    const timer = setTimeout(() => {
      timerRef.current = null;
      slot.current = {
        key,
        promise: preparePurchaseIntent(bagId, inputAssetId, amount.trim(), providerId ?? undefined).catch(() => null),
      };
    }, PURCHASE_PREFETCH_IDLE_MS);
    timerRef.current = timer;
    return () => clearTimeout(timer);
    // `key` already encodes bagId / inputAssetId / amount / providerId.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, key]);

  /** Hands over (and forgets) the preparation for `forKey`, if there is one — a retry after a failure prepares fresh. */
  const take = useCallback((forKey: string): Promise<PurchaseIntent | null> | undefined => {
    // Buy was pressed: a preparation that hasn't started yet must never start
    // now — its intent would supersede (and cancel) the one being signed.
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const current = slot.current;
    if (!current || current.key !== forKey) return undefined;
    slot.current = null;
    return current.promise;
  }, []);

  return { take };
}
