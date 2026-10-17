import { describe, expect, it, vi } from 'vitest';
import type { BagExecutionGraph, BagExecutionIntent } from '../../types';

const buildComposerPurchaseMock = vi.fn();
vi.mock('@/lib/blockchain/lifi-composer-adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/blockchain/lifi-composer-adapter')>();
  return { ...actual, buildComposerPurchase: (...a: unknown[]) => buildComposerPurchaseMock(...a) };
});

import { composeError, out } from '@/lib/blockchain/__tests__/composer-fixtures';
const { LiFiComposerProvider } = await import('../lifi-composer-provider');

const USDG = { chain: 'robinhood' as const, address: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' };
const target = (address: string) => ({ chain: 'robinhood' as const, address });

function graph(): BagExecutionGraph {
  const legs = ['0xaaa', '0xbbb', '0xccc'].map((address, i) => ({
    id: `leg_${i}`,
    sourceAsset: USDG,
    targetAsset: target(address),
    amountRaw: '333333',
    weightBps: i === 2 ? 3334 : 3333,
    minimumOutputRaw: null,
    slippageBps: 100,
    chain: 'robinhood' as const,
    dependsOn: [],
  }));
  return { bagId: 'bag_1', wallet: '0xwallet', chainId: 'robinhood', inputAsset: USDG, inputAmountRaw: '1000000', legs, unallocatedRaw: '0' } as BagExecutionGraph;
}

describe('LiFiComposerProvider — providerEnforcedMinOutputRaw', () => {
  it('maps each leg to the amountOutMin of its own swap node, and never claims a BAG-level guaranteed floor', async () => {
    buildComposerPurchaseMock.mockResolvedValue({
      approvals: [],
      transactionRequest: { to: '0xdiamond', data: '0xdead', value: '0', chainId: 4663 },
      userProxy: '0xproxy',
      outputs: {
        'swap_0.amountOut': out(1000, 990),
        'swap_1.amountOut': out(2000, 1980),
        'swap_2.amountOut': out(3000, 2970),
      },
      gasLimitRaw: null,
      priceImpact: null,
      fees: [],
    });

    const compiled = await new LiFiComposerProvider({ apiKey: 'k' }).compile({} as BagExecutionIntent, graph());

    expect(compiled.expectedOutputs.map((o) => [o.legId, o.asset.address, o.providerEnforcedMinOutputRaw, o.minimumGuaranteedOutputRaw])).toEqual([
      ['leg_0', '0xaaa', '990', null],
      ['leg_1', '0xbbb', '1980', null],
      ['leg_2', '0xccc', '2970', null],
    ]);
    // Simulated (expected) output per leg, read from the same port-keyed entries.
    expect(compiled.expectedOutputs.map((o) => [o.quotedOutputRaw, o.quotedOutputBasis])).toEqual([
      ['1000', 'SIMULATION'],
      ['2000', 'SIMULATION'],
      ['3000', 'SIMULATION'],
    ]);
    const legQuotes = compiled.providerMetadata?.legQuotes as Record<string, { outputAmountRaw: string | null }>;
    expect(Object.values(legQuotes).map((q) => q.outputAmountRaw)).toEqual(['1000', '2000', '3000']);
  });
});

describe('LiFiComposerProvider — native ETH input', () => {
  it('supports a native-ETH payment and compiles it as one transaction with the ETH as its value', async () => {
    const ETH = { chain: 'robinhood' as const, address: '0x0000000000000000000000000000000000000000' };
    const g = graph();
    const native = { ...g, inputAsset: ETH, legs: g.legs.map((l) => ({ ...l, sourceAsset: ETH })) } as BagExecutionGraph;
    const provider = new LiFiComposerProvider({ apiKey: 'k' });
    expect(provider.getCapabilities().nativeAsset).toBe(true);
    expect(provider.supports({} as BagExecutionIntent, native)).toBe(true);
    buildComposerPurchaseMock.mockResolvedValueOnce({
      approvals: [],
      transactionRequest: { to: '0xvm', data: '0xdead', value: '1000000', chainId: 4663 },
      userProxy: '0xproxy',
      outputs: {},
      gasLimitRaw: null,
      priceImpact: null,
      fees: [],
    });
    const compiled = await provider.compile({} as BagExecutionIntent, native);
    expect(buildComposerPurchaseMock).toHaveBeenLastCalledWith(expect.objectContaining({ inputTokenAddress: ETH.address, inputAmountRaw: '1000000' }));
    expect(compiled.mode).toBe('SINGLE_TX');
    expect(compiled.transactions).toEqual([expect.objectContaining({ value: '1000000' })]);
  });
});

describe('LiFiComposerProvider — consent, slippage and refusals (same rules as the legacy path)', () => {
  const ok = { approvals: [], transactionRequest: { to: '0xvm', data: '0x', value: '0', chainId: 4663 }, userProxy: '0xproxy', outputs: {}, gasLimitRaw: null, priceImpact: null, fees: [] };

  it('passes the buyer-accepted price-impact limit to Composer', async () => {
    buildComposerPurchaseMock.mockResolvedValueOnce(ok);
    await new LiFiComposerProvider({ apiKey: 'k', maxPriceImpactBps: 920 }).compile({} as BagExecutionIntent, graph());
    expect(buildComposerPurchaseMock).toHaveBeenLastCalledWith(expect.objectContaining({ maxPriceImpactBps: 920 }));
  });

  it('refuses a graph whose legs use different slippage limits instead of applying legs[0] to all', async () => {
    const g = graph();
    const mixed = { ...g, legs: g.legs.map((l, i) => ({ ...l, slippageBps: i === 0 ? 100 : 300 })) } as BagExecutionGraph;
    buildComposerPurchaseMock.mockClear();
    await expect(new LiFiComposerProvider({ apiKey: 'k' }).compile({} as BagExecutionIntent, mixed)).rejects.toThrow(/different slippage/);
    expect(buildComposerPurchaseMock).not.toHaveBeenCalled();
  });

  it('a whole-flow price-impact refusal becomes PRICE_IMPACT_REFUSED carrying the notice; other errors pass through', async () => {
    buildComposerPurchaseMock.mockRejectedValueOnce(await composeError('price_impact_exceeded', 'Price impact 820 bps exceeds maximum 500 bps (input: $10.00, output: $9.18)'));
    await expect(new LiFiComposerProvider({ apiKey: 'k' }).compile({} as BagExecutionIntent, graph())).rejects.toMatchObject({
      code: 'PRICE_IMPACT_REFUSED',
      details: { composerFallback: { reason: 'PRICE_IMPACT', priceImpactBps: 820, maxPriceImpactBps: 500 } },
    });
    buildComposerPurchaseMock.mockRejectedValueOnce(await composeError('simulation_revert', 'execution reverted'));
    await expect(new LiFiComposerProvider({ apiKey: 'k' }).compile({} as BagExecutionIntent, graph())).rejects.toThrow('execution reverted');
  });
});
