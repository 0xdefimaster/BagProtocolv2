import { describe, expect, it, vi } from 'vitest';
import { buildComposerRebalance, ComposerIneligibleError, rebalanceShape } from '../lifi-composer-adapter';

// Same HTTP-boundary mocking as lifi-composer-sweep.test.ts: the real @lifi/composer-sdk builds and serializes the
// flow, only Composer's response is fake.

const A = '0x00000000000000000000000000000000000000a1';
const B = '0x00000000000000000000000000000000000000b2';
const C = '0x00000000000000000000000000000000000000c3';
const D = '0x00000000000000000000000000000000000000d4';
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const SIGNER = '0x49da000000000000000000000000000000fe46';
const SPENDER = '0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae';

function composeFetch(data: Record<string, unknown> = {}) {
  const body = { data: { producedResources: {}, transactionRequest: { to: SPENDER, chainId: 4663, data: '0xdeadbeef', value: '0' }, userProxy: '0xUserProxy', ...data } };
  return vi.fn(async () => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) })) as unknown as typeof fetch;
}
const sentBody = (f: typeof fetch) => String((f as unknown as { mock: { calls: [unknown, RequestInit][] } }).mock.calls[0][1].body);
const base = { chain: 'robinhood' as const, hubTokenAddress: USDG, signerAddress: SIGNER, slippageBps: 100, apiKey: 'k' };
const sell = (address: string, amountRaw = '1000') => ({ address, amountRaw, symbol: address.slice(-2) });
const buy = (address: string, weightBps: number) => ({ address, weightBps, symbol: address.slice(-2) });

describe('buildComposerRebalance', () => {
  it('picks the shortest shape', () => {
    expect(rebalanceShape(1, 3)).toBe('ONE_SELL');
    expect(rebalanceShape(3, 1)).toBe('ONE_BUY');
    expect(rebalanceShape(1, 1)).toBe('ONE_SELL');
    expect(rebalanceShape(2, 2)).toBe('HUB');
  });

  it('one sell: splits it straight across the buys, no hub swap', async () => {
    const f = composeFetch();
    const r = await buildComposerRebalance({ ...base, sells: [sell(A)], buys: [buy(B, 6000), buy(C, 4000)], fetchImpl: f });
    const body = sentBody(f);
    expect(r.shape).toBe('ONE_SELL');
    expect(body).toContain('rb_split_0');
    expect(body).toContain('rb_buy_0');
    expect(body).toContain('rb_buy_1');
    expect(body).not.toContain('rb_sell_');
    expect(body.toLowerCase()).not.toContain(USDG.toLowerCase());
    expect(r.transactionRequest).toMatchObject({ to: SPENDER, value: '0', chainId: 4663 });
  });

  it('one buy: every sell swaps straight into it', async () => {
    const f = composeFetch();
    const r = await buildComposerRebalance({ ...base, sells: [sell(A), sell(B)], buys: [buy(C, 10000)], fetchImpl: f });
    const body = sentBody(f);
    expect(r.shape).toBe('ONE_BUY');
    expect(body).toContain('rb_sell_0');
    expect(body).toContain('rb_sell_1');
    expect(body).not.toContain('rb_merge_');
    expect(body.toLowerCase()).not.toContain(USDG.toLowerCase());
  });

  it('many to many: sells into the hub, merges, splits across the buys', async () => {
    const f = composeFetch();
    const r = await buildComposerRebalance({ ...base, sells: [sell(A), sell(B)], buys: [buy(C, 5000), buy(D, 5000)], fetchImpl: f });
    const body = sentBody(f);
    expect(r.shape).toBe('HUB');
    for (const id of ['rb_sell_0', 'rb_sell_1', 'rb_merge_1', 'rb_split_0', 'rb_buy_0', 'rb_buy_1']) expect(body).toContain(id);
    expect(body.toLowerCase()).toContain(USDG.toLowerCase());
  });

  it('accepts approvals only for tokens sold, never above the amount sold, and never native ETH', async () => {
    const ok = await buildComposerRebalance({ ...base, sells: [sell(A)], buys: [buy(B, 10000)], fetchImpl: composeFetch({ approvals: [{ token: A, spender: SPENDER, amount: '1000' }] }) });
    expect(ok.approvals).toEqual([{ token: A, spender: SPENDER, amountRaw: '1000' }]);
    await expect(buildComposerRebalance({ ...base, sells: [sell(A)], buys: [buy(B, 10000)], fetchImpl: composeFetch({ approvals: [{ token: B, spender: SPENDER, amount: '1' }] }) })).rejects.toThrow(/not being sold/);
    await expect(buildComposerRebalance({ ...base, sells: [sell(A)], buys: [buy(B, 10000)], fetchImpl: composeFetch({ approvals: [{ token: A, spender: SPENDER, amount: '1001' }] }) })).rejects.toThrow(/above what is being sold/);
    await expect(
      buildComposerRebalance({ ...base, sells: [sell(A)], buys: [buy(B, 10000)], fetchImpl: composeFetch({ transactionRequest: { to: SPENDER, chainId: 4663, data: '0x', value: '1' } }) })
    ).rejects.toThrow(/native ETH/);
  });

  it('rejects bad trades before calling LI.FI', async () => {
    const f = composeFetch();
    await expect(buildComposerRebalance({ ...base, sells: [sell(A)], buys: [buy(A, 10000)], fetchImpl: f })).rejects.toThrow(/both sold and bought/);
    await expect(buildComposerRebalance({ ...base, sells: [sell(A), sell(A)], buys: [buy(B, 10000)], fetchImpl: f })).rejects.toThrow(/sold twice/);
    await expect(buildComposerRebalance({ ...base, sells: [sell(A, '0')], buys: [buy(B, 10000)], fetchImpl: f })).rejects.toThrow(/positive/);
    await expect(buildComposerRebalance({ ...base, sells: [sell(A)], buys: [buy(B, 6000), buy(C, 3000)], fetchImpl: f })).rejects.toThrow(/10000/);
    await expect(buildComposerRebalance({ ...base, sells: [sell(A), sell(USDG)], buys: [buy(C, 5000), buy(D, 5000)], fetchImpl: f })).rejects.toThrow(/hub stablecoin/);
    await expect(buildComposerRebalance({ ...base, sells: [], buys: [buy(B, 10000)], fetchImpl: f })).rejects.toBeInstanceOf(ComposerIneligibleError);
    expect(f).not.toHaveBeenCalled();
  });
});
