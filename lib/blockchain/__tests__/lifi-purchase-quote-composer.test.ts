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
    // The real reader: the test feeds it a live-shaped producedResources map.
    composerLegEnforcedMinOutputRaw: actual.composerLegEnforcedMinOutputRaw,
    composerLegSimulatedOutputRaw: actual.composerLegSimulatedOutputRaw,
  };
});

const { buildPurchaseIntentSteps, parseComposerFallback } = await import('../lifi-purchase-quote');

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
  producedResources: { 'swap_0.amountOut': { simulated: { amountOut: BigInt(5) * BigInt(10) ** BigInt(17) } } },
};

beforeEach(() => {
  vi.clearAllMocks();
  buildComposerPurchaseMock.mockResolvedValue(composerResult);
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
      producedResources: { 'swap_0.amountOut': { simulated: { amountOut: BigInt(500), amountOutMin: BigInt(495) } } },
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
    buildComposerPurchaseMock.mockRejectedValue(new Error('Price impact 551 bps exceeds maximum 500 bps (input: $0.9991, output: $0.9440)'));
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
    });
  });

  it('a successful Composer compile carries no fallback notice', async () => {
    const result = await buildPurchaseIntentSteps([step('SWAP', WETH, '600000')], '0xwallet', 6, opts);
    expect(result.composerTransaction).not.toBeNull();
    expect(result.composerFallback ?? null).toBeNull();
  });

  it('any other Composer failure is reported as UNAVAILABLE with no invented figures', () => {
    expect(parseComposerFallback('network down')).toEqual({
      reason: 'UNAVAILABLE',
      message: 'network down',
      priceImpactBps: null,
      maxPriceImpactBps: null,
      inputUsd: null,
      outputUsd: null,
    });
  });

  it('passes an accepted price-impact limit to Composer', async () => {
    await buildPurchaseIntentSteps([step('SWAP', WETH, '600000')], '0xwallet', 6, { ...opts, maxPriceImpactBps: 651 });
    expect(buildComposerPurchaseMock).toHaveBeenCalledWith(expect.objectContaining({ maxPriceImpactBps: 651 }));
  });
});
