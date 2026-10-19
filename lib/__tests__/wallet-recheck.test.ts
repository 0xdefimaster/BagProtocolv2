import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RECHECK_CONFIRM_DELAY_MS, recheckWalletAfterTrade } from '../wallet-recheck';

// After a Swap/sweep the wallet is checked once now and once after the 2-minute confirmation window.

const fetchMock = vi.fn(async () => new Response('{}'));
beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('recheckWalletAfterTrade', () => {
  it('asks now and again after the confirmation window, with reason "trade"', () => {
    recheckWalletAfterTrade();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/users/me/reconcile', expect.objectContaining({ method: 'POST', body: JSON.stringify({ reason: 'trade' }) }));
    expect(RECHECK_CONFIRM_DELAY_MS).toBeGreaterThan(120_000);
    vi.advanceTimersByTime(RECHECK_CONFIRM_DELAY_MS - 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('cancel stops the second check; a failed request is swallowed', () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    const cancel = recheckWalletAfterTrade();
    cancel();
    vi.advanceTimersByTime(RECHECK_CONFIRM_DELAY_MS * 2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
