import { describe, expect, it, vi } from 'vitest';
import { BAG_CHAINS } from '@/lib/config/chains';
import { buildComposerPurchase, buildComposerSweep } from '../lifi-composer-adapter';
import { composeResponse, wireOut } from './composer-fixtures';

const wallet = '0x1111111111111111111111111111111111111111';
const a = '0x2222222222222222222222222222222222222222';
const b = '0x3333333333333333333333333333333333333333';
const input = '0x4444444444444444444444444444444444444444';

describe.each(['robinhood', 'base', 'arbitrum'] as const)('Composer app flow on %s (HTTP fixture)', chain => {
  const chainId = BAG_CHAINS[chain].chainId;
  const quote = (responseChain = chainId) => vi.fn(async () => composeResponse({ data: {
    outputs: {
      'swap_0.amountOut': wireOut(600, 590, a, chainId), 'swap_1.amountOut': wireOut(400, 390, b, chainId),
      'sweep_0.amountOut': wireOut(600, 590, input, chainId), 'sweep_1.amountOut': wireOut(400, 390, input, chainId),
    },
    transactionRequest: { to: wallet, chainId: responseChain, data: '0xabcd', value: '0' },
    userProxy: wallet,
  } })) as unknown as typeof fetch;
  const buy = (fetchImpl: typeof fetch) => buildComposerPurchase({ chain, inputTokenAddress: input, inputAmountRaw: '1000',
    legs: [{ address: a, weightBps: 6000, symbol: 'A' }, { address: b, weightBps: 4000, symbol: 'B' }],
    signerAddress: wallet, slippageBps: 100, apiKey: 'fixture', fetchImpl });
  const sell = (fetchImpl: typeof fetch) => buildComposerSweep({ chain,
    inputs: [{ address: a, amountRaw: '600', symbol: 'A' }, { address: b, amountRaw: '400', symbol: 'B' }],
    outputTokenAddress: input, signerAddress: wallet, slippageBps: 100, apiKey: 'fixture', fetchImpl });

  it('builds multi-asset buy and sell calldata on the requested chain', async () => {
    for (const run of [buy, sell]) {
      const fetchImpl = quote();
      expect((await run(fetchImpl)).transactionRequest.chainId).toBe(chainId);
      const body = JSON.parse(String(vi.mocked(fetchImpl).mock.calls[0][1]?.body));
      expect(JSON.stringify(body)).toContain(`"chainId":${chainId}`);
    }
  });
  it('refuses a provider transaction on another chain instead of relabelling it', async () => {
    const wrongChain = chainId === 8453 ? 42161 : 8453;
    await expect(buy(quote(wrongChain))).rejects.toThrow(/does not match requested chain/);
    await expect(sell(quote(wrongChain))).rejects.toThrow(/does not match requested chain/);
  });
});
