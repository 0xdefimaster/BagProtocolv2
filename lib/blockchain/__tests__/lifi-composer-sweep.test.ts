import { describe, expect, it, vi } from 'vitest';
import { buildComposerSweep, ComposerIneligibleError, composerPortAmounts } from '../lifi-composer-adapter';
import { composeResponse, wireOut } from './composer-fixtures';

// Same HTTP-boundary mocking as lifi-composer-adapter.test.ts: the real
// @lifi/composer-sdk builds and serializes the flow, only the response is fake.

const A = '0x00000000000000000000000000000000000000a1';
const B = '0x00000000000000000000000000000000000000b2';
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const SIGNER = '0x49da000000000000000000000000000000fe46';
const SPENDER = '0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae';

function composeFetch(data: Record<string, unknown> = {}) {
  const body = {
    data: {
      outputs: {
        'sweep_0.amountOut': wireOut('1500000', '1485000', USDG),
        'sweep_1.amountOut': wireOut('500000', '495000', USDG),
      },
      transactionRequest: { to: SPENDER, chainId: 4663, data: '0xdeadbeef', value: '0' },
      userProxy: '0xUserProxy',
      ...data,
    },
  };
  return vi.fn(async () => composeResponse(body)) as unknown as typeof fetch;
}

const base = {
  chain: 'robinhood' as const,
  outputTokenAddress: USDG,
  signerAddress: SIGNER,
  slippageBps: 100,
  apiKey: 'test-key',
};

const twoInputs = [
  { address: A, amountRaw: '1000', symbol: 'AAA' },
  { address: B, amountRaw: '2000', symbol: 'BBB' },
];

describe('buildComposerSweep', () => {
  it('sells every input into the output token in one flow, each through its own swap (slippage → amountOutMin)', async () => {
    const fetchImpl = composeFetch();
    const result = await buildComposerSweep({ ...base, inputs: twoInputs, fetchImpl });

    const sent = String((fetchImpl as unknown as { mock: { calls: [unknown, RequestInit][] } }).mock.calls[0][1].body);
    expect(sent).toContain('sweep_0');
    expect(sent).toContain('sweep_1');
    expect(sent.toLowerCase()).toContain(A);
    expect(sent.toLowerCase()).toContain(B);
    expect(result.transactionRequest).toMatchObject({ to: SPENDER, data: '0xdeadbeef', value: '0', chainId: 4663 });
    expect(composerPortAmounts(result.outputs, 'sweep_1.amountOut').min).toBe('495000');
  });

  it('accepts approvals only for tokens being sold, never above the amount sold', async () => {
    const ok = await buildComposerSweep({ ...base, inputs: twoInputs, fetchImpl: composeFetch({ approvals: [{ token: A, spender: SPENDER, amount: '1000' }] }) });
    expect(ok.approvals).toEqual([{ token: A, spender: SPENDER, amountRaw: '1000' }]);

    await expect(
      buildComposerSweep({ ...base, inputs: twoInputs, fetchImpl: composeFetch({ approvals: [{ token: USDG, spender: SPENDER, amount: '1' }] }) })
    ).rejects.toThrow(/not being sold/);
    await expect(
      buildComposerSweep({ ...base, inputs: twoInputs, fetchImpl: composeFetch({ approvals: [{ token: B, spender: SPENDER, amount: '2001' }] }) })
    ).rejects.toThrow(/above what is being sold/);
  });

  it('refuses a transaction that would also spend native ETH', async () => {
    await expect(
      buildComposerSweep({ ...base, inputs: twoInputs, fetchImpl: composeFetch({ transactionRequest: { to: SPENDER, chainId: 4663, data: '0x', value: '1' } }) })
    ).rejects.toThrow(/native ETH/);
  });

  it('rejects selling the output token, duplicates, zero amounts and ineligible chains before calling LI.FI', async () => {
    const fetchImpl = composeFetch();
    await expect(buildComposerSweep({ ...base, inputs: [{ address: USDG, amountRaw: '1', symbol: 'USDG' }], fetchImpl })).rejects.toThrow(/output token/);
    await expect(buildComposerSweep({ ...base, inputs: [twoInputs[0], twoInputs[0]], fetchImpl })).rejects.toThrow(/twice/);
    await expect(buildComposerSweep({ ...base, inputs: [{ address: A, amountRaw: '0', symbol: 'AAA' }], fetchImpl })).rejects.toThrow(/positive/);
    await expect(buildComposerSweep({ ...base, chain: 'solana', inputs: twoInputs, fetchImpl })).rejects.toBeInstanceOf(ComposerIneligibleError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('passes an accepted price-impact limit to Composer', async () => {
    const fetchImpl = composeFetch();
    await buildComposerSweep({ ...base, inputs: twoInputs, maxPriceImpactBps: 800, fetchImpl });
    expect(String((fetchImpl as unknown as { mock: { calls: [unknown, RequestInit][] } }).mock.calls[0][1].body)).toContain('"maxPriceImpactBps":800');
  });

  it('native output: every swap sells into the chain\'s native token, the stablecoin can be an input, and no ETH is sent in', async () => {
    const fetchImpl = composeFetch();
    const result = await buildComposerSweep({ ...base, nativeOutput: true, inputs: [...twoInputs, { address: USDG, amountRaw: '3000', symbol: 'USDG' }], fetchImpl });
    const sent = JSON.parse(String((fetchImpl as unknown as { mock: { calls: [unknown, RequestInit][] } }).mock.calls[0][1].body));
    const swaps = (sent.flow?.nodes ?? sent.nodes ?? []).filter((n: { id: string }) => n.id.startsWith('sweep_'));
    expect(swaps).toHaveLength(3);
    for (const n of swaps) expect(JSON.stringify(n.config.resourceOut)).toMatch(/native/);
    expect(JSON.stringify(sent).toLowerCase()).not.toContain(`"token":"${USDG.toLowerCase()}","chainid":4663},"slippage"`);
    expect(result.transactionRequest.value).toBe('0');
  });
});


describe('buildComposerSweep — unroutable tokens (preparation_error)', () => {
  const prepError = (failedOps: { callId: string; kind: string; message: string }[]) =>
    composeResponse({ error: { kind: 'preparation_error', message: `${failedOps.length} of 2 prepared op(s) failed`, failedOps: failedOps.map((op) => ({ op: 'lifi.swap', ...op })), succeededOps: [] } }, 422);
  const okBody = {
    data: {
      outputs: { 'sweep_0.amountOut': wireOut('1500000', '1485000', USDG) },
      transactionRequest: { to: SPENDER, chainId: 4663, data: '0xbeef', value: '0' },
      userProxy: '0xUserProxy',
    },
  };

  it('with skipUnroutable, drops the token with no route, recompiles once and reports it as skipped', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(prepError([{ callId: 'sweep_1', kind: 'resolution_rejected', message: 'No available quotes' }]))
      .mockResolvedValueOnce(composeResponse(okBody)) as unknown as typeof fetch;
    const result = await buildComposerSweep({ ...base, inputs: twoInputs, fetchImpl, skipUnroutable: true });
    expect(result.kept.map((k) => k.symbol)).toEqual(['AAA']);
    expect(result.skipped).toEqual([{ index: 1, address: B, symbol: 'BBB', reason: 'No available quotes' }]);
    const second = String((fetchImpl as unknown as { mock: { calls: [unknown, RequestInit][] } }).mock.calls[1][1].body).toLowerCase();
    expect(second).toContain(A);
    expect(second).not.toContain(B);
  });

  it('without skipUnroutable (Bag redemptions, settlements) the whole sale is refused, naming the token', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(prepError([{ callId: 'sweep_1', kind: 'resolution_rejected', message: 'No available quotes' }])) as unknown as typeof fetch;
    await expect(buildComposerSweep({ ...base, inputs: twoInputs, fetchImpl })).rejects.toThrow(/^BBB: No available quotes/);
    expect((fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(1);
  });

  it('an upstream outage (resolution_error) is not a dead route: nothing is dropped', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(prepError([{ callId: 'sweep_1', kind: 'resolution_error', message: 'upstream timeout' }])) as unknown as typeof fetch;
    await expect(buildComposerSweep({ ...base, inputs: twoInputs, fetchImpl, skipUnroutable: true })).rejects.toThrow(/upstream timeout/);
  });

  it('when every token is unroutable, the original error is thrown (no empty sale)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      prepError([
        { callId: 'sweep_0', kind: 'resolution_rejected', message: 'No available quotes' },
        { callId: 'sweep_1', kind: 'resolution_rejected', message: 'No available quotes' },
      ])
    ) as unknown as typeof fetch;
    await expect(buildComposerSweep({ ...base, inputs: twoInputs, fetchImpl, skipUnroutable: true })).rejects.toThrow(/AAA: No available quotes; BBB/);
  });
});
