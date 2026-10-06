import { describe, expect, it, vi } from 'vitest';
import {
  compileBag,
  parseBag,
  planPurchase,
  PurchasePlanError,
  ProviderResponseError,
  quoteBag,
  simulateBag,
  splitByWeight,
  V1_EXECUTION_POLICY,
  type BagDocument,
  type ComposerCompileRequest,
  type ComposerCompileResult,
  type ComposerProvider,
  type SimulationClient,
} from '../src';
import { lifiComposer } from '../src/adapters/lifi';
import { externalBag } from './helpers';

const A = '0xa0000000000000000000000000000000000000aa';
const B = '0xb0000000000000000000000000000000000000bb';
const USDG = '0x' + 'c'.repeat(40);
const SIGNER = '0x' + '5'.repeat(40);
const SPENDER = '0x' + '6'.repeat(40);
const ROUTER = '0x' + '7'.repeat(40);

const doc = (mutate: (d: any) => void = () => {}): BagDocument => {
  const raw = externalBag();
  mutate(raw);
  const r = parseBag(raw);
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.bag;
};
const req = (over: Record<string, unknown> = {}) => ({ inputToken: USDG, amountRaw: BigInt(10_000_000), signer: SIGNER, ...over });
const codes = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof PurchasePlanError) return e.issues.map((i) => i.code);
    throw e;
  }
  return [];
};

/** A well-behaved provider: echoes the plan's legs, approves exactly the swapped amount. */
function fakeProvider(override: (r: ComposerCompileResult, q: ComposerCompileRequest) => ComposerCompileResult = (r) => r): ComposerProvider & { requests: ComposerCompileRequest[] } {
  const requests: ComposerCompileRequest[] = [];
  return {
    name: 'fake',
    requests,
    async compile(q) {
      requests.push(q);
      return override(
        {
          transaction: { to: ROUTER, data: '0x12345678abcdef', value: '0', chainId: q.chainId },
          executor: '0x' + '8'.repeat(40),
          approvals: [{ token: q.inputToken, spender: SPENDER, amountRaw: String(q.amountRaw) }],
          legs: q.legs.map((l) => ({ token: l.token, expectedOutRaw: '1000', minOutRaw: '990' })),
          priceImpactBps: 12,
          gasLimit: '400000',
          fees: [],
        },
        q
      );
    },
  };
}

describe('planPurchase', () => {
  it('exact target allocation, whole-bp legs, cascade, limits, and the accounting boundary', () => {
    const plan = planPurchase(doc(), req());
    expect(plan.chainId).toBe(4663);
    expect(plan.kept).toBeNull();
    expect(plan.legs).toEqual([
      { token: A, targetInputRaw: BigInt(4_000_000), legBps: 4000 },
      { token: B, targetInputRaw: BigInt(6_000_000), legBps: 6000 },
    ]);
    expect(plan.swapAmountRaw).toBe(BigInt(10_000_000));
    expect(plan.cascadeSplitBps).toEqual([4000]);
    expect(plan.slippageBps).toBe(100); // declared
    expect(plan.maxPriceImpactBps).toBe(V1_EXECUTION_POLICY.maxPriceImpactBps);
    expect(plan.accounting).toBe('NOT_BAG_ACCOUNTED');
    expect(plan.definitionHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('an asset that IS the input token is kept, not swapped', () => {
    const bag = doc((d) => {
      d.definition.assets[1].address = USDG;
      delete d.metadata;
    });
    const plan = planPurchase(bag, req());
    expect(plan.kept).toEqual({ token: USDG, amountRaw: BigInt(4_000_000) });
    expect(plan.legs).toEqual([{ token: '0xb0000000000000000000000000000000000000bb', targetInputRaw: BigInt(6_000_000), legBps: 10000 }]);
    expect(plan.swapAmountRaw).toBe(BigInt(6_000_000));
    expect(plan.cascadeSplitBps).toEqual([]);
  });

  it('slippage: declared, capped at 300, default 100 for null; a caller can only tighten', () => {
    expect(planPurchase(doc((d) => (d.definition.rules.swapSlippageBps = 500)), req()).slippageBps).toBe(300);
    expect(planPurchase(doc((d) => (d.definition.rules.swapSlippageBps = null)), req()).slippageBps).toBe(100);
    expect(planPurchase(doc(), req({ slippageBps: 50 })).slippageBps).toBe(50);
    expect(codes(() => planPurchase(doc(), req({ slippageBps: 150 })))).toEqual(['LOOSER_THAN_POLICY']);
  });

  it('price impact: 500 bps by default; a caller can only tighten', () => {
    expect(planPurchase(doc(), req({ maxPriceImpactBps: 200 })).maxPriceImpactBps).toBe(200);
    expect(codes(() => planPurchase(doc(), req({ maxPriceImpactBps: 501 })))).toEqual(['LOOSER_THAN_POLICY']);
  });

  it('refuses an invalid strategy, a bad request, a token outside the caller allowlist, and dust', () => {
    expect(codes(() => planPurchase(doc((d) => (d.definition.assets[0].weightBps = 3000)), req()))).toEqual(['WEIGHTS_NOT_100']);
    expect(codes(() => planPurchase(doc(), req({ inputToken: 'USDG', signer: '0x1', amountRaw: BigInt(0) })))).toEqual(['INVALID_INPUT_TOKEN', 'INVALID_SIGNER', 'INVALID_AMOUNT']);
    expect(codes(() => planPurchase(doc(), req({ allowedTokens: [A] })))).toEqual(['TOKEN_NOT_ALLOWED']);
    expect(codes(() => planPurchase(doc(), req({ amountRaw: BigInt(1) })))).toContain('AMOUNT_TOO_SMALL');
  });

  it('legs follow the exact target (cross-checked with splitByWeight)', () => {
    const bag = doc();
    const amount = BigInt(1_234_567_891);
    const plan = planPurchase(bag, req({ amountRaw: amount }));
    const target = splitByWeight(amount, bag.definition);
    for (const l of plan.legs) expect(l.targetInputRaw).toBe(target.get(`robinhood:${l.token}`));
    expect(plan.legs.reduce((s, l) => s + l.legBps, 0)).toBe(10000);
  });
});

describe('compileBag / quoteBag', () => {
  it('returns an unsigned transaction and the quote; sends the provider exactly the plan', async () => {
    const provider = fakeProvider();
    const compiled = await compileBag(doc(), req(), { provider });
    expect(compiled.transaction).toEqual({ to: ROUTER, data: '0x12345678abcdef', value: BigInt(0), chainId: 4663 });
    expect(compiled.approvals).toEqual([{ token: USDG, spender: SPENDER, amountRaw: BigInt(10_000_000) }]);
    expect(compiled.quote.legs.map((l) => l.minOutRaw)).toEqual(['990', '990']);
    expect(provider.requests[0]).toEqual({
      chainId: 4663, inputToken: USDG, amountRaw: BigInt(10_000_000), signer: SIGNER, legs: [{ token: A }, { token: B }],
      cascadeSplitBps: [4000], slippageBps: 100, maxPriceImpactBps: 500,
    });
    const quote = await quoteBag(doc(), req(), { provider: fakeProvider() });
    expect(quote.priceImpactBps).toBe(12);
    expect('transaction' in quote).toBe(false);
  });

  it('refuses a provider answer that does not match the plan', async () => {
    const bad: [string, (r: ComposerCompileResult) => ComposerCompileResult][] = [
      ['chain', (r) => ({ ...r, transaction: { ...r.transaction, chainId: 1 } })],
      ['native value', (r) => ({ ...r, transaction: { ...r.transaction, value: '1' } })],
      ['approval token', (r) => ({ ...r, approvals: [{ token: A, spender: SPENDER, amountRaw: '1' }] })],
      ['approval amount', (r) => ({ ...r, approvals: [{ token: USDG, spender: SPENDER, amountRaw: '10000001' }] })],
      ['leg token', (r) => ({ ...r, legs: [r.legs[1], r.legs[0]] })],
      ['leg count', (r) => ({ ...r, legs: [r.legs[0]] })],
      ['price impact', (r) => ({ ...r, priceImpactBps: 501 })],
      ['malformed tx', (r) => ({ ...r, transaction: { ...r.transaction, to: 'nope' } })],
    ];
    for (const [name, mutate] of bad) {
      await expect(compileBag(doc(), req(), { provider: fakeProvider(mutate) }), name).rejects.toBeInstanceOf(ProviderResponseError);
    }
  });

  it('never calls the provider for a purchase it cannot plan', async () => {
    const provider = fakeProvider();
    await expect(compileBag(doc(), req({ slippageBps: 1000 }), { provider })).rejects.toBeInstanceOf(PurchasePlanError);
    expect(provider.requests).toHaveLength(0);
  });
});

describe('lifiComposer adapter (real @lifi/composer-sdk, network mocked at fetch)', () => {
  // A fresh copy per response: the SDK client converts amounts in place while parsing.
  function composeFetch(data: Record<string, unknown>) {
    const wire = JSON.stringify({ data });
    return vi.fn(async () => ({ ok: true, status: 200, json: async () => JSON.parse(wire), text: async () => wire })) as unknown as typeof fetch;
  }
  const compileData = {
    producedResources: {
      'swap_0.amountOut': { kind: 'erc20', chainId: 4663, token: A, availability: 'now', owner: SIGNER, simulated: { amountOut: '4000', amountOutMin: '3960' } },
      'swap_1.amountOut': { kind: 'erc20', chainId: 4663, token: B, availability: 'now', owner: SIGNER, simulated: { amountOut: '6000', amountOutMin: '5940' } },
    },
    transactionRequest: { to: ROUTER, chainId: 4663, data: '0xdeadbeef', value: '0', gasLimit: '500000' },
    userProxy: '0x' + '8'.repeat(40),
    priceImpact: { inputValueUsd: 10, outputValueUsd: 9.99, impactBps: 10, unpricedInputs: [], unpricedOutputs: [] },
    approvals: [{ token: USDG, spender: SPENDER, amount: '10000000', transactionRequest: { to: USDG, data: '0x', value: '0' } }],
    fees: [],
  };

  it('requires the caller’s own API key', () => {
    expect(() => lifiComposer({ apiKey: '', baseUrl: 'https://composer.test' })).toThrow(/apiKey/);
    expect(() => lifiComposer({ apiKey: 'k', baseUrl: '' })).toThrow(/baseUrl/);
  });

  it('builds the split/swap flow from the plan and maps the compile response', async () => {
    const fetchImpl = composeFetch(compileData);
    const compiled = await compileBag(doc(), req(), { provider: lifiComposer({ apiKey: 'test-key', baseUrl: 'https://composer.test', fetch: fetchImpl }) });
    expect(compiled.transaction).toEqual({ to: ROUTER, data: '0xdeadbeef', value: BigInt(0), chainId: 4663 });
    expect(compiled.quote.legs.map((l) => [l.expectedOutRaw, l.minOutRaw])).toEqual([['4000', '3960'], ['6000', '5940']]);
    expect(compiled.quote.priceImpactBps).toBe(10);

    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls as [string, RequestInit][];
    const compose = calls.find(([url]) => String(url).endsWith('/compose'))!;
    const body = String(compose[1].body);
    expect(body).toContain('"bps":4000'); // the cascade split
    expect(body).toContain('"maxPriceImpactBps":500');
    expect(body.toLowerCase()).toContain(SIGNER);
    expect(JSON.stringify(compose[1].headers)).toContain('test-key');
  });

  it('a price impact above the limit from the real adapter is refused', async () => {
    const fetchImpl = composeFetch({ ...compileData, priceImpact: { ...compileData.priceImpact, impactBps: 735 } });
    await expect(compileBag(doc(), req(), { provider: lifiComposer({ apiKey: 'k', baseUrl: 'https://composer.test', fetch: fetchImpl }) })).rejects.toThrow(/735 bps is above the limit 500/);
  });
});

describe('simulateBag', () => {
  const client = (o: { chainId?: number; balance?: bigint; allowance?: bigint; revert?: string } = {}): SimulationClient & { calls: number } => {
    const c = {
      calls: 0,
      getChainId: async () => o.chainId ?? 4663,
      readContract: async ({ functionName }: { functionName: string }) => (functionName === 'balanceOf' ? o.balance ?? BigInt(10_000_000) : o.allowance ?? BigInt(10_000_000)),
      call: async () => {
        c.calls++;
        if (o.revert) throw Object.assign(new Error(`${o.revert}\nURL: hidden`), { shortMessage: o.revert });
        return { data: '0x' };
      },
    };
    return c;
  };
  const compiled = () => compileBag(doc(), req(), { provider: fakeProvider() });

  it('OK when balance and approvals are in place and the call succeeds', async () => {
    expect(await simulateBag(await compiled(), { client: client() })).toEqual({ status: 'OK' });
  });

  it('reports what is missing instead of a meaningless revert', async () => {
    expect(await simulateBag(await compiled(), { client: client({ balance: BigInt(1) }) })).toEqual({ status: 'INSUFFICIENT_BALANCE', balanceRaw: BigInt(1), requiredRaw: BigInt(10_000_000) });
    const c = client({ allowance: BigInt(0) });
    const r = await simulateBag(await compiled(), { client: c });
    expect(r.status).toBe('NEEDS_APPROVAL');
    expect(c.calls).toBe(0);
  });

  it('a revert is reported with its first line only; a wrong-chain client is refused', async () => {
    expect(await simulateBag(await compiled(), { client: client({ revert: 'execution reverted: TOO_LITTLE_RECEIVED' }) })).toEqual({ status: 'REVERTED', reason: 'execution reverted: TOO_LITTLE_RECEIVED' });
    await expect(simulateBag(await compiled(), { client: client({ chainId: 1 }) })).rejects.toThrow(/chain 1/);
  });
});
