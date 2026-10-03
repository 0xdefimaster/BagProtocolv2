import { describe, expect, it, vi } from 'vitest';
import {
  buildComposerPurchase,
  computeCascadeSplitBps,
  ComposerIneligibleError,
  composerLegEnforcedMinOutputRaw,
  composerLegSimulatedOutputRaw,
  isComposerEligible,
} from '../lifi-composer-adapter';

// -----------------------------------------------------------------------------
// Mocks fetch at the HTTP boundary (fetchImpl injection), not the SDK
// itself — this exercises the real @lifi/composer-sdk flow-building and
// request serialization code, only faking the network response. The mock
// response shape below is copied from node_modules/@lifi/composer-sdk/dist
// /client.js's own parsing code (parseCompileSuccessBody: `{ data: {...} }`
// envelope; producedResources[*].simulated.amountOut must be a numeric
// STRING on the wire, the client converts it to bigint) — not guessed.
// -----------------------------------------------------------------------------

function mockComposeFetch(overrides: Partial<{ status: number; body: unknown }> = {}) {
  const status = overrides.status ?? 200;
  const body =
    overrides.body ??
    {
      data: {
        producedResources: {
          swap_0: { kind: 'erc20', chainId: 1, token: '0xTargetA', availability: 'now', owner: '0xSigner', simulated: { amountOut: '600000' } },
          swap_1: { kind: 'erc20', chainId: 1, token: '0xTargetB', availability: 'now', owner: '0xSigner', simulated: { amountOut: '400000' } },
        },
        transactionRequest: { to: '0xComposerVM', chainId: 1, data: '0xdeadbeef', value: '0' },
        userProxy: '0xUserProxy',
      },
    };
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  })) as unknown as typeof fetch;
}

describe('isComposerEligible', () => {
  it('accepts ethereum/base/arbitrum/robinhood with at least one leg', () => {
    expect(isComposerEligible('ethereum', [{ address: '0xa', weightBps: 10000, symbol: 'A' }])).toBe(true);
    expect(isComposerEligible('base', [{ address: '0xa', weightBps: 10000, symbol: 'A' }])).toBe(true);
    expect(isComposerEligible('arbitrum', [{ address: '0xa', weightBps: 10000, symbol: 'A' }])).toBe(true);
    expect(isComposerEligible('robinhood', [{ address: '0xa', weightBps: 10000, symbol: 'A' }])).toBe(true);
  });

  it('rejects solana — Composer is EVM-only per docs.li.fi', () => {
    expect(isComposerEligible('solana', [{ address: 'abc', weightBps: 10000, symbol: 'A' }])).toBe(false);
  });

  it('rejects zero legs', () => {
    expect(isComposerEligible('ethereum', [])).toBe(false);
  });
});

describe('computeCascadeSplitBps', () => {
  it('computes a single relative bps for a 2-leg 60/40 split', () => {
    const legs = [
      { address: '0xa', weightBps: 6000, symbol: 'A' },
      { address: '0xb', weightBps: 4000, symbol: 'B' },
    ];
    // Only N-1 = 1 split step; the last leg needs no split.
    expect(computeCascadeSplitBps(legs)).toEqual([6000]);
  });

  it('recomputes each step relative to the REMAINING pool, not the original total, for a 3-leg 50/30/20 split', () => {
    const legs = [
      { address: '0xa', weightBps: 5000, symbol: 'A' },
      { address: '0xb', weightBps: 3000, symbol: 'B' },
      { address: '0xc', weightBps: 2000, symbol: 'C' },
    ];
    // Step 1: 5000/10000 = 5000 bps of the original pool.
    // Step 2: remaining pool is 5000 bps; leg B wants 3000 of the
    // original 10000, i.e. 3000/5000 = 6000 bps of what's LEFT.
    // Leg C (last) needs no split — it just takes what remains.
    expect(computeCascadeSplitBps(legs)).toEqual([5000, 6000]);
  });

  it('throws if weights do not sum to exactly 10000 bps, rather than silently normalizing', () => {
    const legs = [
      { address: '0xa', weightBps: 5000, symbol: 'A' },
      { address: '0xb', weightBps: 4000, symbol: 'B' },
    ];
    expect(() => computeCascadeSplitBps(legs)).toThrow(/sum to exactly 10000/);
  });

  it('returns an empty array for a single leg (no split needed at all)', () => {
    expect(computeCascadeSplitBps([{ address: '0xa', weightBps: 10000, symbol: 'A' }])).toEqual([]);
  });
});

describe('buildComposerPurchase', () => {
  const baseRequest = {
    chain: 'ethereum' as const,
    inputTokenAddress: '0xInputToken',
    inputAmountRaw: '1000000',
    signerAddress: '0xSigner',
    slippageBps: 100,
    apiKey: 'test-key',
  };

  it('throws ComposerIneligibleError for an ineligible chain instead of building a broken flow', async () => {
    await expect(
      buildComposerPurchase({
        ...baseRequest,
        chain: 'solana' as unknown as 'ethereum',
        legs: [{ address: '0xa', weightBps: 10000, symbol: 'A' }],
      })
    ).rejects.toThrow(ComposerIneligibleError);
  });

  it('sends an accepted price-impact limit to Composer, and none by default', async () => {
    const legs = [{ address: '0xTargetA', weightBps: 10000, symbol: 'A' }];
    const withLimit = vi.fn(mockComposeFetch());
    await buildComposerPurchase({ ...baseRequest, legs, fetchImpl: withLimit, maxPriceImpactBps: 651 });
    const sent = JSON.stringify((withLimit.mock.calls as unknown as [unknown, RequestInit][])[0][1].body);
    expect(sent).toContain('maxPriceImpactBps');
    expect(sent).toContain('651');

    const byDefault = vi.fn(mockComposeFetch());
    await buildComposerPurchase({ ...baseRequest, legs, fetchImpl: byDefault });
    expect(JSON.stringify((byDefault.mock.calls as unknown as [unknown, RequestInit][])[0][1].body)).not.toContain('maxPriceImpactBps');
  });

  it('compiles a multi-leg flow and returns transactionRequest + userProxy + producedResources', async () => {
    const fetchImpl = mockComposeFetch();
    const result = await buildComposerPurchase({
      ...baseRequest,
      fetchImpl,
      legs: [
        { address: '0xTargetA', weightBps: 6000, symbol: 'A' },
        { address: '0xTargetB', weightBps: 4000, symbol: 'B' },
      ],
    });

    expect(result.transactionRequest).toEqual({
      to: '0xComposerVM',
      data: '0xdeadbeef',
      value: '0',
      chainId: 1,
    });
    expect(result.userProxy).toBe('0xUserProxy');
    expect(result.producedResources.swap_0.simulated?.amountOut).toBe(BigInt(600000));
    expect(result.producedResources.swap_1.simulated?.amountOut).toBe(BigInt(400000));

    // Exactly one POST to /compose — one signature's worth of work, not N.
    const composeCalls = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls.filter((call: unknown[]) =>
      String(call[0]).endsWith('/compose')
    );
    expect(composeCalls).toHaveLength(1);
  });

  it('passes through gasLimit/priceImpact/fees from the compile response when the server includes them (checkpoint 4b)', async () => {
    const fetchImpl = mockComposeFetch({
      body: {
        data: {
          producedResources: {
            swap_0: { kind: 'erc20', chainId: 1, token: '0xTargetA', availability: 'now', owner: '0xSigner', simulated: { amountOut: '600000' } },
          },
          transactionRequest: { to: '0xComposerVM', chainId: 1, data: '0xdeadbeef', value: '0', gasLimit: '210000' },
          userProxy: '0xUserProxy',
          priceImpact: { inputValueUsd: 1000, outputValueUsd: 998.5, impactBps: 15, unpricedInputs: [], unpricedOutputs: [] },
          fees: [{ input: 'amountIn', token: '0xInputToken', recipient: 'lifi', recipientAddress: '0xFeeRecipient', bps: 10, amount: '1000' }],
        },
      },
    });
    const result = await buildComposerPurchase({
      ...baseRequest,
      fetchImpl,
      legs: [{ address: '0xTargetA', weightBps: 10000, symbol: 'A' }],
    });

    expect(result.gasLimitRaw).toBe('210000');
    expect(result.priceImpact).toEqual({ inputValueUsd: 1000, outputValueUsd: 998.5, impactBps: 15, unpricedInputs: [], unpricedOutputs: [] });
    expect(result.fees).toEqual([{ token: '0xInputToken', recipient: 'lifi', bps: 10, amount: '1000' }]);
  });

  describe('approvals the wallet must send first', () => {
    const SPENDER = '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE';
    const withApprovals = (approvals: unknown[]) =>
      mockComposeFetch({
        body: {
          data: {
            producedResources: {
              swap_0: { kind: 'erc20', chainId: 1, token: '0xTargetA', availability: 'now', owner: '0xSigner', simulated: { amountOut: '600000' } },
            },
            transactionRequest: { to: '0xComposerVM', chainId: 1, data: '0xdeadbeef', value: '0' },
            userProxy: '0xUserProxy',
            approvals,
          },
        },
      });
    const approve = (token: string, amount: string) => ({ token, spender: SPENDER, amount, transactionRequest: { to: token, data: '0x', value: '0' } });
    const legs = [{ address: '0xTargetA', weightBps: 10000, symbol: 'A' }];

    it('passes through an input-token approval', async () => {
      const result = await buildComposerPurchase({ ...baseRequest, legs, fetchImpl: withApprovals([approve('0xInputToken', '1000000')]) });
      expect(result.approvals).toEqual([{ token: '0xInputToken', spender: SPENDER, amountRaw: '1000000' }]);
    });

    it('returns no approvals when the allowance already covers the spend', async () => {
      const result = await buildComposerPurchase({ ...baseRequest, legs, fetchImpl: mockComposeFetch() });
      expect(result.approvals).toEqual([]);
    });

    it('refuses an approval for any other token', async () => {
      await expect(buildComposerPurchase({ ...baseRequest, legs, fetchImpl: withApprovals([approve('0xSomethingElse', '1')]) })).rejects.toThrow(/not the purchase's input token/);
    });

    it('refuses an approval above the purchase input', async () => {
      await expect(buildComposerPurchase({ ...baseRequest, legs, fetchImpl: withApprovals([approve('0xInputToken', '1000001')]) })).rejects.toThrow(/amount above/);
    });
  });

  it('never fabricates gasLimit/priceImpact when the compile response omits them — null/empty, not a guess', async () => {
    // baseRequest's default mockComposeFetch() response (no gasLimit/priceImpact/fees keys at all).
    const fetchImpl = mockComposeFetch();
    const result = await buildComposerPurchase({
      ...baseRequest,
      fetchImpl,
      legs: [
        { address: '0xTargetA', weightBps: 6000, symbol: 'A' },
        { address: '0xTargetB', weightBps: 4000, symbol: 'B' },
      ],
    });

    expect(result.gasLimitRaw).toBeNull();
    expect(result.priceImpact).toBeNull();
    expect(result.fees).toEqual([]);
  });

  it('sends the API key as x-lifi-api-key and hits the production composer.li.quest base URL by default', async () => {
    const fetchImpl = mockComposeFetch();
    await buildComposerPurchase({
      ...baseRequest,
      fetchImpl,
      legs: [{ address: '0xTargetA', weightBps: 10000, symbol: 'A' }],
    });

    const [url, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(url)).toBe('https://composer.li.quest/compose');
    expect((init.headers as Record<string, string>)['x-lifi-api-key']).toBe('test-key');
  });

  it('throws with the server-reported reason on a partial/reverted compile result, rather than returning a half-built transaction', async () => {
    const fetchImpl = mockComposeFetch({
      status: 206,
      body: {
        data: {
          producedResources: {},
          transactionRequest: { to: '0xComposerVM', chainId: 1, data: '0x', value: '0' },
          userProxy: '0xUserProxy',
        },
        error: { kind: 'SIMULATION_REVERTED', message: 'insufficient liquidity' },
      },
    });

    await expect(
      buildComposerPurchase({
        ...baseRequest,
        fetchImpl,
        legs: [{ address: '0xTargetA', weightBps: 10000, symbol: 'A' }],
      })
    ).rejects.toThrow(/insufficient liquidity/);
  });
});

describe('composerLegEnforcedMinOutputRaw', () => {
  // Shape of the live compile response (scripts/spike/composer-min-output-probe.ts
  // run on Robinhood Chain): keyed by output port, bigint amounts.
  const live = {
    'swap_0.amountOut': { kind: 'erc20', token: '0xcashcat', chainId: 4663, availability: 'now', owner: '0xwallet', simulated: { amountOut: BigInt('1976415459627212722'), amountOutMin: BigInt('1956937756416111525') } },
    'swap_1.amountOut': { kind: 'erc20', token: '0xhii', chainId: 4663, availability: 'now', owner: '0xwallet', simulated: { amountOut: BigInt('1234444823130025'), amountOutMin: BigInt('1222279288915906') } },
    'swap_2.amountOut': { kind: 'erc20', token: '0xklac', chainId: 4663, availability: 'now', owner: '0xwallet', simulated: { amountOut: BigInt('1742455756559971'), amountOutMin: BigInt('1725283741476082') } },
  } as unknown as Parameters<typeof composerLegEnforcedMinOutputRaw>[0];

  it('reads each leg\'s own amountOutMin from its swap_<i>.amountOut entry', () => {
    expect([0, 1, 2].map((i) => composerLegEnforcedMinOutputRaw(live, i))).toEqual([
      '1956937756416111525',
      '1222279288915906',
      '1725283741476082',
    ]);
  });

  it('returns null (never a guess) when the leg or its amountOutMin is missing', () => {
    expect(composerLegEnforcedMinOutputRaw(live, 3)).toBeNull();
    const noMin = { 'swap_0.amountOut': { simulated: { amountOut: BigInt(5) } } } as unknown as Parameters<typeof composerLegEnforcedMinOutputRaw>[0];
    expect(composerLegEnforcedMinOutputRaw(noMin, 0)).toBeNull();
  });

  it('reads each leg\'s simulated amountOut from the same port-keyed entry', () => {
    expect([0, 1, 2].map((i) => composerLegSimulatedOutputRaw(live, i))).toEqual(['1976415459627212722', '1234444823130025', '1742455756559971']);
    expect(composerLegSimulatedOutputRaw(live, 3)).toBeNull();
  });

  it('does not read a node-keyed entry (swap_0) — the live API keys by output port', () => {
    const nodeKeyed = { swap_0: { simulated: { amountOut: BigInt(5), amountOutMin: BigInt(4) } } } as unknown as Parameters<typeof composerLegEnforcedMinOutputRaw>[0];
    expect(composerLegEnforcedMinOutputRaw(nodeKeyed, 0)).toBeNull();
  });
});

