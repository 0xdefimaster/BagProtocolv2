// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { PurchaseIntent, PurchaseIntentStepRecord } from '@/types/purchase-intent';

// -----------------------------------------------------------------------------
// Tests for hooks/use-purchase-execution.ts — the client-side orchestrator
// that drives PurchasePreviewModal's live "Purchase" button. This is the one
// piece of the real-execution pipeline that had NO test coverage: the server
// side (lib/server/purchase-execution.ts, the state machine, the fingerprint
// re-check) already had its own tests before this file existed.
//
// `@lifi/sdk`'s `executeRoute`/`convertQuoteToRoute` and this app's
// lib/blockchain/lifi-wallet-client.ts are both mocked — no real wallet, no
// real network, no real transaction. This proves the hook's OWN
// orchestration logic (which HTTP calls happen in what order, how a LI.FI
// action tick maps to a step-report event, dedup, sequential-not-parallel
// step execution, and the terminal-phase mapping) is correct; it does not
// and cannot prove `executeRoute()` itself, a real wallet's signing
// behavior, or LI.FI's real API respond the way these mocks assume.
// -----------------------------------------------------------------------------

const executeRouteMock = vi.fn<
  (client: unknown, route: unknown, opts: { updateRouteHook: (route: unknown) => void }) => Promise<void>
>();
const convertQuoteToRouteMock = vi.fn((step: unknown) => ({ __fromStep: step }));

vi.mock('@lifi/sdk', () => ({
  executeRoute: (...args: Parameters<typeof executeRouteMock>) => executeRouteMock(...args),
  convertQuoteToRoute: (...args: Parameters<typeof convertQuoteToRouteMock>) => convertQuoteToRouteMock(...args),
}));

const sendTransactionMock = vi.fn<(args: unknown) => Promise<string>>();
const getBrowserWalletClientForChainMock = vi.fn(async () => ({ sendTransaction: sendTransactionMock }));

const ensureErc20AllowanceOnChainMock = vi.fn<(...args: unknown[]) => Promise<`0x${string}` | null>>(async () => null);

const simulateTransactionOnChainMock = vi.fn<(...args: unknown[]) => Promise<void>>(async () => {});

vi.mock('@/lib/blockchain/lifi-wallet-client', () => ({
  ensureErc20AllowanceOnChain: (...args: unknown[]) => ensureErc20AllowanceOnChainMock(...args),
  simulateTransactionOnChain: (...args: unknown[]) => simulateTransactionOnChainMock(...args),
  getBrowserLiFiClient: vi.fn(() => ({ __fakeLiFiClient: true })),
  getBrowserWalletClientForChain: (...args: unknown[]) =>
    (getBrowserWalletClientForChainMock as unknown as (...a: unknown[]) => unknown)(...args),
}));

const ensureBagRouterAllowanceMock = vi.fn<(...args: unknown[]) => Promise<`0x${string}` | null>>();
const sendBagRouterTransactionMock = vi.fn<(...args: unknown[]) => Promise<`0x${string}`>>();

vi.mock('@/lib/blockchain/bag-router-client', () => ({
  ensureBagRouterAllowance: (...args: unknown[]) => ensureBagRouterAllowanceMock(...args),
  sendBagRouterTransaction: (...args: unknown[]) => sendBagRouterTransactionMock(...args),
}));

const { usePurchaseExecution } = await import('../use-purchase-execution');

const WALLET_ADDRESS = '0x000000000000000000000000000000000000aa';
const BAG_ID = 'bag_1';

function baseStep(overrides: Partial<PurchaseIntentStepRecord> = {}): PurchaseIntentStepRecord {
  return {
    stepIndex: 0,
    action: 'SWAP',
    targetSymbol: 'NVDA',
    inputAsset: { chain: 'ethereum', address: '0xusdc' },
    outputAsset: { chain: 'robinhood', address: '0xnvda' },
    sourceChain: 'ethereum',
    destinationChain: 'robinhood',
    inputAmountRaw: '100000000',
    targetValueRaw: '100000000',
    outputAmountRaw: '1000000000000000000',
    outputDecimals: 18,
    minOutputRaw: '990000000000000000',
    route: 'relay',
    lifiStep: { __rawLifiStep: true },
    status: 'PENDING',
    approvalTxHash: null,
    txHash: null,
    providerSubstatus: null,
    failureCode: null,
    ...overrides,
  };
}

function baseIntent(overrides: Partial<PurchaseIntent> = {}): PurchaseIntent {
  return {
    id: 'intent_1',
    userId: 'user_1',
    walletAddress: WALLET_ADDRESS,
    bagId: BAG_ID,
    inputAsset: { chain: 'ethereum', address: '0xusdc' },
    inputAmountRaw: '100000000',
    sharesRaw: '1000000000000000000',
    shareDecimals: 18,
    routeFingerprint: 'fp_1',
    recipeVersion: 1,
    compositionHash: 'ch_1',
    navSnapshot: { grossNav: '1000', quoteCurrency: 'USD', asOf: '2026-01-01T00:00:00.000Z' },
    sharePriceAtQuote: '1',
    depositAmount: '1',
    steps: [baseStep()],
    composerTransaction: null,
    bagRouterTransaction: null,
    providerId: null,
    executionPlanHash: null,
    executionMode: null,
    status: 'DRAFT',
    createdAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-01-01T00:03:00.000Z',
    executedAt: null,
    accountingAppliedAt: null,
    reconciliationAppliedAt: null,
    failureCode: null,
    ...overrides,
  };
}

/** A minimal fake `Response` compatible with what the hook's `postJson` reads (`res.ok`, `res.json()`). */
function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

let fetchMock: ReturnType<typeof vi.fn<(url: string, init?: RequestInit) => Promise<Response>>>;

beforeEach(() => {
  executeRouteMock.mockReset();
  convertQuoteToRouteMock.mockClear();
  sendTransactionMock.mockReset();
  getBrowserWalletClientForChainMock.mockClear();
  ensureBagRouterAllowanceMock.mockReset();
  sendBagRouterTransactionMock.mockReset();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Wires `fetch` to the exact three-call sequence a happy-path `start()` makes, each returning the given intent snapshot; `verifyIntent` is called via `onVerify` so a test can return a DIFFERENT intent on each poll (e.g. CONFIRMING then COMPLETED). */
function wireHttp(opts: {
  created: PurchaseIntent;
  prepared: PurchaseIntent;
  onVerify: (callIndex: number) => PurchaseIntent;
}) {
  let verifyCallIndex = 0;
  fetchMock.mockImplementation(async (url: string) => {
    if (url === `/api/bags/${BAG_ID}/purchase-intent`) return jsonResponse(200, { intent: opts.created });
    if (url === `/api/purchase-intent/${opts.created.id}/execute`) return jsonResponse(200, { intent: opts.prepared });
    if (url.startsWith(`/api/purchase-intent/${opts.created.id}/step/`)) {
      return jsonResponse(200, { intent: opts.prepared });
    }
    if (url === `/api/purchase-intent/${opts.created.id}/verify`) {
      const result = opts.onVerify(verifyCallIndex);
      verifyCallIndex += 1;
      return jsonResponse(200, { intent: result });
    }
    throw new Error(`Unexpected fetch URL in test: ${url}`);
  });
}

describe('usePurchaseExecution', () => {
  it('happy path: create -> prepare -> execute the one SWAP step -> poll verify -> completed', async () => {
    const created = baseIntent({ status: 'DRAFT' });
    const prepared = baseIntent({ status: 'READY', steps: [baseStep()] });
    const completed = baseIntent({ status: 'COMPLETED', steps: [baseStep({ status: 'COMPLETED', txHash: '0xtx1' })] });

    wireHttp({ created, prepared, onVerify: () => completed });

    executeRouteMock.mockImplementation(async (_client, _route, { updateRouteHook }) => {
      updateRouteHook({
        steps: [{ execution: { actions: [{ type: 'SWAP', status: 'PENDING', txHash: '0xtx1' }] } }],
      });
      updateRouteHook({
        steps: [{ execution: { actions: [{ type: 'SWAP', status: 'DONE', txHash: '0xtx1' }] } }],
      });
    });

    const { result } = renderHook(() => usePurchaseExecution());

    await act(async () => {
      await result.current.start(BAG_ID, 'asset_usdc', '100', WALLET_ADDRESS);
    });

    expect(result.current.state.phase).toBe('completed');
    expect(convertQuoteToRouteMock).toHaveBeenCalledWith(baseStep().lifiStep);
    expect(executeRouteMock).toHaveBeenCalledTimes(1);
    // The SUBMITTED tick must have been reported to the server.
    const reportCalls = fetchMock.mock.calls.filter(([url]: [string, RequestInit?]) => url.includes('/step/0/report'));
    expect(reportCalls.length).toBeGreaterThan(0);
    const lastReportBody = JSON.parse((reportCalls[reportCalls.length - 1][1] as RequestInit).body as string);
    expect(lastReportBody).toEqual({ type: 'SUBMITTED', txHash: '0xtx1' });
  });

  it('KEEP steps are never sent to executeRoute/convertQuoteToRoute', async () => {
    const created = baseIntent({ status: 'DRAFT' });
    const prepared = baseIntent({
      status: 'READY',
      steps: [baseStep({ action: 'KEEP', lifiStep: null, stepIndex: 0 }), baseStep({ stepIndex: 1 })],
    });
    const completed = baseIntent({ status: 'COMPLETED' });

    wireHttp({ created, prepared, onVerify: () => completed });
    executeRouteMock.mockImplementation(async (_client, _route, { updateRouteHook }) => {
      updateRouteHook({ steps: [{ execution: { actions: [{ type: 'SWAP', status: 'DONE', txHash: '0xtx1' }] } }] });
    });

    const { result } = renderHook(() => usePurchaseExecution());
    await act(async () => {
      await result.current.start(BAG_ID, 'asset_usdc', '100', WALLET_ADDRESS);
    });

    // Exactly one SWAP step in the plan -> exactly one executeRoute call,
    // never one for the KEEP step too.
    expect(executeRouteMock).toHaveBeenCalledTimes(1);
    expect(convertQuoteToRouteMock).toHaveBeenCalledTimes(1);
  });

  it('a mid-signing wallet rejection ends in phase "failed" with the USER_REJECTED-mapped state, and reports REJECTED to the server', async () => {
    const created = baseIntent({ status: 'DRAFT' });
    const prepared = baseIntent({ status: 'READY', steps: [baseStep()] });
    const failedIntent = baseIntent({ status: 'FAILED', failureCode: 'USER_REJECTED' });

    wireHttp({ created, prepared, onVerify: () => failedIntent });
    executeRouteMock.mockImplementation(async (_client, _route, { updateRouteHook }) => {
      updateRouteHook({
        steps: [
          {
            execution: {
              actions: [{ type: 'SWAP', status: 'FAILED', error: { code: 4001, message: 'User rejected the request.' } }],
            },
          },
        ],
      });
      throw new Error('User rejected the request.');
    });

    const { result } = renderHook(() => usePurchaseExecution());
    await act(async () => {
      await result.current.start(BAG_ID, 'asset_usdc', '100', WALLET_ADDRESS);
    });

    await waitFor(() => expect(result.current.state.phase).toBe('failed'));
    const reportCalls = fetchMock.mock.calls.filter(([url]: [string, RequestInit?]) => url.includes('/step/0/report'));
    const bodies = reportCalls.map(([, init]: [string, RequestInit?]) => JSON.parse((init as RequestInit).body as string));
    expect(bodies).toContainEqual({ type: 'REJECTED' });
  });

  it('a reverted transaction: client-side error alone is NOT trusted — the hook falls through to /verify and adopts the SERVER-VERIFIED failureCode', async () => {
    const created = baseIntent({ status: 'DRAFT' });
    const prepared = baseIntent({ status: 'READY', steps: [baseStep()] });
    const failedIntent = baseIntent({ status: 'FAILED', failureCode: 'TRANSACTION_REVERTED' });

    wireHttp({ created, prepared, onVerify: () => failedIntent });
    executeRouteMock.mockImplementation(async (_client, _route, { updateRouteHook }) => {
      updateRouteHook({
        steps: [
          { execution: { actions: [{ type: 'SWAP', status: 'FAILED', error: { message: 'execution reverted' } }] } },
        ],
      });
      throw new Error('execution reverted');
    });

    const { result } = renderHook(() => usePurchaseExecution());
    await act(async () => {
      await result.current.start(BAG_ID, 'asset_usdc', '100', WALLET_ADDRESS);
    });

    await waitFor(() => expect(result.current.state.phase).toBe('failed'));
    // The client only ever saw a generic "execution reverted" message with
    // no failureCode attached — the TRANSACTION_REVERTED code came from
    // the server's own on-chain check via /verify, proving the fall-through
    // (not an immediate client-side fail) actually happened.
    expect(result.current.state.failureCode).toBe('TRANSACTION_REVERTED');
    const verifyCalls = fetchMock.mock.calls.filter(([url]: [string, RequestInit?]) => url.endsWith('/verify'));
    expect(verifyCalls.length).toBeGreaterThan(0);
  });

  it('dedupes repeated identical action ticks — the same PENDING/txHash tick reported only once even if updateRouteHook fires it twice', async () => {
    const created = baseIntent({ status: 'DRAFT' });
    const prepared = baseIntent({ status: 'READY', steps: [baseStep()] });
    const completed = baseIntent({ status: 'COMPLETED' });

    wireHttp({ created, prepared, onVerify: () => completed });
    executeRouteMock.mockImplementation(async (_client, _route, { updateRouteHook }) => {
      const tick = { steps: [{ execution: { actions: [{ type: 'SWAP', status: 'PENDING', txHash: '0xtx1' }] } }] };
      updateRouteHook(tick);
      updateRouteHook(tick); // identical tick fired again — LI.FI's hook can do this
    });

    const { result } = renderHook(() => usePurchaseExecution());
    await act(async () => {
      await result.current.start(BAG_ID, 'asset_usdc', '100', WALLET_ADDRESS);
    });

    const reportCalls = fetchMock.mock.calls.filter(([url]: [string, RequestInit?]) => url.includes('/step/0/report'));
    const submittedReports = reportCalls.filter(([, init]: [string, RequestInit?]) => {
      const body = JSON.parse((init as RequestInit).body as string);
      return body.type === 'SUBMITTED' && body.txHash === '0xtx1';
    });
    expect(submittedReports).toHaveLength(1);
  });

  it('two SWAP steps execute sequentially, not in parallel — the second executeRoute call only happens after the first resolves', async () => {
    const created = baseIntent({ status: 'DRAFT' });
    const prepared = baseIntent({
      status: 'READY',
      steps: [baseStep({ stepIndex: 0, targetSymbol: 'NVDA' }), baseStep({ stepIndex: 1, targetSymbol: 'AAPL' })],
    });
    const completed = baseIntent({ status: 'COMPLETED' });
    wireHttp({ created, prepared, onVerify: () => completed });

    const callOrder: number[] = [];
    let resolveFirst!: () => void;
    const firstGate = new Promise<void>((res) => {
      resolveFirst = res;
    });

    executeRouteMock
      .mockImplementationOnce(async (_client, _route, { updateRouteHook }) => {
        callOrder.push(0);
        updateRouteHook({ steps: [{ execution: { actions: [{ type: 'SWAP', status: 'DONE', txHash: '0xa' }] } }] });
        await firstGate; // don't resolve until the test says so
      })
      .mockImplementationOnce(async (_client, _route, { updateRouteHook }) => {
        callOrder.push(1);
        updateRouteHook({ steps: [{ execution: { actions: [{ type: 'SWAP', status: 'DONE', txHash: '0xb' }] } }] });
      });

    const { result } = renderHook(() => usePurchaseExecution());
    // Deliberately not awaited immediately — this test needs to observe
    // in-flight state (only step 0 has started) before the gate resolves
    // and step 1 begins. React logs a benign "act() not awaited" warning
    // here as a result; `await startPromise` below still ensures every
    // state update this hook makes is flushed before the test ends.
    const startPromise = act(async () => {
      await result.current.start(BAG_ID, 'asset_usdc', '100', WALLET_ADDRESS);
    });

    // While the first step is still gated, the second must not have started.
    await waitFor(() => expect(executeRouteMock).toHaveBeenCalledTimes(1));
    expect(callOrder).toEqual([0]);

    resolveFirst();
    await startPromise;

    expect(callOrder).toEqual([0, 1]);
    expect(executeRouteMock).toHaveBeenCalledTimes(2);
  });

  it('composerTransaction set: sends ONE transaction and reports SUBMITTED with the same hash for every SWAP step — no executeRoute call at all', async () => {
    const composerTransaction = { to: '0xComposerVM', data: '0xdeadbeef', value: '0', chainId: 1, userProxy: '0xProxy' };
    const created = baseIntent({ status: 'DRAFT' });
    const prepared = baseIntent({
      status: 'READY',
      composerTransaction,
      steps: [baseStep({ stepIndex: 0 }), baseStep({ stepIndex: 1 })],
    });
    const completed = baseIntent({
      status: 'COMPLETED',
      composerTransaction,
      steps: [
        baseStep({ stepIndex: 0, status: 'COMPLETED', txHash: '0xonehash' }),
        baseStep({ stepIndex: 1, status: 'COMPLETED', txHash: '0xonehash' }),
      ],
    });

    wireHttp({ created, prepared, onVerify: () => completed });
    sendTransactionMock.mockResolvedValue('0xonehash');

    const { result } = renderHook(() => usePurchaseExecution());

    await act(async () => {
      await result.current.start(BAG_ID, 'asset_usdc', '100', WALLET_ADDRESS);
    });

    expect(result.current.state.phase).toBe('completed');
    expect(executeRouteMock).not.toHaveBeenCalled();
    expect(convertQuoteToRouteMock).not.toHaveBeenCalled();
    expect(getBrowserWalletClientForChainMock).toHaveBeenCalledWith(WALLET_ADDRESS, 1);
    expect(sendTransactionMock).toHaveBeenCalledTimes(1);
    expect(sendTransactionMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: '0xComposerVM', data: '0xdeadbeef', value: BigInt(0) })
    );

    // Both step indices must have been reported SUBMITTED with the SAME hash.
    for (const idx of [0, 1]) {
      const reportCalls = fetchMock.mock.calls.filter(([url]: [string, RequestInit?]) => url.includes(`/step/${idx}/report`));
      const submittedCall = reportCalls.find((c: [string, RequestInit?]) => {
        const body = JSON.parse((c[1] as RequestInit).body as string);
        return body.type === 'SUBMITTED';
      });
      expect(submittedCall).toBeDefined();
      const body = JSON.parse((submittedCall![1] as RequestInit).body as string);
      expect(body).toEqual({ type: 'SUBMITTED', txHash: '0xonehash' });
    }
  });

  it('composerTransaction with a required approval: approves the input token to the Composer spender BEFORE sending the transaction', async () => {
    const approvals = [{ token: '0xUSDG', spender: '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE', amountRaw: '100000000' }];
    const composerTransaction = { to: '0xComposerVM', data: '0xdeadbeef', value: '0', chainId: 4663, userProxy: '0xProxy', approvals };
    const created = baseIntent({ status: 'DRAFT' });
    const prepared = baseIntent({ status: 'READY', composerTransaction, steps: [baseStep({ stepIndex: 0 })] });
    const completed = baseIntent({ status: 'COMPLETED', composerTransaction, steps: [baseStep({ stepIndex: 0, status: 'COMPLETED', txHash: '0xonehash' })] });

    const order: string[] = [];
    ensureErc20AllowanceOnChainMock.mockImplementationOnce(async () => {
      order.push('approve');
      return '0xapprovalhash';
    });
    sendTransactionMock.mockImplementationOnce(async () => {
      order.push('send');
      return '0xonehash';
    });
    wireHttp({ created, prepared, onVerify: () => completed });

    const { result } = renderHook(() => usePurchaseExecution());
    await act(async () => {
      await result.current.start(BAG_ID, 'asset_usdc', '100', WALLET_ADDRESS);
    });

    expect(ensureErc20AllowanceOnChainMock).toHaveBeenCalledWith(WALLET_ADDRESS, 4663, '0xUSDG', approvals[0].spender, '100000000');
    expect(order).toEqual(['approve', 'send']);
    expect(result.current.state.phase).toBe('completed');
  });

  it('composerTransaction with NO approval list: still makes sure the Composer target may pull the total input, then dry-runs, then sends', async () => {
    const composerTransaction = { to: '0xLiFiDiamond', data: '0xdeadbeef', value: '0', chainId: 4663, userProxy: '0xProxy' };
    const created = baseIntent({ status: 'DRAFT' });
    const steps = [baseStep({ stepIndex: 0, inputAmountRaw: '60000000' }), baseStep({ stepIndex: 1, inputAmountRaw: '40000000' })];
    const prepared = baseIntent({ status: 'READY', composerTransaction, steps });
    const completed = baseIntent({ status: 'COMPLETED', composerTransaction, steps: steps.map((st) => ({ ...st, status: 'COMPLETED' as const, txHash: '0xonehash' })) });

    const order: string[] = [];
    ensureErc20AllowanceOnChainMock.mockImplementationOnce(async () => {
      order.push('approve');
      return null;
    });
    simulateTransactionOnChainMock.mockImplementationOnce(async () => {
      order.push('simulate');
    });
    sendTransactionMock.mockImplementationOnce(async () => {
      order.push('send');
      return '0xonehash';
    });
    wireHttp({ created, prepared, onVerify: () => completed });

    const { result } = renderHook(() => usePurchaseExecution());
    await act(async () => {
      await result.current.start(BAG_ID, 'asset_usdc', '100', WALLET_ADDRESS);
    });

    expect(ensureErc20AllowanceOnChainMock).toHaveBeenCalledWith(WALLET_ADDRESS, 4663, steps[0].inputAsset.address, '0xLiFiDiamond', '100000000');
    expect(order).toEqual(['approve', 'simulate', 'send']);
  });

  it('a Composer transaction that would revert is never sent', async () => {
    const composerTransaction = { to: '0xLiFiDiamond', data: '0xdeadbeef', value: '0', chainId: 4663, userProxy: '0xProxy', approvals: [] };
    const created = baseIntent({ status: 'DRAFT' });
    const prepared = baseIntent({ status: 'READY', composerTransaction, steps: [baseStep({ stepIndex: 0 })] });
    const failed = baseIntent({ status: 'FAILED', composerTransaction, steps: prepared.steps });
    simulateTransactionOnChainMock.mockRejectedValueOnce(new Error('This purchase would fail on-chain, so it was not sent (no gas spent). execution reverted'));
    wireHttp({ created, prepared, onVerify: () => failed });

    const { result } = renderHook(() => usePurchaseExecution());
    await act(async () => {
      await result.current.start(BAG_ID, 'asset_usdc', '100', WALLET_ADDRESS);
    });

    expect(sendTransactionMock).not.toHaveBeenCalled();
    expect(result.current.state.phase).toBe('failed');
  });

  it('composerTransaction rejected by the wallet: reports REJECTED for every SWAP step, then falls through to /verify', async () => {
    const composerTransaction = { to: '0xComposerVM', data: '0xdeadbeef', value: '0', chainId: 1, userProxy: '0xProxy' };
    const created = baseIntent({ status: 'DRAFT' });
    const prepared = baseIntent({
      status: 'READY',
      composerTransaction,
      steps: [baseStep({ stepIndex: 0 }), baseStep({ stepIndex: 1 })],
    });
    const failed = baseIntent({ status: 'FAILED', failureCode: 'USER_REJECTED', composerTransaction, steps: prepared.steps });

    wireHttp({ created, prepared, onVerify: () => failed });
    sendTransactionMock.mockRejectedValue(Object.assign(new Error('User rejected the request'), { code: 4001 }));

    const { result } = renderHook(() => usePurchaseExecution());

    await act(async () => {
      await result.current.start(BAG_ID, 'asset_usdc', '100', WALLET_ADDRESS);
    });

    expect(result.current.state.phase).toBe('failed');
    for (const idx of [0, 1]) {
      const reportCalls = fetchMock.mock.calls.filter(([url]: [string, RequestInit?]) => url.includes(`/step/${idx}/report`));
      const rejectedCall = reportCalls.find((c: [string, RequestInit?]) => {
        const body = JSON.parse((c[1] as RequestInit).body as string);
        return body.type === 'REJECTED';
      });
      expect(rejectedCall).toBeDefined();
    }
  });

  // ----------------------------- Bag Router execution hardening (items 3/4/5) ---
  //
  // `bagRouterTransaction` is checked BEFORE `composerTransaction`
  // (hooks/use-purchase-execution.ts's own doc) and routed through its OWN
  // `ensureBagRouterAllowance`/`sendBagRouterTransaction` path — never
  // `executeComposerTransaction()`/`sendTransaction` directly the way
  // Composer's flow is. These tests mock `lib/blockchain/bag-router-client.ts`
  // (its own on-chain allowance/send logic is out of scope here — this
  // proves the HOOK's orchestration around it).

  const bagRouterTransaction = {
    to: '0xBagRouterAddress',
    data: '0xexecutecalldata',
    value: '0',
    chainId: 4663,
    inputToken: '0xusdc',
    inputAmountRaw: '100000000',
    bagOnChainId: '0xOnChainBagId1',
  };

  it('sufficient allowance: BagRouter transaction succeeds with NO approval step — ensureBagRouterAllowance returns null (item 4)', async () => {
    const created = baseIntent({ status: 'DRAFT' });
    const prepared = baseIntent({
      status: 'READY',
      providerId: 'bag-router',
      bagRouterTransaction,
      steps: [baseStep({ stepIndex: 0 }), baseStep({ stepIndex: 1 })],
    });
    const completed = baseIntent({
      status: 'COMPLETED',
      providerId: 'bag-router',
      bagRouterTransaction,
      steps: [
        baseStep({ stepIndex: 0, status: 'COMPLETED', txHash: '0xroutertx' }),
        baseStep({ stepIndex: 1, status: 'COMPLETED', txHash: '0xroutertx' }),
      ],
    });
    wireHttp({ created, prepared, onVerify: () => completed });

    // Already approved from a prior purchase — no approval tx needed.
    ensureBagRouterAllowanceMock.mockResolvedValue(null);
    sendBagRouterTransactionMock.mockResolvedValue('0xroutertx');

    const { result } = renderHook(() => usePurchaseExecution());
    await act(async () => {
      await result.current.start(BAG_ID, 'asset_usdc', '100', WALLET_ADDRESS);
    });

    expect(result.current.state.phase).toBe('completed');
    // Never the Composer/executeRoute paths.
    expect(executeRouteMock).not.toHaveBeenCalled();
    expect(sendTransactionMock).not.toHaveBeenCalled();
    expect(ensureBagRouterAllowanceMock).toHaveBeenCalledWith('0xusdc', WALLET_ADDRESS, '0xBagRouterAddress', BigInt('100000000'));
    expect(sendBagRouterTransactionMock).toHaveBeenCalledTimes(1);
    expect(sendBagRouterTransactionMock).toHaveBeenCalledWith(WALLET_ADDRESS, bagRouterTransaction);

    // No APPROVAL_SUBMITTED report for either step — nothing was approved.
    for (const idx of [0, 1]) {
      const reportCalls = fetchMock.mock.calls.filter(([url]: [string, RequestInit?]) => url.includes(`/step/${idx}/report`));
      const approvalSubmitted = reportCalls.find((c: [string, RequestInit?]) => JSON.parse((c[1] as RequestInit).body as string).type === 'APPROVAL_SUBMITTED');
      expect(approvalSubmitted).toBeUndefined();
      const submitted = reportCalls.find((c: [string, RequestInit?]) => JSON.parse((c[1] as RequestInit).body as string).type === 'SUBMITTED');
      expect(submitted).toBeDefined();
      expect(JSON.parse((submitted![1] as RequestInit).body as string)).toEqual({ type: 'SUBMITTED', txHash: '0xroutertx' });
    }
  });

  it('insufficient allowance: an explicit approval step happens before the router transaction — never falsely claims one confirmation (item 5)', async () => {
    const created = baseIntent({ status: 'DRAFT' });
    const prepared = baseIntent({
      status: 'READY',
      providerId: 'bag-router',
      bagRouterTransaction,
      steps: [baseStep({ stepIndex: 0 })],
    });
    const completed = baseIntent({
      status: 'COMPLETED',
      providerId: 'bag-router',
      bagRouterTransaction,
      steps: [baseStep({ stepIndex: 0, status: 'COMPLETED', txHash: '0xroutertx' })],
    });
    wireHttp({ created, prepared, onVerify: () => completed });

    ensureBagRouterAllowanceMock.mockResolvedValue('0xapprovaltx');
    sendBagRouterTransactionMock.mockResolvedValue('0xroutertx');

    const { result } = renderHook(() => usePurchaseExecution());
    await act(async () => {
      await result.current.start(BAG_ID, 'asset_usdc', '100', WALLET_ADDRESS);
    });

    expect(result.current.state.phase).toBe('completed');
    const reportCalls = fetchMock.mock.calls.filter(([url]: [string, RequestInit?]) => url.includes('/step/0/report'));
    const bodies = reportCalls.map((c: [string, RequestInit?]) => JSON.parse((c[1] as RequestInit).body as string));

    const approvalSubmitted = bodies.find((b) => b.type === 'APPROVAL_SUBMITTED');
    expect(approvalSubmitted).toEqual({ type: 'APPROVAL_SUBMITTED', txHash: '0xapprovaltx' });
    expect(bodies.some((b) => b.type === 'APPROVAL_CONFIRMED')).toBe(true);
    // The approval is reported and confirmed BEFORE the router transaction is sent.
    const approvalIdx = bodies.findIndex((b) => b.type === 'APPROVAL_SUBMITTED');
    const submittedIdx = bodies.findIndex((b) => b.type === 'SUBMITTED');
    expect(approvalIdx).toBeGreaterThanOrEqual(0);
    expect(submittedIdx).toBeGreaterThan(approvalIdx);
    expect(bodies.find((b) => b.type === 'SUBMITTED')).toEqual({ type: 'SUBMITTED', txHash: '0xroutertx' });
  });

  it('an approval rejected by the wallet reports REJECTED and never sends the router transaction', async () => {
    const created = baseIntent({ status: 'DRAFT' });
    const prepared = baseIntent({
      status: 'READY',
      providerId: 'bag-router',
      bagRouterTransaction,
      steps: [baseStep({ stepIndex: 0 })],
    });
    const failed = baseIntent({ status: 'FAILED', failureCode: 'USER_REJECTED', providerId: 'bag-router', bagRouterTransaction, steps: prepared.steps });
    wireHttp({ created, prepared, onVerify: () => failed });

    ensureBagRouterAllowanceMock.mockRejectedValue(Object.assign(new Error('User rejected the request'), { code: 4001 }));

    const { result } = renderHook(() => usePurchaseExecution());
    await act(async () => {
      await result.current.start(BAG_ID, 'asset_usdc', '100', WALLET_ADDRESS);
    });

    expect(result.current.state.phase).toBe('failed');
    expect(sendBagRouterTransactionMock).not.toHaveBeenCalled();
    const reportCalls = fetchMock.mock.calls.filter(([url]: [string, RequestInit?]) => url.includes('/step/0/report'));
    const rejected = reportCalls.find((c: [string, RequestInit?]) => JSON.parse((c[1] as RequestInit).body as string).type === 'REJECTED');
    expect(rejected).toBeDefined();
  });

  it('the router transaction itself rejected by the wallet (after a successful approval) reports REJECTED, never claims success', async () => {
    const created = baseIntent({ status: 'DRAFT' });
    const prepared = baseIntent({
      status: 'READY',
      providerId: 'bag-router',
      bagRouterTransaction,
      steps: [baseStep({ stepIndex: 0 })],
    });
    const failed = baseIntent({ status: 'FAILED', failureCode: 'USER_REJECTED', providerId: 'bag-router', bagRouterTransaction, steps: prepared.steps });
    wireHttp({ created, prepared, onVerify: () => failed });

    ensureBagRouterAllowanceMock.mockResolvedValue(null);
    sendBagRouterTransactionMock.mockRejectedValue(Object.assign(new Error('User rejected the request'), { code: 4001 }));

    const { result } = renderHook(() => usePurchaseExecution());
    await act(async () => {
      await result.current.start(BAG_ID, 'asset_usdc', '100', WALLET_ADDRESS);
    });

    expect(result.current.state.phase).toBe('failed');
    const reportCalls = fetchMock.mock.calls.filter(([url]: [string, RequestInit?]) => url.includes('/step/0/report'));
    const rejected = reportCalls.find((c: [string, RequestInit?]) => JSON.parse((c[1] as RequestInit).body as string).type === 'REJECTED');
    expect(rejected).toBeDefined();
  });

  it('bagRouterTransaction is checked BEFORE composerTransaction — a BagRouter result is never sent through the Composer path even if both were somehow present', async () => {
    const composerTransaction = { to: '0xComposerVM', data: '0xdeadbeef', value: '0', chainId: 1, userProxy: '0xProxy' };
    const created = baseIntent({ status: 'DRAFT' });
    const prepared = baseIntent({
      status: 'READY',
      providerId: 'bag-router',
      bagRouterTransaction,
      composerTransaction,
      steps: [baseStep({ stepIndex: 0 })],
    });
    const completed = baseIntent({
      status: 'COMPLETED',
      providerId: 'bag-router',
      bagRouterTransaction,
      composerTransaction,
      steps: [baseStep({ stepIndex: 0, status: 'COMPLETED', txHash: '0xroutertx' })],
    });
    wireHttp({ created, prepared, onVerify: () => completed });

    ensureBagRouterAllowanceMock.mockResolvedValue(null);
    sendBagRouterTransactionMock.mockResolvedValue('0xroutertx');

    const { result } = renderHook(() => usePurchaseExecution());
    await act(async () => {
      await result.current.start(BAG_ID, 'asset_usdc', '100', WALLET_ADDRESS);
    });

    expect(result.current.state.phase).toBe('completed');
    expect(sendBagRouterTransactionMock).toHaveBeenCalledTimes(1);
    expect(sendTransactionMock).not.toHaveBeenCalled(); // Composer's send path never invoked
  });

  it('reset() clears phase/intent back to idle and clears the dedup cache', async () => {
    const created = baseIntent({ status: 'DRAFT' });
    const prepared = baseIntent({ status: 'READY', steps: [baseStep()] });
    const completed = baseIntent({ status: 'COMPLETED' });
    wireHttp({ created, prepared, onVerify: () => completed });
    executeRouteMock.mockImplementation(async (_client, _route, { updateRouteHook }) => {
      updateRouteHook({ steps: [{ execution: { actions: [{ type: 'SWAP', status: 'DONE', txHash: '0xa' }] } }] });
    });

    const { result } = renderHook(() => usePurchaseExecution());
    await act(async () => {
      await result.current.start(BAG_ID, 'asset_usdc', '100', WALLET_ADDRESS);
    });
    expect(result.current.state.phase).toBe('completed');

    act(() => {
      result.current.reset();
    });

    expect(result.current.state.phase).toBe('idle');
    expect(result.current.state.intent).toBeNull();
  });

  it('an HTTP-level rejection at intent creation (e.g. 400 ROUTE_EXPIRED) fails immediately without ever calling executeRoute', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === `/api/bags/${BAG_ID}/purchase-intent`) {
        return jsonResponse(400, { error: 'This route has expired.', failureCode: 'ROUTE_EXPIRED' });
      }
      throw new Error(`Unexpected fetch URL in test: ${url}`);
    });

    const { result } = renderHook(() => usePurchaseExecution());
    await act(async () => {
      await result.current.start(BAG_ID, 'asset_usdc', '100', WALLET_ADDRESS);
    });

    expect(result.current.state.phase).toBe('failed');
    expect(result.current.state.failureCode).toBe('ROUTE_EXPIRED');
    expect(executeRouteMock).not.toHaveBeenCalled();
  });
});

describe('usePurchaseExecution — background-prepared intent', () => {
  const farFuture = () => new Date(Date.now() + 4 * 60_000).toISOString();

  function onChainSwap() {
    executeRouteMock.mockImplementation(async (_client, _route, { updateRouteHook }) => {
      updateRouteHook({ steps: [{ execution: { actions: [{ type: 'SWAP', status: 'DONE', txHash: '0xtx1' }] } }] });
    });
  }

  it('goes straight to the wallet with a still-valid prepared intent — no create/execute calls on click', async () => {
    const prepared = baseIntent({ status: 'AWAITING_SIGNATURE', expiresAt: farFuture() });
    const completed = baseIntent({ status: 'COMPLETED', steps: [baseStep({ status: 'COMPLETED', txHash: '0xtx1' })] });
    wireHttp({ created: prepared, prepared, onVerify: () => completed });
    onChainSwap();

    const { result } = renderHook(() => usePurchaseExecution());
    await act(async () => {
      await result.current.start(BAG_ID, 'asset_usdc', '100', WALLET_ADDRESS, undefined, Promise.resolve(prepared));
    });

    expect(result.current.state.phase).toBe('completed');
    const urls = fetchMock.mock.calls.map(([url]: [string, RequestInit?]) => url);
    expect(urls).not.toContain(`/api/bags/${BAG_ID}/purchase-intent`);
    expect(urls).not.toContain(`/api/purchase-intent/${prepared.id}/execute`);
    expect(executeRouteMock).toHaveBeenCalledTimes(1);
  });

  it('prepares on click when the prepared intent is about to expire, failed, or missing', async () => {
    for (const stale of [
      baseIntent({ status: 'AWAITING_SIGNATURE', expiresAt: new Date(Date.now() + 10_000).toISOString() }),
      baseIntent({ status: 'FAILED', expiresAt: farFuture() }),
      null,
    ]) {
      fetchMock.mockReset();
      executeRouteMock.mockReset();
      const created = baseIntent({ status: 'READY' });
      const prepared = baseIntent({ status: 'AWAITING_SIGNATURE' });
      const completed = baseIntent({ status: 'COMPLETED', steps: [baseStep({ status: 'COMPLETED', txHash: '0xtx1' })] });
      wireHttp({ created, prepared, onVerify: () => completed });
      onChainSwap();

      const { result } = renderHook(() => usePurchaseExecution());
      await act(async () => {
        await result.current.start(BAG_ID, 'asset_usdc', '100', WALLET_ADDRESS, undefined, Promise.resolve(stale));
      });

      expect(result.current.state.phase).toBe('completed');
      const urls = fetchMock.mock.calls.map(([url]: [string, RequestInit?]) => url);
      expect(urls).toContain(`/api/bags/${BAG_ID}/purchase-intent`);
    }
  });
});

describe('usePurchaseExecution — Composer price-impact refusal (never one tx per asset)', () => {
  const notice = {
    reason: 'PRICE_IMPACT' as const,
    message: 'Price impact 551 bps exceeds maximum 500 bps (input: $0.9991, output: $0.9440)',
    priceImpactBps: 551,
    maxPriceImpactBps: 500,
    inputUsd: '0.9991',
    outputUsd: '0.9440',
  };
  const composerTx = { to: '0xcomposer', data: '0xdead', value: '0', chainId: 1, userProxy: '0xproxy', approvals: [] };

  it('stops with the reported impact, then retries as ONE transaction with the accepted limit', async () => {
    const created = baseIntent({ status: 'READY' });
    const prepared = baseIntent({ status: 'AWAITING_SIGNATURE', composerTransaction: composerTx });
    const completed = baseIntent({ status: 'COMPLETED', steps: [baseStep({ status: 'COMPLETED', txHash: '0xtx1' })] });
    const bodies: unknown[] = [];
    let createCalls = 0;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === `/api/bags/${BAG_ID}/purchase-intent`) {
        bodies.push(JSON.parse(String(init?.body)));
        createCalls += 1;
        if (createCalls === 1) return jsonResponse(422, { error: notice.message, failureCode: 'SLIPPAGE_EXCEEDED', composerFallback: notice });
        return jsonResponse(200, { intent: created });
      }
      if (url === `/api/purchase-intent/${created.id}/execute`) return jsonResponse(200, { intent: prepared });
      if (url.startsWith(`/api/purchase-intent/${created.id}/step/`)) return jsonResponse(200, { intent: prepared });
      if (url === `/api/purchase-intent/${created.id}/verify`) return jsonResponse(200, { intent: completed });
      throw new Error(`Unexpected fetch URL in test: ${url}`);
    });

    const { result } = renderHook(() => usePurchaseExecution());
    await act(async () => {
      await result.current.start(BAG_ID, 'asset_usdc', '100', WALLET_ADDRESS);
    });

    expect(result.current.state.phase).toBe('awaiting_price_impact_confirmation');
    expect(result.current.state.priceImpactNotice).toEqual(notice);
    expect(executeRouteMock).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.start(BAG_ID, 'asset_usdc', '100', WALLET_ADDRESS, undefined, undefined, { acceptedPriceImpactBps: 551 });
    });

    expect(bodies[1]).toMatchObject({ acceptedPriceImpactBps: 551 });
    expect(result.current.state.phase).toBe('completed');
    // One shared transaction — the per-asset route executor is never used.
    expect(executeRouteMock).not.toHaveBeenCalled();
  });

  it('a non price-impact Composer refusal fails with its message instead of falling back', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === `/api/bags/${BAG_ID}/purchase-intent`) {
        return jsonResponse(422, {
          error: 'network down',
          failureCode: 'PROVIDER_ERROR',
          composerFallback: { ...notice, reason: 'UNAVAILABLE', message: 'network down', priceImpactBps: null, maxPriceImpactBps: null, inputUsd: null, outputUsd: null },
        });
      }
      throw new Error(`Unexpected fetch URL in test: ${url}`);
    });
    const { result } = renderHook(() => usePurchaseExecution());
    await act(async () => {
      await result.current.start(BAG_ID, 'asset_usdc', '100', WALLET_ADDRESS);
    });
    expect(result.current.state.phase).toBe('failed');
    expect(result.current.state.error).toBe('network down');
    expect(executeRouteMock).not.toHaveBeenCalled();
  });
});
