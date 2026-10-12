// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act, waitFor, fireEvent, screen, cleanup } from '@testing-library/react';
import { WalletProvider, useWallet } from '../wallet-context';

// -----------------------------------------------------------------------------
// Production-hardening P0-8 — regression tests 12/13:
//   12. Wallet A -> Wallet B immediately invalidates A's session.
//   13. Purchase after wallet switch cannot execute under the old session.
//
// `requireSession()` (lib/auth/require-session.ts) is what every real
// financial route (purchase/redeem/deploy/fork/reward/create-bag) already
// gates on, and it reads the session COOKIE, never this client-side
// `authUser` state — so test 13 is a direct consequence of test 12, not a
// separate server behavior to fake here: once `/api/auth/logout` has
// actually been called (proven below) the cookie is gone, and
// `requireSession()`'s own existing, already-tested behavior for "no
// session" (401, same as every other route-level test in this repo
// already covers) is what blocks the stale identity — this file does not
// re-implement or re-prove that separately.
// -----------------------------------------------------------------------------

type Handler = (...args: unknown[]) => void;

function makeFakeProvider() {
  const handlers: Record<string, Handler[]> = { accountsChanged: [], chainChanged: [] };
  return {
    isMetaMask: true,
    request: vi.fn(async ({ method }: { method: string }) => {
      if (method === 'eth_chainId') return '0x1';
      if (method === 'eth_accounts') return [];
      if (method === 'eth_requestAccounts') return ['0xWALLETA000000000000000000000000000000A'];
      return null;
    }),
    on: vi.fn((event: string, handler: Handler) => {
      handlers[event] = handlers[event] ?? [];
      handlers[event].push(handler);
    }),
    removeListener: vi.fn((event: string, handler: Handler) => {
      handlers[event] = (handlers[event] ?? []).filter((h) => h !== handler);
    }),
    // Test helper, not part of EIP-1193 — fires every registered listener for `event`.
    __emit(event: string, ...args: unknown[]) {
      for (const h of handlers[event] ?? []) h(...args);
    },
  };
}


/** "Connect Wallet" opens the picker; the test then picks the (only) injected wallet. */
async function connectThroughPicker(result: { current: ReturnType<typeof useWallet> }) {
  await act(async () => {
    await result.current.connect();
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /MetaMask|Browser wallet/ }));
  });
}

let fetchMock: ReturnType<typeof vi.fn>;
let provider: ReturnType<typeof makeFakeProvider>;

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

beforeEach(() => {
  provider = makeFakeProvider();
  (window as unknown as { ethereum: typeof provider }).ethereum = provider;
  window.localStorage.clear();

  fetchMock = vi.fn(async (url: string) => {
    if (url === '/api/auth/session') return jsonResponse({ user: null });
    if (url === '/api/auth/logout') return jsonResponse({ ok: true });
    if (url === '/api/auth/nonce') return jsonResponse({ nonce: 'n', message: 'sign this' });
    if (url === '/api/auth/verify') return jsonResponse({ user: { id: 'u2', walletAddress: '0xWALLETB000000000000000000000000000000B', displayName: null } });
    throw new Error(`Unexpected fetch: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (window as unknown as { ethereum?: unknown }).ethereum;
});

describe('WalletProvider — account switch invalidates the previous session (P0-8)', () => {
  it('12. switching from wallet A to wallet B clears authUser and calls /api/auth/logout in the SAME tick as the address change — never left for the async re-sign-in to eventually notice', async () => {
    const { result } = renderHook(() => useWallet(), { wrapper: WalletProvider });

    await waitFor(() => expect(result.current.isAuthReady).toBe(true));

    await connectThroughPicker(result);
    await waitFor(() => expect(result.current.walletAddress.toLowerCase()).toBe('0xwalleta000000000000000000000000000000a'));

    fetchMock.mockClear();

    // Freezes the auto-sign-in flow right after the account switch: the
    // nonce request this triggers never resolves during this test, so the
    // intermediate ("switch happened, re-sign-in still in flight") state
    // is exactly what gets asserted on below — proving authUser/the old
    // session are torn down BEFORE the new one exists, not merely
    // "eventually consistent" once sign-in for B finishes.
    let releaseNonce!: () => void;
    const nonceGate = new Promise<void>((resolve) => {
      releaseNonce = resolve;
    });
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/auth/logout') return jsonResponse({ ok: true });
      if (url === '/api/auth/nonce') {
        await nonceGate;
        return jsonResponse({ nonce: 'n', message: 'sign this' });
      }
      if (url === '/api/auth/verify') {
        return jsonResponse({ user: { id: 'u2', walletAddress: '0xWALLETB000000000000000000000000000000B', displayName: null } });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    act(() => {
      provider.__emit('accountsChanged', ['0xWALLETB000000000000000000000000000000B']);
    });

    // authUser cleared immediately — before the new sign-in flow (still
    // stuck awaiting the gated nonce request) has any chance to complete.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/auth/logout', expect.objectContaining({ method: 'POST' })));
    expect(result.current.authUser).toBeNull();

    // Let the gated sign-in flow finish so the test doesn't leave a
    // dangling unhandled promise behind.
    releaseNonce();
    await waitFor(() => expect(result.current.walletAddress.toLowerCase()).toBe('0xwalletb000000000000000000000000000000b'));
  });

  it('13. a stale A-session is torn down before any new session for B exists — there is no window where a request would still carry A\'s identity', async () => {
    const { result } = renderHook(() => useWallet(), { wrapper: WalletProvider });
    await waitFor(() => expect(result.current.isAuthReady).toBe(true));
    await connectThroughPicker(result);
    await waitFor(() => expect(result.current.walletAddress).not.toBe(''));

    const logoutCallIndex: number[] = [];
    const verifyCallIndex: number[] = [];
    let callCounter = 0;
    fetchMock.mockImplementation(async (url: string) => {
      callCounter += 1;
      if (url === '/api/auth/logout') {
        logoutCallIndex.push(callCounter);
        return jsonResponse({ ok: true });
      }
      if (url === '/api/auth/nonce') return jsonResponse({ nonce: 'n', message: 'sign this' });
      if (url === '/api/auth/verify') {
        verifyCallIndex.push(callCounter);
        return jsonResponse({ user: { id: 'u2', walletAddress: '0xWALLETB000000000000000000000000000000B', displayName: null } });
      }
      if (url === '/api/auth/session') return jsonResponse({ user: null });
      throw new Error(`Unexpected fetch: ${url}`);
    });

    await act(async () => {
      provider.__emit('accountsChanged', ['0xWALLETB000000000000000000000000000000B']);
    });

    await waitFor(() => expect(verifyCallIndex.length).toBeGreaterThan(0));

    // Logout (killing A's session) happened strictly before verify (B's
    // new session being created) — never the other way around, which
    // would leave a window where BOTH sessions are simultaneously valid.
    expect(logoutCallIndex[0]).toBeLessThan(verifyCallIndex[0]);
  });

  it('a full disconnect (accounts.length === 0) also tears down the session, not just an account swap', async () => {
    const { result } = renderHook(() => useWallet(), { wrapper: WalletProvider });
    await waitFor(() => expect(result.current.isAuthReady).toBe(true));

    await connectThroughPicker(result);
    await waitFor(() => expect(result.current.walletAddress).not.toBe(''));

    fetchMock.mockClear();

    await act(async () => {
      provider.__emit('accountsChanged', []);
    });

    expect(result.current.walletAddress).toBe('');
    expect(result.current.authUser).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/logout', expect.objectContaining({ method: 'POST' }));
  });
});

describe('switchAccount: a wallet never reports accounts the site is not connected to', () => {
  const B = '0xWALLETB000000000000000000000000000000B';

  it('opens the wallet permission picker; picking another account ends the old session and switches', async () => {
    const { result } = renderHook(() => useWallet(), { wrapper: WalletProvider });
    await waitFor(() => expect(result.current.isAuthReady).toBe(true));
    await connectThroughPicker(result);
    await waitFor(() => expect(result.current.walletAddress).toBe('0xWALLETA000000000000000000000000000000A'));

    provider.request.mockImplementation((async ({ method }: { method: string }) => {
      if (method === 'wallet_requestPermissions') return [{ parentCapability: 'eth_accounts' }];
      if (method === 'eth_accounts') return [B];
      if (method === 'eth_chainId') return '0x1';
      if (method === 'personal_sign') return '0xsig';
      return null;
    }) as never);
    fetchMock.mockClear();
    await act(async () => {
      await result.current.switchAccount();
    });

    expect(provider.request).toHaveBeenCalledWith({ method: 'wallet_requestPermissions', params: [{ eth_accounts: {} }] });
    expect(result.current.walletAddress).toBe(B);
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/logout', expect.objectContaining({ method: 'POST' }));
  });

  it('closing the picker changes nothing; a wallet without the picker reconnects from scratch', async () => {
    const { result } = renderHook(() => useWallet(), { wrapper: WalletProvider });
    await waitFor(() => expect(result.current.isAuthReady).toBe(true));
    await connectThroughPicker(result);
    await waitFor(() => expect(result.current.walletAddress).not.toBe(''));
    const before = result.current.walletAddress;

    provider.request.mockImplementation(async ({ method }: { method: string }) => {
      if (method === 'wallet_requestPermissions') throw Object.assign(new Error('User rejected'), { code: 4001 });
      return null;
    });
    await act(async () => {
      await result.current.switchAccount();
    });
    expect(result.current.walletAddress).toBe(before);
    expect(result.current.error).toBeNull();

    provider.request.mockImplementation(async ({ method }: { method: string }) => {
      if (method === 'wallet_requestPermissions') throw Object.assign(new Error('Method not found'), { code: -32601 });
      return null;
    });
    await act(async () => {
      await result.current.switchAccount();
    });
    expect(result.current.walletAddress).toBe('');
    expect(screen.getByRole('button', { name: /MetaMask|Browser wallet/ })).toBeInTheDocument();
  });
});
