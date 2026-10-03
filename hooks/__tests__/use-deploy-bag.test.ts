// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const sendTransactionMock = vi.fn<(args: unknown) => Promise<string>>();
const getBrowserWalletClientForChainMock = vi.fn(async () => ({ chain: { id: 4663 }, sendTransaction: sendTransactionMock }));

vi.mock('@/lib/blockchain/lifi-wallet-client', () => ({
  getBrowserWalletClientForChain: (...args: unknown[]) => (getBrowserWalletClientForChainMock as unknown as (...a: unknown[]) => unknown)(...args),
}));

const { useDeployBag } = await import('../use-deploy-bag');

const BAG_ID = 'bag_1';
const SESSION_WALLET = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
const TX = `0x${'ab'.repeat(32)}`;

const fetchMock = vi.fn();

function jsonResponse(status: number, body: unknown) {
  return { status, json: async () => body } as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
  sendTransactionMock.mockResolvedValue(TX);
  localStorage.clear();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const prepareOk = () =>
  jsonResponse(200, { transaction: { to: '0xfactory', data: '0xdead', chainId: 4663 }, wallet: SESSION_WALLET, chain: 'robinhood', factoryAddress: '0xfactory' });
const confirmOk = () => jsonResponse(200, { deployment: { txHash: TX, contractAddress: '0xbag', onChainBagId: '0xid' }, bag: { status: 'ACTIVE' }, alreadyConfirmed: false });

describe('useDeployBag — happy path', () => {
  it('prepare -> connected-wallet check -> sendTransaction -> confirm -> completed', async () => {
    fetchMock.mockResolvedValueOnce(prepareOk()).mockResolvedValueOnce(confirmOk());
    const { result } = renderHook(() => useDeployBag(BAG_ID));

    await act(async () => {
      await result.current.deploy(SESSION_WALLET);
    });

    expect(fetchMock.mock.calls[0][0]).toBe(`/api/bags/${BAG_ID}/deploy/prepare`);
    expect(sendTransactionMock).toHaveBeenCalledWith(expect.objectContaining({ to: '0xfactory', data: '0xdead', account: SESSION_WALLET }));
    expect(fetchMock.mock.calls[1][0]).toBe(`/api/bags/${BAG_ID}/deploy/confirm`);
    expect(JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string)).toEqual({ txHash: TX });

    expect(result.current.state).toMatchObject({ phase: 'completed', deployment: { txHash: TX }, bagStatus: 'ACTIVE' });
    expect(localStorage.getItem(`bag-deploy-pending-tx:${BAG_ID}`)).toBeNull(); // cleared on success
  });
});

describe('useDeployBag — trust boundary: wallet mismatch never reaches the wallet prompt', () => {
  it('a connected wallet different from the session wallet fails BEFORE sendTransaction and before any confirm call', async () => {
    fetchMock.mockResolvedValueOnce(prepareOk());
    const { result } = renderHook(() => useDeployBag(BAG_ID));
    const otherWallet = '0x000000000000000000000000000000000000aa';

    await act(async () => {
      await result.current.deploy(otherWallet);
    });

    expect(sendTransactionMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1); // prepare only
    expect(result.current.state).toMatchObject({ phase: 'failed', error: expect.stringMatching(/doesn't match/) });
  });
});

describe('useDeployBag — user rejection', () => {
  it('a rejected signature (EIP-1193 code 4001) leaves nothing pending and gives a clear message', async () => {
    fetchMock.mockResolvedValueOnce(prepareOk());
    sendTransactionMock.mockRejectedValueOnce({ code: 4001, message: 'User rejected' });
    const { result } = renderHook(() => useDeployBag(BAG_ID));

    await act(async () => {
      await result.current.deploy(SESSION_WALLET);
    });

    expect(result.current.state).toMatchObject({ phase: 'failed', error: 'Signature request was rejected.' });
    expect(fetchMock).toHaveBeenCalledTimes(1); // confirm was never called
    expect(localStorage.getItem(`bag-deploy-pending-tx:${BAG_ID}`)).toBeNull();
  });
});

describe('useDeployBag — PENDING then success, and refresh recovery', () => {
  it('confirm returning 202 PENDING is retried automatically until it succeeds', async () => {
    vi.useFakeTimers();
    try {
      fetchMock
        .mockResolvedValueOnce(prepareOk())
        .mockResolvedValueOnce(jsonResponse(202, { status: 'PENDING', code: 'PENDING' }))
        .mockResolvedValueOnce(jsonResponse(202, { status: 'PENDING', code: 'PENDING' }))
        .mockResolvedValueOnce(confirmOk());
      const { result } = renderHook(() => useDeployBag(BAG_ID));

      const p = act(async () => {
        await result.current.deploy(SESSION_WALLET);
      });
      await vi.runAllTimersAsync();
      await p;

      expect(fetchMock).toHaveBeenCalledTimes(4); // prepare + 2 pending + 1 success
      expect(result.current.state.phase).toBe('completed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('persists the pending tx hash so resumePending() can confirm it again without re-signing after a refresh', async () => {
    fetchMock.mockResolvedValueOnce(prepareOk()).mockResolvedValueOnce(jsonResponse(202, { status: 'PENDING', code: 'PENDING' }));
    const { result, unmount } = renderHook(() => useDeployBag(BAG_ID));

    await act(async () => {
      // deploy() awaits the confirm loop internally; stop it after the first PENDING by using real timers
      // but a deploy() promise that resolves once — simulate "page reload" by unmounting mid-flow instead.
    });
    void result.current.deploy(SESSION_WALLET);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    unmount(); // simulates navigating away / refreshing before confirmation finished

    expect(localStorage.getItem(`bag-deploy-pending-tx:${BAG_ID}`)).toBe(TX);

    // A fresh mount ("after reload") resumes from the persisted hash — no new prepare, no new signature.
    fetchMock.mockResolvedValueOnce(confirmOk());
    const { result: fresh } = renderHook(() => useDeployBag(BAG_ID));
    await act(async () => {
      await fresh.current.resumePending();
    });
    expect(sendTransactionMock).toHaveBeenCalledTimes(1); // still only the ORIGINAL send
    expect(fresh.current.state).toMatchObject({ phase: 'completed', deployment: { txHash: TX } });
  });
});

describe('useDeployBag — definitive failures write nothing further', () => {
  it('VERIFICATION_FAILED stops retrying and surfaces the server message', async () => {
    fetchMock
      .mockResolvedValueOnce(prepareOk())
      .mockResolvedValueOnce(jsonResponse(422, { error: 'Transaction is not a valid deployment for this bag: wrong sender', code: 'VERIFICATION_FAILED' }));
    const { result } = renderHook(() => useDeployBag(BAG_ID));

    await act(async () => {
      await result.current.deploy(SESSION_WALLET);
    });

    expect(result.current.state).toMatchObject({ phase: 'failed', error: expect.stringMatching(/wrong sender/) });
    expect(fetchMock).toHaveBeenCalledTimes(2); // no further retries after a definitive failure
  });
});
