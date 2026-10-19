// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const push = vi.fn();
const connect = vi.fn(async () => {});
const signIn = vi.fn(async () => {});
const addActivity = vi.fn();
let isConnected = true;

vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));
vi.mock('@/lib/wallet-context', () => ({ useWallet: () => ({ isConnected, connect, signIn }) }));
vi.mock('@/lib/activity-store', () => ({ useActivity: () => ({ addActivity }) }));

const { useForkBag } = await import('../useForkBag');

const fetchMock = vi.fn();
const SOURCE = { id: 'src-1', name: 'AI Basket' };

function jsonResponse(status: number, body: unknown) {
  return { status, ok: status >= 200 && status < 300, json: async () => body } as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
  isConnected = true;
  localStorage.clear();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('useForkBag', () => {
  it('forks through the API and opens the new bag', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(201, { bag: { id: 'new-1' } }));
    const { result } = renderHook(() => useForkBag());
    await act(async () => result.current.fork(SOURCE));

    expect(fetchMock.mock.calls[0][0]).toBe('/api/bags/src-1/fork');
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe('POST');
    expect(push).toHaveBeenCalledWith('/dashboard/bag/new-1?deploy=1');
    expect(result.current.forkError).toBeNull();
  });

  it('never creates a local fallback bag when the request fails', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    const { result } = renderHook(() => useForkBag());
    await act(async () => result.current.fork(SOURCE));

    expect(push).not.toHaveBeenCalled();
    expect(localStorage.getItem('bag-protocol:user-bags')).toBeNull();
    expect(result.current.forkError).toMatch(/network error/);
  });

  it('shows the server error instead of pretending it worked', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(404, { error: 'Bag not found.' }));
    const { result } = renderHook(() => useForkBag());
    await act(async () => result.current.fork(SOURCE));

    expect(push).not.toHaveBeenCalled();
    expect(result.current.forkError).toBe('Bag not found.');
  });

  it('on 401 with a connected wallet asks for the sign-in signature', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: 'Unauthorized' }));
    const { result } = renderHook(() => useForkBag());
    await act(async () => result.current.fork(SOURCE));

    expect(signIn).toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  it('on 401 with no wallet connected opens the wallet connection', async () => {
    isConnected = false;
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: 'Unauthorized' }));
    const { result } = renderHook(() => useForkBag());
    await act(async () => result.current.fork(SOURCE));

    expect(connect).toHaveBeenCalled();
    expect(signIn).not.toHaveBeenCalled();
    expect(result.current.forkError).toMatch(/Connect your wallet/);
  });
});
