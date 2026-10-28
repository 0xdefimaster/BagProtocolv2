import { beforeEach, describe, expect, it, vi } from 'vitest';

// quoteRebalance: the preview (mocked) turned into a real Composer flow (the real builder and SDK; only Composer's
// HTTP response is fake). The compiled transaction must never leave this function.

const TSLA = '0x322f0929c4625ed5bad873c95208d54e1c003b2d';
const NVDA = '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec';
const AMKR = '0xaaaa000000000000000000000000000000000001';
const SIGNER = '0x49dadd8212128bdf6752351bf70f6a5d8b73fe46';
const E18 = BigInt(10) ** BigInt(18);

const load = vi.hoisted(() => vi.fn());
vi.mock('@/lib/server/rebalance-preview', () => ({ loadRebalancePreview: load }));

import { composeResponse, wireOut } from '@/lib/blockchain/__tests__/composer-fixtures';
import { quoteRebalance, weightsFromValues } from '../rebalance-quote';

const order = (address: string, side: 'BUY' | 'SELL', value: string, quantityRaw: string | null) => ({ asset: { chain: 'robinhood', address }, symbol: address, side, value, quantityRaw, decimals: 18 });
function loaded(orders: ReturnType<typeof order>[], over: Record<string, unknown> = {}) {
  return {
    ok: true,
    bag: { id: 'b', chain: 'robinhood' },
    recipe: { rebalanceRule: { maxSlippageBps: 100, driftThresholdBps: 500 } },
    holdings: [
      { chain: 'robinhood', address: TSLA, decimals: 18, quantityRaw: (BigInt(60) * E18).toString(), sellableRaw: (BigInt(60) * E18).toString() },
      { chain: 'robinhood', address: NVDA, decimals: 18, quantityRaw: (BigInt(40) * E18).toString(), sellableRaw: (BigInt(40) * E18).toString() },
    ],
    symbols: { [`robinhood:${TSLA}`]: 'TSLA', [`robinhood:${NVDA}`]: 'NVDA', [`robinhood:${AMKR}`]: 'AMKR' },
    preview: { status: 'OK', targetVersion: 2, requiresRebalance: true, orders, allocations: [], driftThresholdBps: 500, maxAbsDriftBps: 1000, navQuote: '100', quoteCurrency: 'USD' },
    ...over,
  };
}

function composer(produced: Record<string, { amountOut: string; amountOutMin: string }>) {
  const body = {
    data: {
      outputs: Object.fromEntries(Object.entries(produced).map(([k, v]) => [k, wireOut(v.amountOut, v.amountOutMin)])),
      transactionRequest: { to: '0x0a6baefc776477c494ab8b0a288881a7b72196f7', chainId: 4663, data: '0xdeadbeef', value: '0' },
      userProxy: '0x0a6baefc776477c494ab8b0a288881a7b72196f7',
      priceImpact: { inputValueUsd: 10, outputValueUsd: 9.97, impactBps: 30, unpricedInputs: [], unpricedOutputs: [] },
      approvals: [{ token: TSLA, spender: '0x0a6baefc776477c494ab8b0a288881a7b72196f7', amount: (BigInt(10) * E18).toString() }],
      fees: [{ token: TSLA, recipient: 'lifi', bps: 25, amount: '25' }],
    },
  };
  return vi.fn(async () => composeResponse(body)) as unknown as typeof fetch;
}
const run = (fetchImpl?: typeof fetch, opts: { noKey?: boolean } = {}) =>
  quoteRebalance({} as never, {} as never, {} as never, { userId: 'u', walletAddress: SIGNER }, 'b', { apiKey: opts.noKey ? undefined : 'k', fetchImpl });

beforeEach(() => load.mockReset());

describe('weightsFromValues', () => {
  it('splits by value into whole bps that sum to exactly 10000', () => {
    expect(weightsFromValues([BigInt(1), BigInt(1), BigInt(1)])).toEqual([3334, 3333, 3333]);
    expect(weightsFromValues([BigInt(3), BigInt(1)])).toEqual([7500, 2500]);
    expect(weightsFromValues([BigInt(1), BigInt(1_000_000)]).reduce((a, b) => a + b, 0)).toBe(10000);
  });
});

describe('quoteRebalance', () => {
  it('one sell, one buy: sells exactly the planned amount and reports the buy’s expected and minimum output, never the transaction', async () => {
    load.mockResolvedValue(loaded([order(TSLA, 'SELL', '10', (BigInt(10) * E18).toString()), order(NVDA, 'BUY', '10', (BigInt(10) * E18).toString())]));
    const f = composer({ 'rb_buy_0.amountOut': { amountOut: '9900000000000000000', amountOutMin: '9801000000000000000' } });
    const r = await run(f);
    expect(r).toMatchObject({
      ok: true,
      targetVersion: 2,
      shape: 'ONE_SELL',
      sells: [{ address: TSLA, symbol: 'TSLA', amountRaw: (BigInt(10) * E18).toString() }],
      buys: [{ address: NVDA, symbol: 'NVDA', weightBps: 10000, expectedOutRaw: '9900000000000000000', minOutRaw: '9801000000000000000' }],
      slippageBps: 100,
      priceImpactBps: 30,
      approvalsNeeded: 1,
    });
    expect(JSON.stringify(r)).not.toMatch(/deadbeef|transactionRequest|"data"/);
    const sent = String((f as unknown as { mock: { calls: [unknown, RequestInit][] } }).mock.calls[0][1].body);
    expect(sent).toContain((BigInt(10) * E18).toString());
  });

  it('splits the proceeds across several buys by planned value', async () => {
    load.mockResolvedValue(loaded([order(TSLA, 'SELL', '30', (BigInt(30) * E18).toString()), order(NVDA, 'BUY', '20', null), order(AMKR, 'BUY', '10', null)]));
    const r = await run(composer({ 'rb_buy_0.amountOut': { amountOut: '1', amountOutMin: '1' }, 'rb_buy_1.amountOut': { amountOut: '2', amountOutMin: '1' } }));
    expect(r.ok && r.buys.map((b) => [b.symbol, b.weightBps])).toEqual([
      ['NVDA', 6667],
      ['AMKR', 3333],
    ]);
  });

  it('refuses before calling LI.FI: no key, within tolerance, a preview that is not OK, a sell above what the wallet holds', async () => {
    const f = composer({});
    expect(await run(f, { noKey: true })).toMatchObject({ ok: false, status: 503 });
    expect(load).not.toHaveBeenCalled();
    load.mockResolvedValue(loaded([], { preview: { status: 'OK', requiresRebalance: false, orders: [] } }));
    expect(await run(f)).toMatchObject({ ok: false, status: 409 });
    load.mockResolvedValue(loaded([], { preview: { status: 'UNREADABLE_BALANCES' } }));
    expect(await run(f)).toMatchObject({ ok: false, status: 409 });
    load.mockResolvedValue(loaded([order(TSLA, 'SELL', '70', (BigInt(70) * E18).toString()), order(NVDA, 'BUY', '70', null)]));
    expect(await run(f)).toMatchObject({ ok: false, status: 409, error: expect.stringMatching(/more TSLA than your wallet holds/) });
    load.mockResolvedValue({ ok: false, status: 404, error: 'Bag not found.' });
    expect(await run(f)).toMatchObject({ ok: false, status: 404 });
    expect(f).not.toHaveBeenCalled();
  });
});
