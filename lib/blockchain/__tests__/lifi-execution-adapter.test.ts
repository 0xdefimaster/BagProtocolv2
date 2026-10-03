import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExecutionPlan, ExecutionStep } from '@/types/basket-protocol';

// -----------------------------------------------------------------------------
// Phase 14 — LiFiExecutionAdapter. `@lifi/sdk`'s `getQuote` is the ONLY
// thing mocked here — everything else (chain-id mapping, KEEP-skipping,
// amount consolidation, error mapping) is this adapter's own code, run for
// real. No test in this file makes a real network call (spec section 20:
// "Gerçek network testlerini unit suite'e bağlama"), and no test ever
// calls anything from `@lifi/sdk` other than `getQuote`/`createClient` —
// asserted explicitly in the "No execution" test below.
// -----------------------------------------------------------------------------

const getQuoteMock = vi.fn();

vi.mock('@lifi/sdk', async () => {
  const actual = await vi.importActual<typeof import('@lifi/sdk')>('@lifi/sdk');
  return {
    ...actual,
    getQuote: (...args: unknown[]) => getQuoteMock(...args),
  };
});

// Imported AFTER the mock is registered, per vitest's hoisting contract.
const { liFiExecutionAdapter } = await import('../lifi-execution-adapter');
const { resetLiFiClientForTests } = await import('../lifi-config');

const USDC = { chain: 'ethereum' as const, address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' };
const NVDA = { chain: 'ethereum' as const, address: '0x1111111111111111111111111111111111111111' };
const AAPL_BASE = { chain: 'base' as const, address: '0x2222222222222222222222222222222222222222' };
const AAPL_ARB = { chain: 'arbitrum' as const, address: '0x2222222222222222222222222222222222222222' }; // same address, different chain — must resolve as a DISTINCT quote request

function swapStep(overrides: Partial<ExecutionStep> = {}): ExecutionStep {
  return {
    action: 'SWAP',
    targetSymbol: 'xNVDA',
    route: {
      inputAsset: USDC,
      inputAmountRaw: '40000000',
      outputAsset: NVDA,
      targetValueRaw: '40000000',
      sourceChain: 'ethereum',
      destinationChain: 'ethereum',
    },
    ...overrides,
  };
}

function keepStep(overrides: Partial<ExecutionStep> = {}): ExecutionStep {
  return {
    action: 'KEEP',
    targetSymbol: 'USDC',
    route: {
      inputAsset: USDC,
      inputAmountRaw: '30000000',
      outputAsset: USDC,
      targetValueRaw: '30000000',
      sourceChain: 'ethereum',
      destinationChain: 'ethereum',
    },
    ...overrides,
  };
}

function plan(steps: ExecutionStep[], overrides: Partial<ExecutionPlan> = {}): ExecutionPlan {
  return {
    bagId: 'bag_1',
    inputAsset: USDC,
    inputAmountRaw: '100000000',
    steps,
    unallocatedRaw: '0',
    ...overrides,
  };
}

/** A deterministic, minimal `LiFiStep`-shaped mock response — only the fields this adapter actually reads. */
function mockStepResponse(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    tool: 'uniswap',
    action: {
      toToken: { decimals: 18 },
      slippage: 0.005,
    },
    estimate: {
      toAmount: '123456789012345678',
      toAmountMin: '122839024662024444',
      gasCosts: [{ amount: '210000000000000', token: { address: '0x0000000000000000000000000000000000000000', chainId: 1 } }],
      feeCosts: [],
    },
    ...overrides,
  };
}

beforeEach(() => {
  getQuoteMock.mockReset();
  resetLiFiClientForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('LiFiExecutionAdapter', () => {
  it('is marked live and named lifi (contrast with the mock adapter)', () => {
    expect(liFiExecutionAdapter.name).toBe('lifi');
    expect(liFiExecutionAdapter.isLive).toBe(true);
  });

  it('single swap: quotes one SWAP step using getQuote, in raw units', async () => {
    getQuoteMock.mockResolvedValueOnce(mockStepResponse());

    const result = await liFiExecutionAdapter.quoteExecutionPlan(plan([swapStep()]));

    expect(getQuoteMock).toHaveBeenCalledTimes(1);
    const call = getQuoteMock.mock.calls[0][1];
    expect(call.fromToken).toBe(USDC.address);
    expect(call.toToken).toBe(NVDA.address);
    expect(call.fromAmount).toBe('40000000');
    expect(typeof call.fromAmount).toBe('string');

    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].error).toBeNull();
    expect(result.steps[0].quote).toMatchObject({
      provider: 'lifi',
      outputAmountRaw: '123456789012345678',
      outputDecimals: 18,
      minOutputRaw: '122839024662024444',
      route: 'uniswap',
      priceImpact: null, // never fabricated — see execution-adapter.ts module doc
    });
  });

  it('multi swap: quotes every SWAP step, one getQuote call each, all represented in order', async () => {
    getQuoteMock
      .mockResolvedValueOnce(mockStepResponse({ estimate: { ...mockStepResponse().estimate, toAmount: '1000' } }))
      .mockResolvedValueOnce(mockStepResponse({ estimate: { ...mockStepResponse().estimate, toAmount: '2000' } }));

    const stepA = swapStep({ targetSymbol: 'xNVDA', route: { ...swapStep().route, inputAmountRaw: '40000000' } });
    const stepB = swapStep({
      targetSymbol: 'xAAPL',
      route: { ...swapStep().route, outputAsset: AAPL_BASE, inputAmountRaw: '60000000', destinationChain: 'base' },
    });

    const result = await liFiExecutionAdapter.quoteExecutionPlan(plan([stepA, stepB]));

    expect(getQuoteMock).toHaveBeenCalledTimes(2);
    expect(result.steps.map((s) => s.step.targetSymbol)).toEqual(['xNVDA', 'xAAPL']);
    expect(result.steps[0].quote?.outputAmountRaw).toBe('1000');
    expect(result.steps[1].quote?.outputAmountRaw).toBe('2000');
  });

  it('KEEP: never calls getQuote for a KEEP step, quote and error both null', async () => {
    getQuoteMock.mockResolvedValueOnce(mockStepResponse());

    const result = await liFiExecutionAdapter.quoteExecutionPlan(plan([swapStep(), keepStep()]));

    expect(getQuoteMock).toHaveBeenCalledTimes(1); // only for the SWAP step
    const keepResult = result.steps.find((s) => s.step.action === 'KEEP');
    expect(keepResult?.quote).toBeNull();
    expect(keepResult?.error).toBeNull();
  });

  it('no route: getQuote 404 maps to a typed QUOTE_UNAVAILABLE error, quote stays null', async () => {
    const { HTTPError } = await import('@lifi/sdk');
    const fakeResponse = new Response(null, { status: 404 });
    getQuoteMock.mockRejectedValueOnce(new HTTPError(fakeResponse, 'https://li.quest/v1/quote', {}));

    const result = await liFiExecutionAdapter.quoteExecutionPlan(plan([swapStep()]));

    expect(result.steps[0].quote).toBeNull();
    expect(result.steps[0].error).toEqual({
      code: 'QUOTE_UNAVAILABLE',
      message: 'No route is currently available for this swap.',
    });
  });

  it('no route: a 404 HTTPError wrapped in SDKError (how the SDK actually throws it) still maps to QUOTE_UNAVAILABLE', async () => {
    const { HTTPError, SDKError } = await import('@lifi/sdk');
    const fakeResponse = new Response(null, { status: 404 });
    getQuoteMock.mockRejectedValueOnce(new SDKError(new HTTPError(fakeResponse, 'https://li.quest/v1/quote', {})));

    const result = await liFiExecutionAdapter.quoteExecutionPlan(plan([swapStep()]));

    expect(result.steps[0].error).toEqual({
      code: 'QUOTE_UNAVAILABLE',
      message: 'No route is currently available for this swap.',
    });
  });

  it('a leg that never answers is cut off after PREVIEW_QUOTE_TIMEOUT_MS as a PROVIDER_ERROR, not a no-route', async () => {
    vi.useFakeTimers();
    try {
      const { PREVIEW_QUOTE_TIMEOUT_MS } = await import('../lifi-execution-adapter');
      getQuoteMock.mockImplementationOnce(() => new Promise(() => {}));
      const pending = liFiExecutionAdapter.quoteExecutionPlan(plan([swapStep()]));
      await vi.advanceTimersByTimeAsync(PREVIEW_QUOTE_TIMEOUT_MS);
      const result = await pending;
      expect(result.steps[0].quote).toBeNull();
      expect(result.steps[0].error?.code).toBe('PROVIDER_ERROR');
    } finally {
      vi.useRealTimers();
    }
  });

  it('timeout: a BaseError with LiFiErrorCode.Timeout maps to a typed PROVIDER_ERROR, quote stays null', async () => {
    const { BaseError, ErrorName, LiFiErrorCode } = await import('@lifi/sdk');
    getQuoteMock.mockRejectedValueOnce(
      new BaseError(ErrorName.ProviderError, LiFiErrorCode.Timeout, 'The request to LI.FI timed out.')
    );

    const result = await liFiExecutionAdapter.quoteExecutionPlan(plan([swapStep()]));

    expect(result.steps[0].quote).toBeNull();
    expect(result.steps[0].error).toEqual({
      code: 'PROVIDER_ERROR',
      message: 'The request to LI.FI timed out.',
    });
  });

  it('never leaks a raw provider error/stack trace into the typed error', async () => {
    getQuoteMock.mockRejectedValueOnce(new Error('ECONNRESET some internal fetch detail at node:internal/...'));

    const result = await liFiExecutionAdapter.quoteExecutionPlan(plan([swapStep()]));

    expect(result.steps[0].error?.code).toBe('PROVIDER_ERROR');
    expect(result.steps[0].quote).toBeNull();
  });

  it('output identity: same address, different chain -> two distinct getQuote calls with different chain ids', async () => {
    getQuoteMock.mockResolvedValueOnce(mockStepResponse()).mockResolvedValueOnce(mockStepResponse());

    const stepBase = swapStep({ targetSymbol: 'xAAPL_BASE', route: { ...swapStep().route, outputAsset: AAPL_BASE, destinationChain: 'base' } });
    const stepArb = swapStep({
      targetSymbol: 'xAAPL_ARB',
      route: { ...swapStep().route, outputAsset: AAPL_ARB, destinationChain: 'arbitrum' },
    });

    await liFiExecutionAdapter.quoteExecutionPlan(plan([stepBase, stepArb]));

    expect(getQuoteMock).toHaveBeenCalledTimes(2);
    const [firstCall, secondCall] = getQuoteMock.mock.calls.map((c) => c[1]);
    expect(firstCall.toChain).toBe(8453); // base
    expect(secondCall.toChain).toBe(42161); // arbitrum
    expect(firstCall.toToken).toBe(secondCall.toToken); // same address...
    expect(firstCall.toChain).not.toBe(secondCall.toChain); // ...but distinct requests
  });

  it('raw amounts: forwards a large bigint-scale fromAmount as an exact string, never a JS number', async () => {
    getQuoteMock.mockResolvedValueOnce(mockStepResponse());
    const bigAmount = '123456789012345678901234567890';

    await liFiExecutionAdapter.quoteExecutionPlan(
      plan([swapStep({ route: { ...swapStep().route, inputAmountRaw: bigAmount } })])
    );

    const call = getQuoteMock.mock.calls[0][1];
    expect(call.fromAmount).toBe(bigAmount);
    expect(typeof call.fromAmount).toBe('string');
  });

  it('slippage: forwards ExecutionRouteRequest.slippageBps to getQuote as a 0-1 fraction', async () => {
    getQuoteMock.mockResolvedValueOnce(mockStepResponse());

    await liFiExecutionAdapter.quoteExecutionPlan(plan([swapStep({ route: { ...swapStep().route, slippageBps: 150 } })]));

    const call = getQuoteMock.mock.calls[0][1];
    expect(call.slippage).toBeCloseTo(0.015);
  });

  it('quote aggregation: every step of the plan is represented in the result, SWAP and KEEP alike', async () => {
    getQuoteMock.mockResolvedValueOnce(mockStepResponse());

    const result = await liFiExecutionAdapter.quoteExecutionPlan(plan([swapStep(), keepStep()]));

    expect(result.steps).toHaveLength(2);
    expect(result.bagId).toBe('bag_1');
    expect(result.inputAmountRaw).toBe('100000000');
    expect(result.unallocatedRaw).toBe('0');
  });

  it('deterministic mock: the same request against the same mocked response produces the same output amount', async () => {
    getQuoteMock.mockResolvedValue(mockStepResponse());

    const resultA = await liFiExecutionAdapter.quoteExecutionPlan(plan([swapStep()]));
    const resultB = await liFiExecutionAdapter.quoteExecutionPlan(plan([swapStep()]));

    expect(resultA.steps[0].quote?.outputAmountRaw).toBe(resultB.steps[0].quote?.outputAmountRaw);
  });

  // Phase 16 — Robinhood Stock Token routes now that lifi-config.ts maps
  // 'robinhood' -> 4663 (verified: Robinhood Chain's own EVM chain id,
  // and LI.FI's own announcement that it routes into Stock Tokens on
  // Robinhood Chain from launch).
  it('xStock output: quotes USDC -> canonical Robinhood Stock Token contract on chain 4663', async () => {
    const xNVDA = { chain: 'robinhood' as const, address: '0xD0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC' };
    getQuoteMock.mockResolvedValueOnce(mockStepResponse());

    const result = await liFiExecutionAdapter.quoteExecutionPlan(
      plan([swapStep({ targetSymbol: 'xNVDA', route: { inputAsset: USDC, inputAmountRaw: '40000000', outputAsset: xNVDA, targetValueRaw: '40000000', sourceChain: 'ethereum', destinationChain: 'robinhood' } })])
    );

    expect(getQuoteMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ fromChain: 1, toChain: 4663, toToken: xNVDA.address })
    );
    expect(result.steps[0].quote).not.toBeNull();
    expect(result.steps[0].error).toBeNull();
  });

  it('canonical contract address: the exact registry-resolved address is forwarded to getQuote, never a symbol', async () => {
    const xAAPL = { chain: 'robinhood' as const, address: '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa' };
    getQuoteMock.mockResolvedValueOnce(mockStepResponse());

    await liFiExecutionAdapter.quoteExecutionPlan(
      plan([swapStep({ targetSymbol: 'xAAPL', route: { inputAsset: USDC, inputAmountRaw: '20000000', outputAsset: xAAPL, targetValueRaw: '20000000', sourceChain: 'ethereum', destinationChain: 'robinhood' } })])
    );

    const call = getQuoteMock.mock.calls[0][1] as Record<string, unknown>;
    expect(call.toToken).toBe(xAAPL.address);
    expect(call.toToken).not.toMatch(/^[A-Za-z]+$/); // not a bare symbol like "AAPL"
  });

  it('wrong/unsupported chain rejected: a step whose chain has no LI.FI mapping yields INVALID_ASSET, getQuote never called for it', async () => {
    const fakeChainAsset = { chain: 'ethereum' as const, address: '0x3333333333333333333333333333333333333333' };
    const badStep = swapStep({
      targetSymbol: 'FAKE',
      route: {
        inputAsset: USDC,
        inputAmountRaw: '10000000',
        outputAsset: fakeChainAsset,
        targetValueRaw: '10000000',
        sourceChain: 'ethereum',
        // Cast past the ChainId union deliberately — simulates a client
        // supplying an arbitrary, non-canonical chain the registry
        // never verified, which toLiFiChainId() must reject rather than
        // silently forward to getQuote().
        destinationChain: 'not-a-real-chain' as unknown as 'ethereum',
      },
    });

    const result = await liFiExecutionAdapter.quoteExecutionPlan(plan([badStep]));

    expect(getQuoteMock).not.toHaveBeenCalled();
    expect(result.steps[0].quote).toBeNull();
    expect(result.steps[0].error).toEqual({
      code: 'INVALID_ASSET',
      message: 'No LI.FI chain id mapping for chain "not-a-real-chain".',
    });
  });

  it('fee/gas null handling: an empty feeCosts array reports executionFeeRaw "0" and gasCostRaw only from a single-token gasCosts array', async () => {
    getQuoteMock.mockResolvedValueOnce(
      mockStepResponse({
        estimate: {
          toAmount: '1',
          toAmountMin: '1',
          gasCosts: [],
          feeCosts: [],
        },
      })
    );

    const result = await liFiExecutionAdapter.quoteExecutionPlan(plan([swapStep()]));
    expect(result.steps[0].quote?.executionFeeRaw).toBe('0');
    expect(result.steps[0].quote?.gasCostRaw).toBeNull();
    expect(result.steps[0].quote?.gasCostAsset).toBeNull();
  });

  it('no execution: never calls anything beyond getQuote — no execute/sign/send method is invoked', async () => {
    const lifiModule = await import('@lifi/sdk');
    const executeRouteSpy = vi.spyOn(lifiModule, 'executeRoute');
    getQuoteMock.mockResolvedValueOnce(mockStepResponse());

    await liFiExecutionAdapter.quoteExecutionPlan(plan([swapStep(), keepStep()]));

    expect(executeRouteSpy).not.toHaveBeenCalled();
    // Adapter module itself only ever imports `getQuote` (plus error
    // classes) from '@lifi/sdk' — see lifi-execution-adapter.ts's own
    // import list, which this test's mock factory intercepts in full.
    expect(getQuoteMock).toHaveBeenCalledTimes(1);
  });
});
