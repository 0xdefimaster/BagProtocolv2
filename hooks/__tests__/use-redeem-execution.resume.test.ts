// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { RedeemIntent } from '@/types/redeem-intent';

// A fee-paying sale (RedeemSettlement) whose wallet signature is declined while its settlement attestation is still
// valid: declining is not final, "Sign again" signs the SAME transaction, and a retry blocked by that pending sale is
// offered that sale instead of a wait. Plus: an expired session says so. Wallet and API are stubbed.

vi.mock('@lifi/sdk', () => ({ executeRoute: vi.fn(), convertQuoteToRoute: vi.fn() }));
vi.mock('@/lib/blockchain/lifi-wallet-client', () => ({ getBrowserLiFiClient: vi.fn() }));
vi.mock('@/lib/blockchain/redeem-fee-router-client', () => ({ ensureRouterAllowance: vi.fn(), sendRedeemTransaction: vi.fn(), collectRequiredApprovals: vi.fn() }));
const sweep = vi.hoisted(() => vi.fn());
vi.mock('@/lib/blockchain/wallet-sweep-client', () => ({ executeWalletSweep: sweep }));

const WALLET = '0x00000000000000000000000000000000000000aa';
const TX = { to: '0x' + '7'.repeat(40), data: '0xdead', value: '0', chainId: 4663, approvals: [] };
const HASH = '0x' + 'f'.repeat(64);
const swapStep = { stepIndex: 0, action: 'SWAP', status: 'PENDING', txHash: null, inputAsset: { address: '0x1' } };

function intent(over: Partial<RedeemIntent> = {}): RedeemIntent {
  return { id: 'intent_1', status: 'AWAITING_SIGNATURE', bagId: 'bag_1', walletAddress: WALLET, steps: [swapStep], failureCode: null, composerTransaction: null, ...over } as unknown as RedeemIntent;
}
const future = () => Math.floor(Date.now() / 1000) + 120;
const rejection = () => Object.assign(new Error('User rejected the request.'), { code: 4001 });

type Route = { match: (url: string, init?: RequestInit) => boolean; status?: number; body: unknown };
let routes: Route[] = [];
let calls: { url: string; init?: RequestInit }[] = [];
function api(list: Route[]) {
  routes = list;
  calls = [];
  global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = routes.find((x) => x.match(url, init));
    if (!r) throw new Error(`Unexpected ${init?.method ?? 'GET'} ${url}`);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
}
const post = (suffix: string) => (url: string, init?: RequestInit) => init?.method === 'POST' && url.endsWith(suffix);
const get = (suffix: string) => (url: string, init?: RequestInit) => (init?.method ?? 'GET') === 'GET' && url.endsWith(suffix);
const reports = () => calls.filter((c) => c.url.includes('/step/')).map((c) => JSON.parse(String(c.init?.body)).type);

function feeSaleRoutes(deadline: number, extra: Route[] = []): Route[] {
  return [
    ...extra,
    { match: post('/bags/bag_1/redeem-intent'), body: { intent: intent({ status: 'DRAFT' }) } },
    { match: post('/execute'), status: 409, body: { error: 'fee', code: 'FEE_ROUTER_REQUIRED' } },
    { match: post('/settlement-quote'), body: { ok: true } },
    { match: post('/settlement-attest'), body: { composerTransaction: TX } },
    { match: get('/redeem-intent/intent_1'), body: { intent: intent({ composerTransaction: TX, settlementPlan: { deadline } as never }) } },
    { match: post('/step/0/report'), body: { intent: intent() } },
    { match: post('/verify'), body: { intent: intent({ status: 'COMPLETED' }) } },
  ];
}

describe('useRedeemExecution: declined fee-paying sale', () => {
  beforeEach(() => {
    sweep.mockReset();
    process.env.NEXT_PUBLIC_REDEEM_SETTLEMENT_ADDRESS = '0x' + '5'.repeat(40);
  });
  afterEach(() => {
    delete (process.env as Record<string, string | undefined>).NEXT_PUBLIC_REDEEM_SETTLEMENT_ADDRESS;
    vi.restoreAllMocks();
  });

  it('declining keeps the sale signable (no REJECTED report), and Sign again signs the same transaction', async () => {
    const { useRedeemExecution } = await import('../use-redeem-execution');
    api(feeSaleRoutes(future()));
    sweep.mockRejectedValueOnce(rejection());
    const { result } = renderHook(() => useRedeemExecution());
    await act(async () => {
      await result.current.start('bag_1', 5000, 'usdg', WALLET);
    });
    expect(result.current.state.phase).toBe('failed');
    expect(result.current.state.resumable).toMatchObject({ intentId: 'intent_1', composerTransaction: TX });
    expect(result.current.state.error).toMatch(/sign it again now/);
    expect(reports()).toEqual(['AWAITING_SIGNATURE']);
    expect(calls.some((c) => c.url.endsWith('/verify'))).toBe(false);

    sweep.mockImplementationOnce(async (_w: string, plan: { transaction: unknown }, _p: unknown, opts: { onSubmitted: (h: string) => Promise<void> }) => {
      expect(plan.transaction).toEqual(TX);
      await opts.onSubmitted(HASH);
      return HASH;
    });
    await act(async () => {
      await result.current.resume();
    });
    await waitFor(() => expect(result.current.state.phase).toBe('completed'));
    expect(reports()).toEqual(['AWAITING_SIGNATURE', 'AWAITING_SIGNATURE', 'SUBMITTED']);
    expect(calls.filter((c) => c.url.endsWith('/bags/bag_1/redeem-intent'))).toHaveLength(1); // no second sale was created
  });

  it('a retry blocked by that pending sale is offered the pending sale, not a wait', async () => {
    const { useRedeemExecution } = await import('../use-redeem-execution');
    api([
      { match: post('/bags/bag_1/redeem-intent'), status: 409, body: { error: 'A redemption is already in progress for this Bag.', intentId: 'intent_1' } },
      { match: get('/redeem-intent/intent_1'), body: { intent: intent({ composerTransaction: TX, settlementPlan: { deadline: future() } as never }) } },
    ]);
    const { result } = renderHook(() => useRedeemExecution());
    await act(async () => {
      await result.current.start('bag_1', 2500, 'usdg', WALLET);
    });
    expect(result.current.state.resumable).toMatchObject({ intentId: 'intent_1' });
    expect(result.current.state.error).toMatch(/still waiting for your signature/);
  });

  it('a pending sale too close to its deadline, already sent, or of another wallet is not offered', async () => {
    const { useRedeemExecution } = await import('../use-redeem-execution');
    for (const pending of [
      intent({ composerTransaction: TX, settlementPlan: { deadline: Math.floor(Date.now() / 1000) + 5 } as never }),
      intent({ composerTransaction: TX, settlementPlan: { deadline: future() } as never, steps: [{ ...swapStep, txHash: HASH }] as never }),
      intent({ composerTransaction: TX, settlementPlan: { deadline: future() } as never, walletAddress: '0x' + 'b'.repeat(40) }),
    ]) {
      api([
        { match: post('/bags/bag_1/redeem-intent'), status: 409, body: { error: 'A redemption is already in progress for this Bag.', intentId: 'intent_1' } },
        { match: get('/redeem-intent/intent_1'), body: { intent: pending } },
      ]);
      const { result } = renderHook(() => useRedeemExecution());
      await act(async () => {
        await result.current.start('bag_1', 2500, 'usdg', WALLET);
      });
      expect(result.current.state.resumable).toBeNull();
      expect(result.current.state.error).toBe('A redemption is already in progress for this Bag.');
    }
  });

  it('a free sale declined in the wallet is still final (REJECTED is reported)', async () => {
    const { useRedeemExecution } = await import('../use-redeem-execution');
    api([
      { match: post('/bags/bag_1/redeem-intent'), body: { intent: intent({ status: 'DRAFT' }) } },
      { match: post('/execute'), body: { intent: intent({ composerTransaction: TX }) } },
      { match: post('/step/0/report'), body: { intent: intent() } },
      { match: post('/verify'), body: { intent: intent({ status: 'FAILED' }) } },
    ]);
    sweep.mockRejectedValueOnce(rejection());
    const { result } = renderHook(() => useRedeemExecution());
    await act(async () => {
      await result.current.start('bag_1', 5000, 'usdg', WALLET);
    });
    expect(reports()).toEqual(['AWAITING_SIGNATURE', 'REJECTED']);
    expect(result.current.state.resumable).toBeNull();
  });

  it('an expired session says so instead of a raw 401', async () => {
    const { useRedeemExecution } = await import('../use-redeem-execution');
    api([{ match: post('/bags/bag_1/redeem-intent'), status: 401, body: { error: 'Unauthorized' } }]);
    const { result } = renderHook(() => useRedeemExecution());
    await act(async () => {
      await result.current.start('bag_1', 5000, 'usdg', WALLET);
    });
    expect(result.current.state).toMatchObject({ phase: 'failed', errorCode: 'SESSION_EXPIRED', error: 'Your session has expired. Sign in again to continue.' });
  });
});
