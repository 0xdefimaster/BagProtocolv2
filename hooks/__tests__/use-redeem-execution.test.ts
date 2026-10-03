// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { RedeemIntent } from '@/types/redeem-intent';

// -----------------------------------------------------------------------------
// Tests for hooks/use-redeem-execution.ts — this hook had ZERO test coverage
// before this file, which is exactly how a real bug shipped unnoticed: an
// incomplete edit left the file with no `export function useRedeemExecution`
// declaration at all (a bare TS1128 syntax error — the file could not even
// be imported). Fixed alongside adding this test file.
//
// Covers the V11 addition specifically: `start()` must call the
// RedeemFeeRouter path (attest-fee -> approvals -> redeem() -> confirm-router-tx)
// whenever NEXT_PUBLIC_REDEEM_FEE_ROUTER_ADDRESS is configured, and must NOT
// fall through to the legacy `/execute` + LI.FI per-step path in that case —
// per the V11 brief's explicit requirement that a router-configured
// deployment can never silently bypass fee enforcement.
// -----------------------------------------------------------------------------

const executeRouteMock = vi.fn<(...args: unknown[]) => unknown>();
const convertQuoteToRouteMock = vi.fn<(...args: unknown[]) => unknown>((step: unknown) => ({ __fromStep: step }));
vi.mock('@lifi/sdk', () => ({
  executeRoute: (...args: unknown[]) => executeRouteMock(...args),
  convertQuoteToRoute: (...args: unknown[]) => convertQuoteToRouteMock(...args),
}));
vi.mock('@/lib/blockchain/lifi-wallet-client', () => ({
  getBrowserLiFiClient: vi.fn(() => ({ __fakeLiFiClient: true })),
}));

const ensureRouterAllowanceMock = vi.fn();
const sendRedeemTransactionMock = vi.fn();
const collectRequiredApprovalsMock = vi.fn();
vi.mock('@/lib/blockchain/redeem-fee-router-client', () => ({
  ensureRouterAllowance: (...args: unknown[]) => ensureRouterAllowanceMock(...args),
  sendRedeemTransaction: (...args: unknown[]) => sendRedeemTransactionMock(...args),
  collectRequiredApprovals: (...args: unknown[]) => collectRequiredApprovalsMock(...args),
}));

const ROUTER_ADDRESS = '0x000000000000000000000000000000000000cc';
const WALLET_ADDRESS = '0x000000000000000000000000000000000000aa';
const BAG_ID = 'bag_1';

function baseIntent(overrides: Partial<RedeemIntent> = {}): RedeemIntent {
  return {
    id: 'intent_1',
    status: 'DRAFT',
    bagId: BAG_ID,
    userId: 'user_1',
    steps: [],
    failureCode: null,
    ...overrides,
  } as RedeemIntent;
}

function mockFetchSequence(responses: { url: RegExp; body: unknown; ok?: boolean }[]) {
  global.fetch = vi.fn((url: string) => {
    const match = responses.find((r) => r.url.test(url));
    if (!match) throw new Error(`Unexpected fetch to ${url}`);
    return Promise.resolve({
      ok: match.ok ?? true,
      json: async () => match.body,
    });
  }) as unknown as typeof fetch;
}

describe('useRedeemExecution', () => {
  beforeEach(() => {
    executeRouteMock.mockReset();
    convertQuoteToRouteMock.mockClear();
    ensureRouterAllowanceMock.mockReset();
    sendRedeemTransactionMock.mockReset();
    collectRequiredApprovalsMock.mockReset();
    delete (process.env as Record<string, string | undefined>).NEXT_PUBLIC_REDEEM_FEE_ROUTER_ADDRESS;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('module loads and exports a working hook (regression test for the prior syntax error that made this file unimportable)', async () => {
    const { useRedeemExecution } = await import('../use-redeem-execution');
    const { result } = renderHook(() => useRedeemExecution());
    expect(result.current.state.phase).toBe('idle');
    expect(typeof result.current.start).toBe('function');
  });

  it('when NEXT_PUBLIC_REDEEM_FEE_ROUTER_ADDRESS is configured, start() uses the router path: attest-fee -> approvals -> redeem() -> confirm-router-tx, and NEVER calls /execute or LI.FI', async () => {
    process.env.NEXT_PUBLIC_REDEEM_FEE_ROUTER_ADDRESS = ROUTER_ADDRESS;
    const { useRedeemExecution } = await import('../use-redeem-execution');

    const attestation = {
      redemptionId: '0xabc',
      user: WALLET_ADDRESS,
      creator: '0x000000000000000000000000000000000000cd',
      legs: [{ inputToken: '0x1', inputAmount: '100', swapTarget: '0x2', swapCallData: '0x' }],
      feeAmount: '10',
      minUserProceeds: '90',
      deadline: 9999999999,
      signature: '0xsig',
    };
    collectRequiredApprovalsMock.mockReturnValue([{ token: '0x1', amount: BigInt(100) }]);
    sendRedeemTransactionMock.mockResolvedValue({ txHash: '0xtx1', confirmed: true });

    mockFetchSequence([
      { url: /\/redeem-intent$/, body: { intent: baseIntent({ id: 'intent_1' }) } },
      { url: /attest-fee$/, body: { attestation } },
      { url: /confirm-router-tx$/, body: { ok: true } },
      { url: /\/execute$/, body: { intent: baseIntent() } }, // present only to fail the test loudly if it's ever called
    ]);

    const { result } = renderHook(() => useRedeemExecution());
    await act(async () => {
      await result.current.start(BAG_ID, '500000', 'asset_usdg', WALLET_ADDRESS);
    });

    expect(ensureRouterAllowanceMock).toHaveBeenCalledWith('0x1', WALLET_ADDRESS, ROUTER_ADDRESS, BigInt(100));
    expect(sendRedeemTransactionMock).toHaveBeenCalledWith(ROUTER_ADDRESS, WALLET_ADDRESS, attestation);
    expect(executeRouteMock).not.toHaveBeenCalled();
    expect(result.current.state.phase).toBe('completed');

    const fetchedUrls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(fetchedUrls.some((u: string) => u.endsWith('/execute'))).toBe(false);
  });

  it('a reverted router transaction fails the whole redemption immediately, without falling through to the legacy verify-poll loop', async () => {
    process.env.NEXT_PUBLIC_REDEEM_FEE_ROUTER_ADDRESS = ROUTER_ADDRESS;
    const { useRedeemExecution } = await import('../use-redeem-execution');

    collectRequiredApprovalsMock.mockReturnValue([]);
    sendRedeemTransactionMock.mockResolvedValue({ txHash: '0xtx1', confirmed: false });

    mockFetchSequence([
      { url: /\/redeem-intent$/, body: { intent: baseIntent({ id: 'intent_1' }) } },
      { url: /attest-fee$/, body: { attestation: { legs: [] } } },
      { url: /verify$/, body: { intent: baseIntent({ status: 'FAILED' }) } },
    ]);

    const { result } = renderHook(() => useRedeemExecution());
    await act(async () => {
      await result.current.start(BAG_ID, '500000', 'asset_usdg', WALLET_ADDRESS);
    });

    expect(result.current.state.phase).toBe('failed');
    expect(result.current.state.error).toMatch(/reverted on-chain/);
    const fetchedUrls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(fetchedUrls.some((u: string) => u.endsWith('/verify'))).toBe(false);
  });

  it('when the router address is NOT configured, start() falls back to the legacy /execute + LI.FI path and never calls attest-fee', async () => {
    const { useRedeemExecution } = await import('../use-redeem-execution');

    mockFetchSequence([
      { url: /\/redeem-intent$/, body: { intent: baseIntent({ id: 'intent_1' }) } },
      { url: /\/execute$/, body: { intent: baseIntent({ id: 'intent_1', steps: [] }) } },
      { url: /verify$/, body: { intent: baseIntent({ id: 'intent_1', status: 'COMPLETED' }) } },
    ]);

    const { result } = renderHook(() => useRedeemExecution());
    await act(async () => {
      await result.current.start(BAG_ID, '500000', 'asset_usdg', WALLET_ADDRESS);
    });

    expect(sendRedeemTransactionMock).not.toHaveBeenCalled();
    expect(result.current.state.phase).toBe('completed');
    const fetchedUrls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(fetchedUrls.some((u: string) => u.endsWith('attest-fee'))).toBe(false);
  });
});
