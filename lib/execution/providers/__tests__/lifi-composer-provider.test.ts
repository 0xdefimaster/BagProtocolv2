import { describe, expect, it, vi } from 'vitest';
import type { BagExecutionGraph, BagExecutionIntent } from '../../types';

const buildComposerPurchaseMock = vi.fn();
vi.mock('@/lib/blockchain/lifi-composer-adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/blockchain/lifi-composer-adapter')>();
  return { ...actual, buildComposerPurchase: (...a: unknown[]) => buildComposerPurchaseMock(...a) };
});

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
      producedResources: {
        'swap_0.amountOut': { simulated: { amountOut: BigInt(1000), amountOutMin: BigInt(990) } },
        'swap_1.amountOut': { simulated: { amountOut: BigInt(2000), amountOutMin: BigInt(1980) } },
        'swap_2.amountOut': { simulated: { amountOut: BigInt(3000), amountOutMin: BigInt(2970) } },
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
