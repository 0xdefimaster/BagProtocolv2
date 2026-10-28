import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionStep } from '@/types/basket-protocol';

// The legacy (pre-compiler) Composer path must persist real decimals on
// every step: accounting only credits holdings for steps that have them,
// but mints shares regardless.

const buildComposerPurchaseMock = vi.fn();
const getQuoteMock = vi.fn();

vi.mock('@lifi/sdk', () => ({ getQuote: (...a: unknown[]) => getQuoteMock(...a), HTTPError: class extends Error {} }));
vi.mock('../lifi-config', () => ({ getLiFiClient: () => ({}), toLiFiChainId: () => 1 }));
vi.mock('../lifi-token-data', () => ({ getLiFiTokenData: vi.fn() }));
vi.mock('../lifi-execution-adapter', () => ({ mapLiFiError: () => ({ code: 'PROVIDER_ERROR', message: 'no route in test' }) }));
vi.mock('../lifi-composer-adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lifi-composer-adapter')>();
  return {
    buildComposerPurchase: (...a: unknown[]) => buildComposerPurchaseMock(...a),
    isComposerEligible: () => true,
    ComposerIneligibleError: class extends Error {},
    // The real readers: the test feeds them a live-shaped `outputs` map.
    composerLegEnforcedMinOutputRaw: actual.composerLegEnforcedMinOutputRaw,
    composerLegSimulatedOutputRaw: actual.composerLegSimulatedOutputRaw,
    composeErrorOf: actual.composeErrorOf,
  };
});

const { buildPurchaseIntentSteps, composerFallbackFrom } = await import('../lifi-purchase-quote');
const { composeError, out } = await import('./composer-fixtures');

const USDC = { chain: 'ethereum', address: '0xusdc' } as const;
const WETH = { chain: 'ethereum', address: '0xweth' } as const;

function step(action: 'KEEP' | 'SWAP', outputAsset: { chain: string; address: string }, amount: string): ExecutionStep {
  return {
    action,
    targetSymbol: action === 'KEEP' ? 'USDC' : 'WETH',
    route: {
      inputAsset: USDC,
      inputAmountRaw: amount,
      outputAsset,
      targetValueRaw: amount,
      sourceChain: 'ethereum',
      destinationChain: 'ethereum',
    },
  } as ExecutionStep;
}

const composerResult = {
  transactionRequest: { to: '0xcomposer', data: '0xdead', value: '0', chainId: 1 },
  userProxy: '0xproxy',
  // Live API shape: keyed by output port (`swap_0.amountOut`).
  outputs: { 'swap_0.amountOut': out(BigInt(5) * BigInt(10) ** BigInt(17)) },
};

beforeEach(() => {
  vi.clearAllMocks();
  buildComposerPurchaseMock.mockResolvedValue(composerResult);
});

describe('buildPurchaseIntentSteps — Composer legs from the SDK partition planner', () => {
  it('orders legs by token address and reads each step\'s output from ITS leg, whatever the recipe order', async () => {
    const ZED = { chain: 'ethereum', address: '0xzed' } as const;
    const ABC = { chain: 'ethereum', address: '0xabc' } as const;
    buildComposerPurchaseMock.mockResolvedValue({
      ...composerResult,
      // swap_0 is 0xabc (sorted first), swap_1 is 0xzed.
      outputs: { 'swap_0.amountOut': out(111, 110), 'swap_1.amountOut': out(999, 990) },
    });
    const result = await buildPurchaseIntentSteps([step('SWAP', ZED, '700000'), step('SWAP', ABC, '300000')], '0xwallet', 6, {
      apiKey: 'k',
      slippageBps: 100,
      resolveOutputDecimals: () => 18,
    });
    expect(buildComposerPurchaseMock).toHaveBeenCalledWith(
      expect.objectContaining({
        inputAmountRaw: '1000000',
        legs: [
          { address: '0xabc', weightBps: 3000, symbol: 'WETH' },
          { address: '0xzed', weightBps: 7000, symbol: 'WETH' },
        ],
      })
    );
    expect(result.steps.map((st) => [st.outputAsset.address, st.outputAmountRaw, st.providerEnforcedMinOutputRaw])).toEqual([
      ['0xzed', '999', '990'],
      ['0xabc', '111', '110'],
    ]);
  });
});

describe('buildPurchaseIntentSteps — Composer path decimals', () => {
  it('stores the recipe decimals on SWAP steps and the input decimals on KEEP steps', async () => {
    const result = await buildPurchaseIntentSteps([step('KEEP', USDC, '400000'), step('SWAP', WETH, '600000')], '0xwallet', 6, {
      apiKey: 'k',
      slippageBps: 100,
      resolveOutputDecimals: (a) => (a.address === WETH.address ? 18 : null),
    });

    expect(result.composerTransaction).not.toBeNull();
    expect(result.steps[0]).toMatchObject({ action: 'KEEP', outputDecimals: 6 });
    expect(result.steps[1]).toMatchObject({ action: 'SWAP', outputDecimals: 18, status: 'PENDING' });
    // The simulated output is read from the port-keyed entry (it used to be looked up by node id and came back null).
    expect(result.steps[1].outputAmountRaw).toBe('500000000000000000');
  });

  it('skips Composer (sequential fallback) when an output asset has no known decimals', async () => {
    getQuoteMock.mockRejectedValue(new Error('no route in test'));
    const result = await buildPurchaseIntentSteps([step('SWAP', WETH, '600000')], '0xwallet', 6, {
      apiKey: 'k',
      slippageBps: 100,
      resolveOutputDecimals: () => null,
    });

    expect(buildComposerPurchaseMock).not.toHaveBeenCalled();
    expect(result.composerTransaction).toBeNull();
  });

  it('records the swap\'s provider-enforced minimum on the Composer step, leaving BAG\'s minOutputRaw unset', async () => {
    buildComposerPurchaseMock.mockResolvedValue({
      ...composerResult,
      // Live API shape: keyed by output port.
      outputs: { 'swap_0.amountOut': out(500, 495) },
    });
    const result = await buildPurchaseIntentSteps([step('KEEP', USDC, '400000'), step('SWAP', WETH, '600000')], '0xwallet', 6, {
      apiKey: 'k',
      slippageBps: 100,
      resolveOutputDecimals: (a) => (a.address === WETH.address ? 18 : null),
    });

    expect(result.steps[1]).toMatchObject({ action: 'SWAP', providerEnforcedMinOutputRaw: '495', minOutputRaw: null });
    expect(result.steps[0].providerEnforcedMinOutputRaw ?? null).toBeNull();
  });
});

describe('Composer refusal -> failed intent with the reason, never one route per asset', () => {
  const opts = { apiKey: 'k', slippageBps: 100, resolveOutputDecimals: () => 18 };

  it('does not quote per-asset routes; returns the price-impact refusal as a failure', async () => {
    buildComposerPurchaseMock.mockRejectedValue(await composeError('price_impact_exceeded', 'Price impact 551 bps exceeds maximum 500 bps (input: $0.9991, output: $0.9440)'));
    const result = await buildPurchaseIntentSteps([step('SWAP', WETH, '600000')], '0xwallet', 6, opts);

    expect(getQuoteMock).not.toHaveBeenCalled();
    expect(result.composerTransaction).toBeNull();
    expect(result.allSwapsQuoted).toBe(false);
    expect(result.firstFailure?.failureCode).toBe('SLIPPAGE_EXCEEDED');
    expect(result.composerFallback).toEqual({
      reason: 'PRICE_IMPACT',
      message: 'Price impact 551 bps exceeds maximum 500 bps (input: $0.9991, output: $0.9440)',
      priceImpactBps: 551,
      maxPriceImpactBps: 500,
      inputUsd: '0.9991',
      outputUsd: '0.9440',
      kind: 'price_impact_exceeded',
    });
  });

  it('a successful Composer compile carries no fallback notice', async () => {
    const result = await buildPurchaseIntentSteps([step('SWAP', WETH, '600000')], '0xwallet', 6, opts);
    expect(result.composerTransaction).not.toBeNull();
    expect(result.composerFallback ?? null).toBeNull();
  });

  it('any other Composer failure is reported as UNAVAILABLE with no invented figures', () => {
    expect(composerFallbackFrom(new Error('network down'))).toEqual({
      reason: 'UNAVAILABLE',
      message: 'network down',
      priceImpactBps: null,
      maxPriceImpactBps: null,
      inputUsd: null,
      outputUsd: null,
      kind: null,
    });
  });

  it('classifies by the typed kind, not the message: only a whole-flow price_impact_exceeded is retryable', async () => {
    // The same words without the typed kind are not a price-impact refusal.
    expect(composerFallbackFrom(new Error('Price impact 551 bps exceeds maximum 500 bps')).reason).toBe('UNAVAILABLE');
    // One swap's route filter: raising the limit does not help.
    expect(composerFallbackFrom(await composeError('price_impact_exceeded', 'Price impact too high for swap_0')).reason).toBe('UNAVAILABLE');
    const revert = composerFallbackFrom(await composeError('simulation_revert', 'execution reverted: Insufficient output'));
    expect(revert).toMatchObject({ reason: 'UNAVAILABLE', kind: 'simulation_revert' });
    expect(composerFallbackFrom(await composeError('sdk_outdated', 'upgrade the SDK')).kind).toBe('sdk_outdated');
    // A wrapped error (failing legs named) keeps the original kind via `cause`.
    const wrapped = new Error('GRT: No available quotes (1 of 2 prepared op(s) failed)', { cause: await composeError('preparation_error', '1 of 2 prepared op(s) failed') });
    expect(composerFallbackFrom(wrapped)).toMatchObject({ reason: 'UNAVAILABLE', kind: 'preparation_error', message: 'GRT: No available quotes (1 of 2 prepared op(s) failed)' });
  });

  it('a version mismatch (sdk_outdated / server_outdated) says so plainly and alerts the operator', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const sdk = composerFallbackFrom(
      await composeError('sdk_outdated', 'SDK 0.5.0 is older than the minimum 0.6.0', { sdkOutdated: { sdkVersion: '0.5.0', serverVersion: '0.7.0', minimumSdkVersion: '0.6.0' } })
    );
    expect(sdk).toMatchObject({ reason: 'UNAVAILABLE', kind: 'sdk_outdated' });
    expect(sdk.message).toMatch(/Composer SDK is older than the API now supports\. Nothing was sent\./);
    expect(sdk.message).toContain('SDK 0.5.0 is older than the minimum 0.6.0');
    const server = composerFallbackFrom(
      await composeError('server_outdated', 'server 0.5.0 is older than SDK 0.6.0', { serverOutdated: { sdkVersion: '0.6.0', serverVersion: '0.5.0' } })
    );
    expect(server.message).toMatch(/Composer API is older than this app's SDK/);
    expect(errorLog).toHaveBeenCalledTimes(2);
    errorLog.mockRestore();
  });

  it('passes an accepted price-impact limit to Composer', async () => {
    await buildPurchaseIntentSteps([step('SWAP', WETH, '600000')], '0xwallet', 6, { ...opts, maxPriceImpactBps: 651 });
    expect(buildComposerPurchaseMock).toHaveBeenCalledWith(expect.objectContaining({ maxPriceImpactBps: 651 }));
  });
});

describe('buildPurchaseIntentSteps — native ETH input', () => {
  it('builds ONE Composer transaction for a native-ETH payment (ETH as the tx value, no per-asset LI.FI quotes)', async () => {
    const ETH = { chain: 'ethereum', address: '0x0000000000000000000000000000000000000000' } as const;
    buildComposerPurchaseMock.mockResolvedValue({ ...composerResult, transactionRequest: { ...composerResult.transactionRequest, value: '50000000000000000' }, approvals: [] });
    const ethStep = { ...step('SWAP', WETH, '50000000000000000'), route: { ...step('SWAP', WETH, '50000000000000000').route, inputAsset: ETH } } as ExecutionStep;
    const result = await buildPurchaseIntentSteps([ethStep], '0xwallet', 18, {
      apiKey: 'k',
      slippageBps: 100,
      resolveOutputDecimals: () => 18,
    });
    expect(buildComposerPurchaseMock).toHaveBeenCalledWith(expect.objectContaining({ inputTokenAddress: ETH.address, inputAmountRaw: '50000000000000000' }));
    expect(getQuoteMock).not.toHaveBeenCalled();
    expect(result.composerTransaction).toMatchObject({ value: '50000000000000000' });
    expect(result.allSwapsQuoted).toBe(true);
  });
});

describe('buildPurchaseIntentSteps — native ETH when Composer refuses', () => {
  const ETH = { chain: 'ethereum', address: '0x0000000000000000000000000000000000000000' } as const;
  const ethStep = () => ({ ...step('SWAP', WETH, '50000000000000000'), route: { ...step('SWAP', WETH, '50000000000000000').route, inputAsset: ETH } }) as ExecutionStep;
  const opts = { apiKey: 'k', slippageBps: 100, resolveOutputDecimals: () => 18 };

  it('a non-price-impact refusal falls back to the per-asset path (each swap sends its ETH)', async () => {
    const { getLiFiTokenData } = await import('../lifi-token-data');
    vi.mocked(getLiFiTokenData).mockReturnValue({ prime: vi.fn() } as unknown as ReturnType<typeof getLiFiTokenData>);
    buildComposerPurchaseMock.mockRejectedValue(new Error('Composer flow compilation failed: unsupported — native input'));
    getQuoteMock.mockResolvedValue({ tool: 'uniswap', estimate: { toAmount: '100', toAmountMin: '99' }, action: { fromToken: {}, toToken: { decimals: 18 } } });
    const result = await buildPurchaseIntentSteps([ethStep()], '0xwallet', 18, opts);
    expect(result.composerTransaction).toBeNull();
    expect(result.allSwapsQuoted).toBe(true);
    expect(getQuoteMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ fromToken: ETH.address }));
  });

  it('a price-impact refusal still goes back to the buyer (no silent per-asset purchase)', async () => {
    buildComposerPurchaseMock.mockRejectedValue(await composeError('price_impact_exceeded', 'price impact 900 bps exceeds maximum 500 bps'));
    const result = await buildPurchaseIntentSteps([ethStep()], '0xwallet', 18, opts);
    expect(result.allSwapsQuoted).toBe(false);
    expect(result.composerFallback?.reason).toBe('PRICE_IMPACT');
    expect(getQuoteMock).not.toHaveBeenCalled();
  });
});
