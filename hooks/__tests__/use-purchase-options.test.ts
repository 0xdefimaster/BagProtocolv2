// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { CANDIDATE_TTL_MS } from '@/lib/execution/candidate-types';
import { resetPurchaseOptionsAvailability, resolveSelectedProviderId, usePurchaseOptions, PurchaseOptionsView } from '../use-purchase-options';

// -----------------------------------------------------------------------------
// Checkpoint 8/9 tests — hooks/use-purchase-options.ts.
//
// Covers the four things spec item 9 asks for:
//   1. a stale in-flight request resolving AFTER a newer input must never
//      overwrite the newer state ("old request resolves after new input")
//   2. clearing the input while a request is in flight must not let that
//      request's (late) response write options back in
//      ("input goes blank, old in-flight response can't write options")
//   3. a candidate comparison past CANDIDATE_TTL_MS must be flagged stale,
//      not silently kept looking fresh ("stale candidate not used as fresh")
//   4. after a refresh, a previously-selected provider that dropped out of
//      the executable set must not stay selected
//      ("refresh drops the selected provider — falls back automatically")
//
// `resolveSelectedProviderId` is tested directly (it's a pure function) —
// this is the same logic `PurchasePreviewModal` wires into its own effect,
// see that component's own doc for why the decision itself lives here
// instead of inline in the component.
//
// NOTE on `waitFor`: deliberately NOT used anywhere in this file.
// `@testing-library/react`'s `waitFor` polls on REAL timers internally, so
// mixing it with `vi.useFakeTimers()` (every test here uses fake timers,
// to control the 300ms debounce and the TTL without a real 30s+ sleep)
// makes it hang until vitest's own real testTimeout fires. Every assertion
// below instead follows an `act(async () => { await vi.runAllTimersAsync(); })`
// block, which drains both pending timers AND the microtask queue they
// schedule (promise `.then()`/`await` chains) until nothing is left
// pending — the fake-timer-safe equivalent of "wait for everything to
// settle".
// -----------------------------------------------------------------------------

const BAG_ID = 'bag_1';

function jsonResponse(status: number, body: unknown) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response);
}

function fakeCandidate(overrides: Partial<PurchaseOptionsView['candidates'][number]> = {}): PurchaseOptionsView['candidates'][number] {
  return {
    id: 'lifi-sequential',
    providerId: 'lifi-sequential',
    compile: { status: 'COMPILED' },
    executionMode: 'MULTI_TX',
    metrics: null,
    executionPlanHash: 'hash-1',
    compiledAt: Date.now(),
    swapLegCount: 1,
    ...overrides,
  };
}

function fakeOptions(overrides: Partial<PurchaseOptionsView> = {}): PurchaseOptionsView {
  return {
    candidates: [
      fakeCandidate({ id: 'c-sequential', providerId: 'lifi-sequential' }),
      fakeCandidate({ id: 'c-router', providerId: 'bag-router' }),
    ],
    failed: [],
    winners: [{ category: 'bestGuaranteedOutput', candidateId: 'c-sequential', providerId: 'lifi-sequential' }],
    executionPlanHash: 'hash-1',
    compiledAt: Date.now(),
    ...overrides,
  };
}

const fetchMock = vi.fn();

beforeEach(() => {
  resetPurchaseOptionsAvailability();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('usePurchaseOptions — race conditions (spec item 9)', () => {
  it('an old request resolving AFTER a newer input change never overwrites the newer state', async () => {
    // Two distinct, never-resolving-until-we-say-so fetches: request #1 for
    // amount "100", request #2 for amount "250". #1 is deliberately made to
    // resolve LAST, simulating a slow/stale in-flight response landing
    // after the input already moved on.
    let resolveFirst!: (v: unknown) => void;
    let resolveSecond!: (v: unknown) => void;
    const firstOptions = fakeOptions({ executionPlanHash: 'hash-for-100' });
    const secondOptions = fakeOptions({ executionPlanHash: 'hash-for-250' });

    fetchMock
      .mockImplementationOnce(() => new Promise((res) => { resolveFirst = res; }))
      .mockImplementationOnce(() => new Promise((res) => { resolveSecond = res; }));

    const { result, rerender } = renderHook(
      ({ amount }) => usePurchaseOptions(BAG_ID, 'asset_1', amount),
      { initialProps: { amount: '100' } }
    );

    // Fire request #1.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // User changes the amount before #1 resolves — fires request #2 (also
    // proves `options` was cleared the instant the new request started,
    // not just once it resolves — spec item 4).
    rerender({ amount: '250' });
    expect(result.current.options).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // #2 (the CURRENT request) resolves first.
    await act(async () => {
      resolveSecond(jsonResponse(200, { options: secondOptions }));
      await vi.runAllTimersAsync();
    });
    expect(result.current.options?.executionPlanHash).toBe('hash-for-250');

    // #1 (the STALE, superseded request) resolves late, after #2 already won.
    await act(async () => {
      resolveFirst(jsonResponse(200, { options: firstOptions }));
      await vi.runAllTimersAsync();
    });

    // Must still be #2's result — the late #1 response must never have
    // been allowed to overwrite it.
    expect(result.current.options?.executionPlanHash).toBe('hash-for-250');
  });

  it('clearing the input while a request is in flight prevents that late response from writing options back in', async () => {
    let resolveInFlight!: (v: unknown) => void;
    fetchMock.mockImplementationOnce(() => new Promise((res) => { resolveInFlight = res; }));

    const { result, rerender } = renderHook(
      ({ amount }) => usePurchaseOptions(BAG_ID, 'asset_1', amount),
      { initialProps: { amount: '100' } }
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.loading).toBe(true);

    // User clears the amount entirely — the old bug: this branch never
    // invalidated the in-flight request id, so the response below would
    // still have been accepted.
    rerender({ amount: '' });
    expect(result.current.options).toBeNull();
    expect(result.current.loading).toBe(false);

    // The request that was already in flight for "100" now resolves.
    await act(async () => {
      resolveInFlight(jsonResponse(200, { options: fakeOptions() }));
      await vi.runAllTimersAsync();
    });

    // Must still be null — a cleared input must never be overwritten by a
    // stale in-flight response.
    expect(result.current.options).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it('the same stale-response protection applies when the input goes to "0" instead of empty', async () => {
    let resolveInFlight!: (v: unknown) => void;
    fetchMock.mockImplementationOnce(() => new Promise((res) => { resolveInFlight = res; }));

    const { result, rerender } = renderHook(
      ({ amount }) => usePurchaseOptions(BAG_ID, 'asset_1', amount),
      { initialProps: { amount: '100' } }
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    rerender({ amount: '0' });
    expect(result.current.options).toBeNull();

    await act(async () => {
      resolveInFlight(jsonResponse(200, { options: fakeOptions() }));
      await vi.runAllTimersAsync();
    });

    expect(result.current.options).toBeNull();
  });
});

describe('usePurchaseOptions — staleness (spec item 5/7)', () => {
  it('a fresh comparison is not stale, and becomes stale once CANDIDATE_TTL_MS elapses — without any additional fetch happening', async () => {
    fetchMock.mockImplementationOnce(() => jsonResponse(200, { options: fakeOptions() }));

    const { result } = renderHook(() => usePurchaseOptions(BAG_ID, 'asset_1', '100'));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
      await vi.runAllTimersAsync();
    });
    expect(result.current.options).not.toBeNull();
    expect(result.current.isStale).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(CANDIDATE_TTL_MS + 1);
    });

    expect(result.current.isStale).toBe(true);
    // No poll — staleness is a local clock flip, not a re-fetch (spec item 7).
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refresh() re-fetches the same (bagId, inputAssetId, amount) and clears staleness once the new comparison lands', async () => {
    fetchMock
      .mockImplementationOnce(() => jsonResponse(200, { options: fakeOptions() }))
      .mockImplementationOnce(() => jsonResponse(200, { options: fakeOptions() }));

    const { result } = renderHook(() => usePurchaseOptions(BAG_ID, 'asset_1', '100'));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
      await vi.runAllTimersAsync();
    });
    expect(result.current.options).not.toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(CANDIDATE_TTL_MS + 1);
    });
    expect(result.current.isStale).toBe(true);

    act(() => {
      result.current.refresh();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
      await vi.runAllTimersAsync();
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.isStale).toBe(false);
  });
});

describe('resolveSelectedProviderId — post-refresh provider fallback (spec item 8/9)', () => {
  it('keeps the previous selection when the graph is unchanged and that provider is still executable', () => {
    const options = fakeOptions({ executionPlanHash: 'hash-1' });
    const resolved = resolveSelectedProviderId({
      previousProviderId: 'bag-router',
      previousExecutionPlanHash: 'hash-1',
      options,
    });
    expect(resolved).toBe('bag-router');
  });

  it('falls back to null (nothing left to compare) when the previously-selected provider is no longer executable after a refresh with the SAME executionPlanHash', () => {
    // Same graph (hash-1 both times), but "bag-router" failed on the refresh.
    const options = fakeOptions({
      executionPlanHash: 'hash-1',
      candidates: [fakeCandidate({ id: 'c-sequential', providerId: 'lifi-sequential' })],
      failed: [fakeCandidate({ id: 'c-router', providerId: 'bag-router', compile: { status: 'FAILED' } })],
      winners: [{ category: 'bestGuaranteedOutput', candidateId: 'c-sequential', providerId: 'lifi-sequential' }],
    });

    const resolved = resolveSelectedProviderId({
      previousProviderId: 'bag-router', // no longer executable
      previousExecutionPlanHash: 'hash-1', // SAME hash — the case a naive hash-only effect misses
      options,
    });

    expect(resolved).toBe(null); // only 1 executable candidate left — nothing to compare, matches showCandidatePicker's own threshold
  });

  it('falls back correctly when the refresh drops the selected provider but leaves multiple candidates executable', () => {
    const options = fakeOptions({
      executionPlanHash: 'hash-1',
      candidates: [
        fakeCandidate({ id: 'c-sequential', providerId: 'lifi-sequential' }),
        fakeCandidate({ id: 'c-composer', providerId: 'lifi-composer' }),
      ],
      failed: [fakeCandidate({ id: 'c-router', providerId: 'bag-router', compile: { status: 'FAILED' } })],
      winners: [{ category: 'bestGuaranteedOutput', candidateId: 'c-composer', providerId: 'lifi-composer' }],
    });

    const resolved = resolveSelectedProviderId({
      previousProviderId: 'bag-router', // dropped
      previousExecutionPlanHash: 'hash-1',
      options,
    });

    expect(resolved).toBe('lifi-composer'); // the new bestGuaranteedOutput winner, never the stale "bag-router"
  });

  it('always re-derives (never blindly trusts the old pick) when executionPlanHash actually changed, even if a same-named provider is still present', () => {
    const options = fakeOptions({
      executionPlanHash: 'hash-2', // genuinely different graph
      winners: [{ category: 'bestGuaranteedOutput', candidateId: 'c-router', providerId: 'bag-router' }],
    });

    const resolved = resolveSelectedProviderId({
      previousProviderId: 'lifi-sequential',
      previousExecutionPlanHash: 'hash-1', // stale graph
      options,
    });

    expect(resolved).toBe('bag-router'); // re-derived bestGuaranteedOutput for the NEW graph, not the old pick
  });

  it('uses bestQuotedOutput when no guaranteed-output winner exists, and registry order when neither comparison is valid', () => {
    const candidates = [fakeCandidate({ id: 'c-router', providerId: 'bag-router' }), fakeCandidate({ id: 'c-sequential', providerId: 'lifi-sequential' })];
    const quotedOnly = fakeOptions({ candidates, winners: [{ category: 'bestQuotedOutput', candidateId: 'c-sequential', providerId: 'lifi-sequential' }] });
    expect(resolveSelectedProviderId({ previousProviderId: null, previousExecutionPlanHash: null, options: quotedOnly })).toBe('lifi-sequential');
    const noComparison = fakeOptions({ candidates, winners: [] });
    expect(resolveSelectedProviderId({ previousProviderId: null, previousExecutionPlanHash: null, options: noComparison })).toBe('bag-router');
  });

  it('returns null when there is nothing to compare (0 or 1 executable candidates)', () => {
    const options = fakeOptions({
      candidates: [fakeCandidate({ id: 'c-sequential', providerId: 'lifi-sequential' })],
    });
    expect(resolveSelectedProviderId({ previousProviderId: null, previousExecutionPlanHash: null, options })).toBe(null);
    expect(resolveSelectedProviderId({ previousProviderId: null, previousExecutionPlanHash: null, options: null })).toBe(null);
  });
});

describe('usePurchaseOptions — requests it never needs to make', () => {
  it('makes no request while disabled (the automatic launch buy)', async () => {
    renderHook(() => usePurchaseOptions(BAG_ID, 'asset_1', '100', false));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stops asking after the server says route selection is unavailable on this deployment', async () => {
    fetchMock.mockResolvedValue(jsonResponse(409, { error: 'unavailable', code: 'PROVIDER_SELECTION_UNAVAILABLE' }));
    const { rerender } = renderHook(({ amount }) => usePurchaseOptions(BAG_ID, 'asset_1', amount), { initialProps: { amount: '100' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
      await vi.runAllTimersAsync();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    rerender({ amount: '250' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps asking after an ordinary failure (e.g. rate limit)', async () => {
    fetchMock.mockResolvedValue(jsonResponse(429, { error: 'slow down' }));
    const { rerender } = renderHook(({ amount }) => usePurchaseOptions(BAG_ID, 'asset_1', amount), { initialProps: { amount: '100' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
      await vi.runAllTimersAsync();
    });
    rerender({ amount: '250' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
      await vi.runAllTimersAsync();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

