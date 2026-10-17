import { describe, expect, it, vi } from 'vitest';
import type { ExecutionStep } from '@/types/basket-protocol';
import { composeResponse, wireOut } from '@/lib/blockchain/__tests__/composer-fixtures';
import { buildRedeemComposer, splitReceivedAcrossLegs } from '../redeem-composer';

// HTTP-boundary mocking, as in lifi-composer-sweep.test.ts: the real Composer SDK builds the flow.
const WALLET = '0x49da00000000000000000000000000000000fe46';
const MSFT = '0x00000000000000000000000000000000000000a1';
const NVDA = '0x00000000000000000000000000000000000000b2';
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const SPENDER = '0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae';

const swap = (address: string, amountRaw: string, symbol: string): ExecutionStep => ({
  action: 'SWAP',
  targetSymbol: symbol,
  route: {
    inputAsset: { chain: 'robinhood', address },
    outputAsset: { chain: 'robinhood', address: USDG },
    sourceChain: 'robinhood',
    destinationChain: 'robinhood',
    inputAmountRaw: amountRaw,
    targetValueRaw: amountRaw,
  } as ExecutionStep['route'],
});
const keep: ExecutionStep = {
  action: 'KEEP',
  targetSymbol: 'USDG',
  route: { ...swap(USDG, '7', 'USDG').route, inputAsset: { chain: 'robinhood', address: USDG } },
};

function composeFetch(data: Record<string, unknown> = {}, ok = true) {
  const body = {
    data: {
      outputs: {
        'sweep_0.amountOut': wireOut('6000000', '5940000', USDG),
        'sweep_1.amountOut': wireOut('4000000', '3960000', USDG),
      },
      transactionRequest: { to: SPENDER, chainId: 4663, data: '0xdeadbeef', value: '0' },
      approvals: [
        { token: MSFT, spender: SPENDER, amount: '1000' },
        { token: NVDA, spender: SPENDER, amount: '2000' },
      ],
      userProxy: '0xUserProxy',
      ...data,
    },
  };
  return vi.fn(async () => composeResponse(body, ok ? 200 : 500)) as unknown as typeof fetch;
}

const request = (steps: ExecutionStep[], fetchImpl: typeof fetch) => ({
  steps,
  walletAddress: WALLET,
  outputAsset: { chain: 'robinhood' as const, address: USDG },
  outputDecimals: 6,
  apiKey: 'k',
  fetchImpl,
});

describe('buildRedeemComposer', () => {
  it('sells every SWAP leg in one transaction; KEEP legs stay as they are', async () => {
    const fetchImpl = composeFetch();
    const built = await buildRedeemComposer(request([swap(MSFT, '1000', 'MSFT'), keep, swap(NVDA, '2000', 'NVDA')], fetchImpl));
    expect(built).not.toBeNull();
    if (!built) return;
    const sent = String((fetchImpl as unknown as { mock: { calls: [unknown, RequestInit][] } }).mock.calls[0][1].body).toLowerCase();
    expect(sent).toContain(MSFT);
    expect(sent).toContain(NVDA);
    expect(built.composerTransaction).toEqual({
      to: SPENDER,
      data: '0xdeadbeef',
      value: '0',
      chainId: 4663,
      approvals: [
        { token: MSFT, spender: SPENDER, amountRaw: '1000' },
        { token: NVDA, spender: SPENDER, amountRaw: '2000' },
      ],
    });
    expect(built.steps.map((s) => [s.stepIndex, s.action, s.status])).toEqual([
      [0, 'SWAP', 'PENDING'],
      [1, 'KEEP', 'NOT_NEEDED'],
      [2, 'SWAP', 'PENDING'],
    ]);
    // Leg amounts are Composer's simulation; BAG's own floor stays unset, the on-chain one is recorded separately.
    expect(built.steps[0]).toMatchObject({ inputAmountRaw: '1000', outputAmountRaw: '6000000', providerEnforcedMinOutputRaw: '5940000', minOutputRaw: null, lifiStep: null });
    expect(built.steps[2]).toMatchObject({ inputAmountRaw: '2000', outputAmountRaw: '4000000', providerEnforcedMinOutputRaw: '3960000' });
  });

  it('never accepts an approval for a token not being sold, or above the amount sold', async () => {
    expect(await buildRedeemComposer(request([swap(MSFT, '1000', 'MSFT')], composeFetch({ approvals: [{ token: MSFT, spender: SPENDER, amount: '1001' }] })))).toBeNull();
    expect(await buildRedeemComposer(request([swap(MSFT, '1000', 'MSFT')], composeFetch({ approvals: [{ token: USDG, spender: SPENDER, amount: '1' }] })))).toBeNull();
  });

  it('null (the per-asset quotes are kept) when there is nothing to swap, Composer fails, or a leg is not a sale into the output', async () => {
    expect(await buildRedeemComposer(request([keep], composeFetch()))).toBeNull();
    expect(await buildRedeemComposer(request([swap(MSFT, '1000', 'MSFT')], composeFetch({}, false)))).toBeNull();
    const elsewhere = swap(MSFT, '1000', 'MSFT');
    elsewhere.route.outputAsset = { chain: 'robinhood', address: NVDA };
    expect(await buildRedeemComposer(request([elsewhere], composeFetch()))).toBeNull();
  });

  it('a sale that would also spend native ETH is refused', async () => {
    expect(await buildRedeemComposer(request([swap(MSFT, '1000', 'MSFT')], composeFetch({ transactionRequest: { to: SPENDER, chainId: 4663, data: '0x', value: '1' } })))).toBeNull();
  });
});

describe('splitReceivedAcrossLegs', () => {
  it('in proportion to the simulated outputs, remainder to the last leg, summing exactly to what arrived', () => {
    expect(splitReceivedAcrossLegs(BigInt(1000), ['600', '400'])).toEqual(['600', '400']);
    const parts = splitReceivedAcrossLegs(BigInt(1001), ['1', '1', '1']);
    expect(parts).toEqual(['333', '333', '335']);
    expect(splitReceivedAcrossLegs(BigInt(10), [null, '5'])).toEqual(['5', '5']);
  });
});
