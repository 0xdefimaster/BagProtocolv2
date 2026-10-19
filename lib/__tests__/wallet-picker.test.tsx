// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act, waitFor, fireEvent, screen, cleanup } from '@testing-library/react';
import { WalletProvider, useWallet, WALLET_ERROR_DISMISS_MS } from '../wallet-context';
import { getEthereumProvider, setActiveEthereumProvider } from '../wallet/eth-provider';

function fakeWallet(address: string, opts: { reject?: boolean } = {}) {
  return {
    request: vi.fn(async ({ method }: { method: string }) => {
      if (method === 'eth_requestAccounts') {
        if (opts.reject) throw Object.assign(new Error('rejected'), { code: 4001 });
        return [address];
      }
      if (method === 'eth_chainId') return '0x1237';
      if (method === 'eth_accounts') return [];
      return null;
    }),
    on: vi.fn(),
    removeListener: vi.fn(),
  };
}

/** Two wallets announcing themselves the EIP-6963 way when the app asks. */
function announce(wallets: { rdns: string; name: string; provider: ReturnType<typeof fakeWallet> }[]) {
  const onRequest = () => {
    for (const w of wallets) {
      window.dispatchEvent(
        new CustomEvent('eip6963:announceProvider', { detail: { info: { uuid: w.rdns, name: w.name, rdns: w.rdns }, provider: w.provider } })
      );
    }
  };
  window.addEventListener('eip6963:requestProvider', onRequest);
  return () => window.removeEventListener('eip6963:requestProvider', onRequest);
}

let stopAnnouncing: () => void = () => {};

beforeEach(() => {
  window.localStorage.clear();
  setActiveEthereumProvider(null);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/auth/session') return { ok: true, json: async () => ({ user: null }) } as Response;
      // Sign-in is not under test here: leave the nonce request pending.
      return new Promise<Response>(() => {});
    })
  );
});

afterEach(() => {
  stopAnnouncing();
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('wallet picker', () => {
  it('Connect only opens the picker — no wallet is asked for accounts until one is clicked', async () => {
    const metamask = fakeWallet('0xaaaa000000000000000000000000000000000001');
    const rabby = fakeWallet('0xbbbb000000000000000000000000000000000002');
    stopAnnouncing = announce([
      { rdns: 'io.metamask', name: 'MetaMask', provider: metamask },
      { rdns: 'io.rabby', name: 'Rabby Wallet', provider: rabby },
    ]);

    const { result } = renderHook(() => useWallet(), { wrapper: WalletProvider });
    await waitFor(() => expect(result.current.wallets.map((w) => w.name)).toEqual(['MetaMask', 'Rabby Wallet']));

    await act(async () => {
      await result.current.connect();
    });
    expect(screen.getByRole('dialog', { name: 'Connect a wallet' })).toBeTruthy();
    expect(metamask.request).not.toHaveBeenCalledWith({ method: 'eth_requestAccounts' });
    expect(rabby.request).not.toHaveBeenCalledWith({ method: 'eth_requestAccounts' });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Rabby Wallet/ }));
    });

    await waitFor(() => expect(result.current.walletAddress).toBe('0xbbbb000000000000000000000000000000000002'));
    expect(metamask.request).not.toHaveBeenCalledWith({ method: 'eth_requestAccounts' });
    // Every signing path now talks to the wallet the user picked.
    // (Wrapped with chain fee hints, so compared by what its requests reach.)
    rabby.request.mockClear();
    await getEthereumProvider()!.request({ method: 'eth_chainId' });
    expect(rabby.request).toHaveBeenCalledWith({ method: 'eth_chainId' });
    expect(metamask.request).not.toHaveBeenCalledWith({ method: 'eth_chainId' });
    expect(result.current.chainName).toBe('Robinhood Chain');
    expect(screen.queryByRole('dialog', { name: 'Connect a wallet' })).toBeNull();
    expect(window.localStorage.getItem('bag-protocol:wallet-id')).toBe('io.rabby');
  });

  it('a rejected connection shows its message, which clears itself after a few seconds', async () => {
    const wallet = fakeWallet('0xaaaa000000000000000000000000000000000001', { reject: true });
    stopAnnouncing = announce([{ rdns: 'io.metamask', name: 'MetaMask', provider: wallet }]);
    const { result } = renderHook(() => useWallet(), { wrapper: WalletProvider });
    await waitFor(() => expect(result.current.wallets.length).toBe(1));

    vi.useFakeTimers({ shouldAdvanceTime: true });
    await act(async () => {
      await result.current.connect();
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /MetaMask/ }));
    });
    await waitFor(() => expect(result.current.error).toBe('Connection request was rejected.'));

    await act(async () => {
      vi.advanceTimersByTime(WALLET_ERROR_DISMISS_MS + 50);
    });
    expect(result.current.error).toBeNull();
    expect(result.current.walletAddress).toBe('');
  });

  it('with no wallet installed the picker offers install links instead of prompting anything', async () => {
    delete (window as unknown as { ethereum?: unknown }).ethereum;
    const { result } = renderHook(() => useWallet(), { wrapper: WalletProvider });
    await act(async () => {
      await result.current.connect();
    });
    expect(result.current.hasProvider).toBe(false);
    expect(screen.getByText(/No wallet found/)).toBeTruthy();
    expect(screen.getByRole('link', { name: /MetaMask/ })).toBeTruthy();
  });
});
