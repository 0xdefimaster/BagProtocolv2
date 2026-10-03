// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const preparePurchaseIntentMock = vi.fn();
vi.mock('@/hooks/use-purchase-execution', () => ({
  preparePurchaseIntent: (...args: unknown[]) => preparePurchaseIntentMock(...args),
}));

const { usePurchasePrefetch, purchasePrefetchKey, PURCHASE_PREFETCH_IDLE_MS } = await import('../use-purchase-prefetch');

beforeEach(() => {
  vi.useFakeTimers();
  preparePurchaseIntentMock.mockReset();
  preparePurchaseIntentMock.mockResolvedValue({ id: 'intent_1' });
});
afterEach(() => {
  vi.useRealTimers();
});

type Props = { amount: string; enabled: boolean };
const render = (initial: Props) =>
  renderHook((p: Props) => usePurchasePrefetch({ bagId: 'bag_1', inputAssetId: 'usdg', amount: p.amount, providerId: null, enabled: p.enabled }), {
    initialProps: initial,
  });

describe('usePurchasePrefetch', () => {
  it('prepares once the amount has been idle, and hands it over only for the same key', async () => {
    const { result } = render({ amount: '100', enabled: true });
    expect(preparePurchaseIntentMock).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(PURCHASE_PREFETCH_IDLE_MS));
    expect(preparePurchaseIntentMock).toHaveBeenCalledWith('bag_1', 'usdg', '100', undefined);

    expect(result.current.take(purchasePrefetchKey('bag_1', 'usdg', '50'))).toBeUndefined();
    await expect(result.current.take(purchasePrefetchKey('bag_1', 'usdg', '100'))).resolves.toEqual({ id: 'intent_1' });
    // Consumed: a retry prepares fresh.
    expect(result.current.take(purchasePrefetchKey('bag_1', 'usdg', '100'))).toBeUndefined();
  });

  it('does nothing while disabled, and only prepares the settled amount while typing', () => {
    const { rerender } = render({ amount: '1', enabled: false });
    act(() => void vi.advanceTimersByTime(PURCHASE_PREFETCH_IDLE_MS * 2));
    expect(preparePurchaseIntentMock).not.toHaveBeenCalled();

    rerender({ amount: '10', enabled: true });
    act(() => void vi.advanceTimersByTime(PURCHASE_PREFETCH_IDLE_MS / 2));
    rerender({ amount: '100', enabled: true });
    act(() => void vi.advanceTimersByTime(PURCHASE_PREFETCH_IDLE_MS));
    expect(preparePurchaseIntentMock).toHaveBeenCalledTimes(1);
    expect(preparePurchaseIntentMock).toHaveBeenCalledWith('bag_1', 'usdg', '100', undefined);
  });

  it('pressing Buy (take) cancels a preparation that has not started yet', () => {
    const { result } = render({ amount: '100', enabled: true });
    act(() => void vi.advanceTimersByTime(PURCHASE_PREFETCH_IDLE_MS / 2));
    expect(result.current.take(purchasePrefetchKey('bag_1', 'usdg', '100'))).toBeUndefined();
    act(() => void vi.advanceTimersByTime(PURCHASE_PREFETCH_IDLE_MS * 2));
    expect(preparePurchaseIntentMock).not.toHaveBeenCalled();
  });

  it('a failed preparation resolves to null instead of throwing', async () => {
    preparePurchaseIntentMock.mockRejectedValue(new Error('429'));
    const { result } = render({ amount: '100', enabled: true });
    act(() => void vi.advanceTimersByTime(PURCHASE_PREFETCH_IDLE_MS));
    await expect(result.current.take(purchasePrefetchKey('bag_1', 'usdg', '100'))).resolves.toBeNull();
  });
});
