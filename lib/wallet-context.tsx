'use client';

import { createContext, useContext, useEffect, useRef, useState, useCallback, ReactNode } from 'react';

import { discoverWallets, Eip1193Provider, getEthereumProvider, setActiveEthereumProvider, WalletOption } from '@/lib/wallet/eth-provider';
import { WalletPicker } from '@/components/app/WalletPicker';

const LAST_CONNECTED_KEY = 'bag-protocol:wallet-last-connected';
/** Which wallet (EIP-6963 id) the user picked last, for a silent reconnect on reload. */
const LAST_WALLET_KEY = 'bag-protocol:wallet-id';

const CHAIN_NAMES: Record<string, string> = {
  '0x1': 'Ethereum',
  '0x2105': 'Base',
  '0xa4b1': 'Arbitrum',
  '0x89': 'Polygon',
  '0x1237': 'Robinhood Chain',
};

/** How long a wallet connection error stays on screen before clearing itself (ms). */
export const WALLET_ERROR_DISMISS_MS = 5000;

export interface AuthUser {
  id: string;
  walletAddress: string;
  displayName: string | null;
  avatarUrl?: string | null;
}

interface WalletContextValue {
  isConnected: boolean;
  isConnecting: boolean;
  hasProvider: boolean;
  walletAddress: string;
  chainName: string | null;
  error: string | null;
  /** Opens the wallet picker — nothing is requested from any wallet until the user picks one. */
  connect: () => Promise<void>;
  /** Wallets found in this browser (EIP-6963, or the single injected one). */
  wallets: WalletOption[];
  disconnect: () => void;
  /** Opens the wallet's account picker to connect a different account (see switchAccount in the provider). */
  switchAccount: () => Promise<void>;
  /** @deprecated use connect()/disconnect() — kept for existing call sites */
  toggleConnect: () => void;
  /** Wallet -> Sign Message -> Nonce -> Session -> User -> Supabase. Non-null once the server has verified a signature for the currently-connected address. */
  authUser: AuthUser | null;
  /** True once the initial /api/auth/session check has resolved — avoids flashing a "sign in" prompt before we know a cookie session already exists. */
  isAuthReady: boolean;
  isSigningIn: boolean;
  authError: string | null;
  /** Re-runs the nonce -> personal_sign -> verify flow for the connected wallet. Called automatically after connect(), but exposed for a manual "Sign in" retry button. */
  signIn: () => Promise<void>;
  /** Mirrors a profile change the server already saved (see app/api/profile). */
  updateAuthUser: (patch: Partial<Pick<AuthUser, 'displayName' | 'avatarUrl'>>) => void;
}

const WalletContext = createContext<WalletContextValue | undefined>(undefined);

export function WalletProvider({ children }: { children: ReactNode }) {
  const [walletAddress, setWalletAddress] = useState('');
  const [chainName, setChainName] = useState<string | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wallets, setWallets] = useState<WalletOption[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  // The wallet the user picked; listeners re-attach when it changes.
  const [activeProvider, setActiveProvider] = useState<Eip1193Provider | null>(null);
  const hasProvider = wallets.length > 0;

  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const isConnected = walletAddress !== '';

  // A connection error (e.g. "Connection request was rejected.") clears
  // itself after a few seconds instead of staying on screen.
  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(null), WALLET_ERROR_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [error]);

  const applyChainId = useCallback((chainId: unknown) => {
    if (typeof chainId === 'string') {
      setChainName(CHAIN_NAMES[chainId] ?? `Chain ${parseInt(chainId, 16)}`);
    }
  }, []);

  const selectProvider = useCallback((provider: Eip1193Provider | null) => {
    setActiveEthereumProvider(provider);
    setActiveProvider(provider);
  }, []);

  // Find the wallets installed in this browser (they announce themselves).
  useEffect(() => discoverWallets(setWallets), []);

  // Silent reconnect on load: only if this browser connected before, and only
  // to the wallet picked then — eth_accounts never opens a popup.
  const reconnectTried = useRef(false);
  useEffect(() => {
    if (reconnectTried.current || wallets.length === 0) return;
    reconnectTried.current = true;
    if (window.localStorage.getItem(LAST_CONNECTED_KEY) !== '1') return;
    const lastId = window.localStorage.getItem(LAST_WALLET_KEY);
    const wallet = wallets.find((w) => w.id === lastId) ?? (lastId === null && wallets.length === 1 ? wallets[0] : undefined);
    if (!wallet) return;
    selectProvider(wallet.provider);
    wallet.provider
      .request({ method: 'eth_accounts' })
      .then((accounts) => {
        const list = accounts as string[];
        if (list.length > 0) {
          setWalletAddress(list[0]);
          wallet.provider.request({ method: 'eth_chainId' }).then(applyChainId).catch(() => {});
        }
      })
      .catch(() => {});
  }, [wallets, applyChainId, selectProvider]);

  // On mount: restore any existing session cookie (survives a page reload —
  // this is the "same wallet, same device, no browser restart" case). Runs
  // once before the auto-sign-in effect below is allowed to fire, so a
  // valid session never triggers a redundant signature prompt.
  useEffect(() => {
    fetch('/api/auth/session')
      .then((res) => (res.ok ? res.json() : { user: null }))
      .then((data: { user: AuthUser | null }) => {
        if (data.user) setAuthUser(data.user);
      })
      .catch(() => {})
      .finally(() => setIsAuthReady(true));
  }, []);

  // One sign-in at a time PER WALLET. A second nonce request used to replace
  // the first server-side, so overlapping flows (auto sign-in + the "Sign
  // in" button) broke each other. The lock is keyed by address and cleared
  // on account switch / disconnect: reusing wallet A's pending flow for
  // wallet B would leave B with no sign-in at all, and a late approval of
  // A's prompt would set A's session while B is shown connected.
  const signInInFlight = useRef<{ address: string; promise: Promise<void> } | null>(null);
  const currentWalletRef = useRef('');
  currentWalletRef.current = walletAddress;

  const signIn = useCallback(async () => {
    const address = walletAddress.toLowerCase();
    const pending = signInInFlight.current;
    if (pending && pending.address === address) return pending.promise;
    const promise = signInOnce().finally(() => {
      if (signInInFlight.current?.promise === promise) signInInFlight.current = null;
    });
    signInInFlight.current = { address, promise };
    return promise;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletAddress]);

  const signInOnce = async () => {
    const provider = getEthereumProvider();
    if (!provider || !walletAddress) {
      setAuthError('Connect a wallet first.');
      return;
    }

    setIsSigningIn(true);
    setAuthError(null);
    try {
      const nonceRes = await fetch('/api/auth/nonce', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ walletAddress }),
      });
      const nonceData = await nonceRes.json().catch(() => ({}));
      if (!nonceRes.ok) throw new Error(nonceData.error || `Could not start sign-in (server responded ${nonceRes.status}).`);

      const signature = (await provider.request({
        method: 'personal_sign',
        params: [nonceData.message, walletAddress],
      })) as string;

      const verifyRes = await fetch('/api/auth/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ walletAddress, signature, nonce: nonceData.nonce }),
      });
      const verifyData = await verifyRes.json().catch(() => ({}));
      if (!verifyRes.ok) throw new Error(verifyData.error || `Signature verification failed (server responded ${verifyRes.status}).`);

      // The wallet may have changed while the prompt was open: never adopt a
      // session for an address that is no longer the connected one.
      if ((verifyData.user as AuthUser).walletAddress.toLowerCase() !== currentWalletRef.current.toLowerCase()) {
        fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
        return;
      }
      setAuthUser(verifyData.user as AuthUser);
    } catch (err) {
      const message =
        err && typeof err === 'object' && 'code' in err && (err as { code: number }).code === 4001
          ? 'Sign-in request was rejected.'
          : err instanceof Error
            ? err.message
            : 'Could not sign in.';
      setAuthError(message);
    } finally {
      setIsSigningIn(false);
    }
  };

  // Auto-sign-in: once we know whether a session cookie already covers this
  // address (isAuthReady) and the connected wallet doesn't match the signed-
  // in user, kick off the nonce -> sign -> verify flow automatically so
  // "Connect Wallet" reads as one action from the user's side, even though
  // it's actually connect + sign under the hood.
  useEffect(() => {
    if (!isAuthReady || !walletAddress) return;
    if (authUser && authUser.walletAddress.toLowerCase() === walletAddress.toLowerCase()) return;
    signIn();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthReady, walletAddress]);

  // An account switch (from the wallet, or from switchAccount below): the previous wallet's session ends here.
  const applyAccounts = useCallback((accounts: string[]) => {
    // Production-hardening P0-8 — invalidate the PREVIOUS wallet's
    // session synchronously, in the same tick as the account switch
    // itself, rather than leaving it to the async auto-sign-in effect
    // below to eventually notice (that effect only starts a NEW sign-in
    // for the new address; it never tore down the old session, so a
    // stale cookie for wallet A stayed valid for as long as the
    // nonce -> sign -> verify round trip for wallet B took).
    //
    // This is the actual security-relevant fix, not just cosmetic state
    // clearing: purchase/redeem/deploy/fork/reward/create-bag all gate
    // on `requireSession()` server-side, which reads the session
    // COOKIE, never this client-side `authUser` mirror. Clearing
    // `authUser` alone would still leave a valid A-session cookie able
    // to authorize a request while the UI already shows B connected —
    // killing the cookie here (fire-and-forget `/api/auth/logout`,
    // exactly what the explicit `disconnect()` button below already
    // does) is what actually blocks every one of those actions from
    // running under the old identity during the switch window. The
    // existing auto-sign-in effect (`isAuthReady`/`walletAddress`
    // dependency, a few lines down) picks up from here once
    // `walletAddress` changes and `authUser` is null — no changes
    // needed there.
    setAuthUser(null);
    setAuthError(null);
    signInInFlight.current = null;
    fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});

    if (accounts.length === 0) {
      // Wallet disconnected (from the extension side, not our own
      // disconnect() button) — same treatment: no lingering session.
      setWalletAddress('');
      window.localStorage.removeItem(LAST_CONNECTED_KEY);
    } else {
      setWalletAddress(accounts[0]);
    }
  }, []);

  // Keep in sync with wallet-side account/network switches (of the picked wallet).
  useEffect(() => {
    const provider = activeProvider;
    if (!provider) return;

    const onAccountsChanged = (...args: unknown[]) => applyAccounts(args[0] as string[]);
    const onChainChanged = (...args: unknown[]) => applyChainId(args[0]);

    provider.on('accountsChanged', onAccountsChanged);
    provider.on('chainChanged', onChainChanged);
    return () => {
      provider.removeListener('accountsChanged', onAccountsChanged);
      provider.removeListener('chainChanged', onChainChanged);
    };
  }, [applyChainId, activeProvider, applyAccounts]);

  // "Connect Wallet" never talks to a wallet by itself: it opens the picker,
  // and only the wallet the user clicks is asked for accounts.
  const connect = useCallback(async () => {
    setError(null);
    setPickerOpen(true);
  }, []);

  const connectWith = useCallback(
    async (wallet: WalletOption) => {
      setError(null);
      setIsConnecting(true);
      try {
        const accounts = (await wallet.provider.request({ method: 'eth_requestAccounts' })) as string[];
        if (accounts.length > 0) {
          selectProvider(wallet.provider);
          setWalletAddress(accounts[0]);
          window.localStorage.setItem(LAST_CONNECTED_KEY, '1');
          window.localStorage.setItem(LAST_WALLET_KEY, wallet.id);
          wallet.provider.request({ method: 'eth_chainId' }).then(applyChainId).catch(() => {});
          setPickerOpen(false);
        }
      } catch (err) {
        const message =
          err && typeof err === 'object' && 'code' in err && (err as { code: number }).code === 4001
            ? 'Connection request was rejected.'
            : 'Could not connect to your wallet. Please try again.';
        setError(message);
      } finally {
        setIsConnecting(false);
      }
    },
    [applyChainId, selectProvider]
  );

  const updateAuthUser = useCallback((patch: Partial<Pick<AuthUser, 'displayName' | 'avatarUrl'>>) => {
    setAuthUser((prev) => (prev ? { ...prev, ...patch } : prev));
  }, []);

  const disconnect = useCallback(() => {
    // EIP-1193 has no standard programmatic disconnect — this just clears
    // local state so the app treats the wallet as logged out. The server
    // session is explicitly torn down too, otherwise reconnecting the same
    // wallet later would silently skip the sign-in prompt.
    setWalletAddress('');
    setChainName(null);
    setAuthUser(null);
    setAuthError(null);
    signInInFlight.current = null;
    window.localStorage.removeItem(LAST_CONNECTED_KEY);
    window.localStorage.removeItem(LAST_WALLET_KEY);
    activeProvider?.disconnect?.().catch(() => {});
    // Drop this site's account permission in the wallet too (EIP-2255 revoke; MetaMask and others). Without it the
    // next Connect silently gets the same account back and the wallet never asks which account to use.
    activeProvider?.request({ method: 'wallet_revokePermissions', params: [{ eth_accounts: {} }] }).catch(() => {});
    selectProvider(null);
    fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
  }, [activeProvider, selectProvider]);

  /**
   * Lets the user pick another account of the same wallet. A wallet never tells the site that the user selected an
   * account the site is not connected to (privacy), so the site cannot notice by itself. MetaMask may answer a
   * permission request for an already-connected site without showing anything, so this first revokes the site's
   * account permission (EIP-2255 revoke) and then asks for accounts, which makes the wallet show its account list.
   * Wallets without revoke get the permission picker (wallet_requestPermissions) instead. Any switch ends the
   * current session like an account change from the wallet.
   */
  const switchAccount = useCallback(async () => {
    const provider = activeProvider;
    if (!provider) {
      setPickerOpen(true);
      return;
    }
    setError(null);
    const errorCode = (err: unknown) =>
      err && typeof err === 'object' && 'code' in err ? Number((err as { code: unknown }).code) : undefined;

    let revoked = false;
    try {
      await provider.request({ method: 'wallet_revokePermissions', params: [{ eth_accounts: {} }] });
      revoked = true;
    } catch {
      // No revoke in this wallet: use its permission picker below.
    }

    try {
      if (revoked) {
        // The site holds no account permission now, so the wallet has to ask which account to connect.
        const accounts = (await provider.request({ method: 'eth_requestAccounts' })) as string[];
        if (accounts.length === 0) {
          disconnect();
          return;
        }
        applyAccounts(accounts);
        window.localStorage.setItem(LAST_CONNECTED_KEY, '1');
        return;
      }
      await provider.request({ method: 'wallet_requestPermissions', params: [{ eth_accounts: {} }] });
      const accounts = (await provider.request({ method: 'eth_accounts' })) as string[];
      // Most wallets also emit accountsChanged; applying here covers the ones that do not.
      if (accounts[0] && accounts[0].toLowerCase() !== walletAddress.toLowerCase()) applyAccounts(accounts);
    } catch (err) {
      if (!revoked && errorCode(err) === 4001) return; // closed the picker: still connected as before
      // Closed the account list after the revoke (the site is no longer connected), or the wallet could not show a
      // picker: reconnect from scratch.
      disconnect();
      if (errorCode(err) !== 4001) setPickerOpen(true);
    }
  }, [activeProvider, walletAddress, applyAccounts, disconnect]);

  const toggleConnect = useCallback(() => {
    if (isConnected) {
      disconnect();
    } else {
      connect();
    }
  }, [isConnected, connect, disconnect]);

  return (
    <WalletContext.Provider
      value={{
        isConnected,
        isConnecting,
        hasProvider,
        walletAddress,
        chainName,
        error,
        connect,
        wallets,
        disconnect,
        switchAccount,
        toggleConnect,
        authUser,
        updateAuthUser,
        isAuthReady,
        isSigningIn,
        authError,
        signIn,
      }}
    >
      {children}
      <WalletPicker
        open={pickerOpen}
        wallets={wallets}
        connecting={isConnecting}
        error={error}
        onPick={connectWith}
        onClose={() => setPickerOpen(false)}
      />
    </WalletContext.Provider>
  );
}

export function useWallet() {
  const ctx = useContext(WalletContext);
  if (!ctx) {
    throw new Error('useWallet must be used within a WalletProvider');
  }
  return ctx;
}

export function shortenAddress(address: string): string {
  if (!address || address.length < 10) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}
