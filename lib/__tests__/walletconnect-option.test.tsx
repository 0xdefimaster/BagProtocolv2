// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, renderHook, screen, waitFor } from '@testing-library/react';

// The WalletConnect SDK is replaced by a fake: what is under test is how the
// picker entry starts it, connects through it and reports a closed QR modal.
const wc = {
  session: undefined as object | undefined,
  enable: vi.fn(),
  request: vi.fn(async ({ method }: { method: string }) => (method === 'eth_chainId' ? '0x1237' : null)),
  on: vi.fn(),
  removeListener: vi.fn(),
  disconnect: vi.fn(async () => {}),
};
const init = vi.fn(async (_opts: unknown) => wc);
vi.mock('@walletconnect/ethereum-provider', () => ({ EthereumProvider: { init } }));

beforeEach(() => {
  vi.resetModules();
  window.localStorage.clear();
  wc.session = undefined;
  wc.enable.mockReset();
  init.mockClear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/auth/session') return { ok: true, json: async () => ({ user: null }) } as Response;
      return new Promise<Response>(() => {});
    })
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('WalletConnect picker entry', () => {
  it('is hidden when no project id is configured', async () => {
    vi.stubEnv('NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID', '');
    const { getWalletConnectOption } = await import('../wallet/walletconnect');
    expect(getWalletConnectOption()).toBeNull();
  });

  it('does not load the SDK until used, then connects on Robinhood Chain through the QR flow', async () => {
    vi.stubEnv('NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID', 'test-project');
    wc.enable.mockResolvedValue(['0xcccc000000000000000000000000000000000003']);
    const { WalletProvider, useWallet } = await import('../wallet-context');

    const { result } = renderHook(() => useWallet(), { wrapper: WalletProvider });
    await waitFor(() => expect(result.current.isAuthReady).toBe(true));
    expect(init).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.connect();
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /WalletConnect/ }));
    });

    await waitFor(() => expect(result.current.walletAddress).toBe('0xcccc000000000000000000000000000000000003'));
    expect(init).toHaveBeenCalledTimes(1);
    expect(init.mock.calls[0][0]).toMatchObject({ projectId: 'test-project', optionalChains: [4663], showQrModal: true });
    expect(window.localStorage.getItem('bag-protocol:wallet-id')).toBe('walletconnect');

    // Disconnecting ends the WalletConnect session too, so the phone is not left paired.
    wc.session = {};
    act(() => {
      result.current.disconnect();
    });
    await waitFor(() => expect(wc.disconnect).toHaveBeenCalled());
  });

  it('closing the QR modal reads as a rejection, not a generic failure', async () => {
    vi.stubEnv('NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID', 'test-project');
    wc.enable.mockRejectedValue(new Error('Connection request reset. Please try again.'));
    const { WalletProvider, useWallet } = await import('../wallet-context');

    const { result } = renderHook(() => useWallet(), { wrapper: WalletProvider });
    await waitFor(() => expect(result.current.isAuthReady).toBe(true));
    await act(async () => {
      await result.current.connect();
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /WalletConnect/ }));
    });

    await waitFor(() => expect(result.current.error).toBe('Connection request was rejected.'));
    expect(result.current.walletAddress).toBe('');
  });
});
