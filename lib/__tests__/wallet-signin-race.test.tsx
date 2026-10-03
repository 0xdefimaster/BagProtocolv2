// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act, waitFor, cleanup, fireEvent, screen } from '@testing-library/react';
import { WalletProvider, useWallet } from '../wallet-context';

// Regression: the one-sign-in-at-a-time guard must be per wallet. Switching
// accounts (or disconnecting) while a signature prompt is open has to start a
// fresh sign-in for the new wallet, and a late approval of the OLD wallet's
// prompt must never become the session while the new wallet is shown.

type Handler = (...args: unknown[]) => void;
const A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

let handlers: Record<string, Handler[]>;
let signResolvers: { address: string; resolve: (sig: string) => void }[];
let nonceBodies: string[];

beforeEach(() => {
  handlers = { accountsChanged: [], chainChanged: [] };
  signResolvers = [];
  nonceBodies = [];
  const provider = {
    request: vi.fn(async ({ method, params }: { method: string; params?: unknown[] }) => {
      if (method === 'eth_chainId') return '0x1';
      if (method === 'eth_accounts') return [];
      if (method === 'eth_requestAccounts') return [A];
      if (method === 'personal_sign') {
        return new Promise<string>((resolve) => signResolvers.push({ address: String(params?.[1]), resolve }));
      }
      return null;
    }),
    on: vi.fn((e: string, h: Handler) => {
      (handlers[e] ??= []).push(h);
    }),
    removeListener: vi.fn((e: string, h: Handler) => {
      handlers[e] = (handlers[e] ?? []).filter((x) => x !== h);
    }),
  };
  (window as unknown as { ethereum: unknown }).ethereum = provider;
  window.localStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;
      if (url === '/api/auth/session') return ok({ user: null });
      if (url === '/api/auth/logout') return ok({ ok: true });
      if (url === '/api/auth/nonce') {
        const w = JSON.parse(String(init?.body)).walletAddress;
        nonceBodies.push(w);
        return ok({ nonce: 'n-' + w, message: 'sign ' + w });
      }
      if (url === '/api/auth/verify') {
        const w = JSON.parse(String(init?.body)).walletAddress;
        return ok({ user: { id: 'user-' + w, walletAddress: w, displayName: null } });
      }
      throw new Error('unexpected ' + url);
    })
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (window as unknown as { ethereum?: unknown }).ethereum;
});

const tick = () => new Promise((r) => setTimeout(r, 50));

/** "Connect Wallet" opens the picker; the test then picks the (only) injected wallet. */
async function connectThroughPicker(result: { current: ReturnType<typeof useWallet> }) {
  await act(async () => {
    await result.current.connect();
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /MetaMask|Browser wallet/ }));
  });
}


describe('sign-in lock vs account switch', () => {
  it('switching A→B while A\'s prompt is open starts B\'s sign-in, and approving A later never sets A\'s session', async () => {
    const { result } = renderHook(() => useWallet(), { wrapper: WalletProvider });
    await waitFor(() => expect(result.current.isAuthReady).toBe(true));
    await connectThroughPicker(result);
    await waitFor(() => expect(signResolvers.length).toBe(1));

    await act(async () => {
      for (const h of handlers.accountsChanged) h([B]);
    });
    await waitFor(() => expect(result.current.walletAddress).toBe(B));
    await act(tick);
    expect(nonceBodies).toEqual([A, B]);

    // The user approves the stale prompt for A.
    await act(async () => {
      signResolvers.find((s) => s.address === A)!.resolve('0xsigA');
      await tick();
    });
    expect(result.current.authUser?.walletAddress).not.toBe(A);

    // ...and B's own prompt still completes normally.
    await act(async () => {
      signResolvers.find((s) => s.address === B)!.resolve('0xsigB');
      await tick();
    });
    expect(result.current.authUser?.walletAddress).toBe(B);
  });

  it('disconnect then connect while a prompt is open asks for a fresh signature', async () => {
    const { result } = renderHook(() => useWallet(), { wrapper: WalletProvider });
    await waitFor(() => expect(result.current.isAuthReady).toBe(true));
    await connectThroughPicker(result);
    await waitFor(() => expect(signResolvers.length).toBe(1));
    act(() => {
      result.current.disconnect();
    });
    await connectThroughPicker(result);
    await act(tick);
    expect(signResolvers.length).toBe(2);
  });
});
