'use client';

import { useEffect, useState } from 'react';
import { useWallet } from '@/lib/wallet-context';

const GUEST_ID_KEY = 'bag-protocol:guest-id';

function readOrCreateGuestId(): string {
  if (typeof window === 'undefined') return 'guest';
  try {
    const existing = window.localStorage.getItem(GUEST_ID_KEY);
    if (existing) return existing;
    const created = `guest-${Math.random().toString(36).slice(2, 10)}`;
    window.localStorage.setItem(GUEST_ID_KEY, created);
    return created;
  } catch {
    return 'guest';
  }
}

/**
 * Every paper-trading / points / collectible record is keyed by this id.
 *
 * Once the wallet-signature sign-in flow (see lib/wallet-context.tsx)
 * completes, `authUser.id` is the real Supabase `users.id` — the same value
 * on any device the wallet signs in from, which is what makes the portfolio
 * durable across a browser change. Boxes/inventory/BAG NFTs (not yet
 * migrated off localStorage) still key off this same id, so they keep
 * working exactly as before; they just aren't durable cross-device yet.
 *
 * Before a signature is verified (freshly connected, mid sign-in prompt) or
 * with no wallet connected at all, callers fall back to a stable per-browser
 * guest id so the demo loop still works without forcing a signature.
 */
export function useCurrentUserId(): {
  userId: string;
  displayName: string;
  isGuest: boolean;
  isAuthenticated: boolean;
} {
  const { isConnected, walletAddress, authUser } = useWallet();
  const [guestId, setGuestId] = useState('guest');

  useEffect(() => {
    setGuestId(readOrCreateGuestId());
  }, []);

  const isAuthenticated =
    isConnected && !!authUser && authUser.walletAddress.toLowerCase() === walletAddress.toLowerCase();

  if (isAuthenticated && authUser) {
    return {
      userId: authUser.id,
      displayName: authUser.displayName ?? walletAddress,
      isGuest: false,
      isAuthenticated: true,
    };
  }

  if (isConnected && walletAddress) {
    // Signature not verified yet (mid sign-in, or it failed) — still show
    // the wallet address, but keep isGuest so callers relying on it to
    // gate real-money-adjacent actions know the session isn't trusted yet.
    return { userId: walletAddress, displayName: walletAddress, isGuest: true, isAuthenticated: false };
  }

  return { userId: guestId, displayName: 'You (guest)', isGuest: true, isAuthenticated: false };
}
