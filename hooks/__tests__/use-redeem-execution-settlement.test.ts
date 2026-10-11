// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { RedeemIntent } from '@/types/redeem-intent';

// hooks/use-redeem-execution.ts — the fee-paying sale path. `/execute` refuses a Bag with a performance fee
// (FEE_ROUTER_REQUIRED); with RedeemSettlement configured the hook runs the two-phase settlement attestation and
// signs the ONE transaction phase 2 returned, then leaves the outcome to the server's verify (Settled event).
// The wallet is mocked: this proves the hook's own call order, not a real wallet or chain.

const executeWalletSweepMock = vi.fn<(...a: unknown[]) => Promise<void>>();
vi.mock('@/lib/blockchain/wallet-sweep-client', () => ({ executeWalletSweep: (...a: unknown[]) => executeWalletSweepMock(...a) }));
vi.mock('@lifi/sdk', () => ({ executeRoute: vi.fn(), convertQuoteToRoute: vi.fn() }));
vi.mock('@/lib/blockchain/lifi-wallet-client', () => ({ getBrowserLiFiClient: vi.fn() }));
const sendRedeemTransactionMock = vi.fn();
vi.mock('@/lib/blockchain/redeem-fee-router-client', () => ({
  ensureRouterAllowance: vi.fn(),
  sendRedeemTransaction: (...a: unknown[]) => sendRedeemTransactionMock(...a),
  collectRequiredApprovals: vi.fn(() => []),
}));

const { useRedeemExecution } = await import('../use-redeem-execution');

const WALLET = '0x00000000000000000000000000000000000000aa';
const LEGACY_TX = { to: '0xlegacy', data: '0x01', value: '0', chainId: 4663, approvals: [] };
const SETTLEMENT_TX = { to: '0xcomposer', data: '0x02', value: '0', chainId: 4663, approvals: [] };

const intent = (over: Partial<RedeemIntent> = {}): RedeemIntent =>
  ({
    id: 'redeem_1',
    status: 'READY',
    steps: [{ stepIndex: 0, action: 'SWAP' }],
    composerTransaction: LEGACY_TX,
    failureCode: null,
    ...over,
  }) as unknown as RedeemIntent;

type Handler = (url: string) => { status: number; body: unknown };
let handler: Handler;
const calls: string[] = [];

beforeEach(() => {
  calls.length = 0;
  vi.stubEnv('NEXT_PUBLIC_REDEEM_FEE_ROUTER_ADDRESS', '');
  vi.stubEnv('NEXT_PUBLIC_REDEEM_SETTLEMENT_ADDRESS', '0x5555555555555555555555555555555555555555');
  executeWalletSweepMock.mockReset();
  executeWalletSweepMock.mockImplementation(async (_w, _tx, _p, cb) => {
    await (cb as { onSubmitted: (h: string) => Promise<void> }).onSubmitted('0xhash');
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      calls.push(url);
      const { status, body } = handler(url);
      return { ok: status < 400, status, json: async () => body } as Response;
    })
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const feeBagHandler =
  (verified: Partial<RedeemIntent> = { status: 'COMPLETED' }): Handler =>
  (url) => {
    if (url.endsWith('/redeem-intent') && url.startsWith('/api/bags/')) return { status: 200, body: { intent: intent() } };
    if (url.endsWith('/execute')) return { status: 409, body: { error: 'fee', code: 'FEE_ROUTER_REQUIRED' } };
    if (url.endsWith('/settlement-quote')) return { status: 200, body: { plan: {} } };
    if (url.endsWith('/settlement-attest')) return { status: 200, body: { composerTransaction: SETTLEMENT_TX } };
    if (url.includes('/step/')) return { status: 200, body: { intent: intent() } };
    if (url.endsWith('/attest-fee') || url.endsWith('/confirm-router-tx')) throw new Error(`the old router must not be used: ${url}`);
    if (url.endsWith('/verify')) return { status: 200, body: { intent: intent(verified) } };
    if (url === '/api/redeem-intent/redeem_1') return { status: 200, body: { intent: intent() } };
    throw new Error(`unexpected ${url}`);
  };

const run = async () => {
  const { result } = renderHook(() => useRedeemExecution());
  await act(async () => {
    await result.current.start('bag_1', 10_000, 'usdg', WALLET);
  });
  return result;
};

describe('useRedeemExecution — fee-paying sale through RedeemSettlement', () => {
  it('execute refused → quote → attest → signs the attested transaction (not the one built at creation) → verify', async () => {
    handler = feeBagHandler();
    const result = await run();
    const order = calls.filter((u) => !u.includes('/step/'));
    expect(order).toEqual([
      '/api/bags/bag_1/redeem-intent',
      '/api/redeem-intent/redeem_1/execute',
      '/api/redeem-intent/redeem_1/settlement-quote',
      '/api/redeem-intent/redeem_1/settlement-attest',
      // The attestation's deadline, read once: a declined signature can be given again until then.
      '/api/redeem-intent/redeem_1',
      '/api/redeem-intent/redeem_1/verify',
    ]);
    expect(executeWalletSweepMock).toHaveBeenCalledTimes(1);
    expect(executeWalletSweepMock.mock.calls[0][1]).toEqual({ transaction: SETTLEMENT_TX, approvals: SETTLEMENT_TX.approvals });
    expect(result.current.state.phase).toBe('completed');
  });

  it('a refused quote or attestation is the outcome: nothing is signed', async () => {
    const base = feeBagHandler();
    handler = (url) => (url.endsWith('/settlement-attest') ? { status: 409, body: { error: 'Another sale is open', code: 'ANOTHER_SALE_OPEN' } } : base(url));
    const result = await run();
    expect(executeWalletSweepMock).not.toHaveBeenCalled();
    expect(result.current.state.phase).toBe('failed');
    expect(result.current.state.error).toBe('Another sale is open');
  });

  it('settlement not configured: the FEE_ROUTER_REQUIRED refusal is shown, no settlement call', async () => {
    vi.stubEnv('NEXT_PUBLIC_REDEEM_SETTLEMENT_ADDRESS', '');
    handler = feeBagHandler();
    const result = await run();
    expect(calls.some((u) => u.includes('settlement'))).toBe(false);
    expect(executeWalletSweepMock).not.toHaveBeenCalled();
    expect(result.current.state.phase).toBe('failed');
  });

  it('a fee-0 Bag is unchanged: execute succeeds and the creation-time Composer transaction is signed', async () => {
    const base = feeBagHandler();
    handler = (url) => (url.endsWith('/execute') ? { status: 200, body: { intent: intent({ status: 'AWAITING_SIGNATURE' }) } } : base(url));
    await run();
    expect(calls.some((u) => u.includes('settlement'))).toBe(false);
    expect(executeWalletSweepMock.mock.calls[0][1]).toEqual({ transaction: LEGACY_TX, approvals: [] });
  });

  describe('routing invariant: with RedeemSettlement configured, the old RedeemFeeRouter is never used', () => {
    beforeEach(() => vi.stubEnv('NEXT_PUBLIC_REDEEM_FEE_ROUTER_ADDRESS', '0x6666666666666666666666666666666666666666'));

    it('fee-paying sale with the router address also set: settlement path only', async () => {
      handler = feeBagHandler();
      const result = await run();
      expect(calls.some((u) => u.endsWith('/attest-fee') || u.endsWith('/confirm-router-tx'))).toBe(false);
      expect(sendRedeemTransactionMock).not.toHaveBeenCalled();
      expect(calls).toContain('/api/redeem-intent/redeem_1/settlement-attest');
      expect(result.current.state.phase).toBe('completed');
    });

    it('free sale with the router address also set: the existing free path', async () => {
      const base = feeBagHandler();
      handler = (url) => (url.endsWith('/execute') ? { status: 200, body: { intent: intent({ status: 'AWAITING_SIGNATURE' }) } } : base(url));
      await run();
      expect(calls.some((u) => u.endsWith('/attest-fee') || u.includes('settlement'))).toBe(false);
      expect(executeWalletSweepMock.mock.calls[0][1]).toEqual({ transaction: LEGACY_TX, approvals: [] });
    });
  });
});
