import { describe, expect, it, vi } from 'vitest';
import {
  NATIVE_TOKEN,
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
const TRUST = { chainId: 4663, allowedTransactionTargets: [ROUTER], allowedApprovalSpenders: [SPENDER] } as const;

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
          legs: q.legs.map((l) => ({ token: l.token, recipient: q.signer, deliveryWhen: 'now', expectedOutRaw: '1000', minOutRaw: '990' })),
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
  it('exact target allocation, whole-bp legs, partition, limits, and the accounting boundary', () => {
    const plan = planPurchase(doc(), req());
    expect(plan.chainId).toBe(4663);
    expect(plan.kept).toBeNull();
    expect(plan.legs).toEqual([
      { token: A, targetInputRaw: BigInt(4_000_000), legBps: 4000 },
      { token: B, targetInputRaw: BigInt(6_000_000), legBps: 6000 },
    ]);
    expect(plan.swapAmountRaw).toBe(BigInt(10_000_000));
    expect(plan.partition).toEqual({ outerBps: [4000, 6000], groups: [{ legs: [0], innerBps: null }, { legs: [1], innerBps: null }] });
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
    expect(plan.partition).toEqual({ outerBps: [10000], groups: [{ legs: [0], innerBps: null }] });
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
    const compiled = await compileBag(doc(), req(), { provider, trust: TRUST });
    expect(compiled.transaction).toEqual({ to: ROUTER, data: '0x12345678abcdef', value: BigInt(0), chainId: 4663 });
    expect(compiled.approvals).toEqual([{ token: USDG, spender: SPENDER, amountRaw: BigInt(10_000_000) }]);
    expect(compiled.quote.legs.map((l) => l.minOutRaw)).toEqual(['990', '990']);
    expect(provider.requests[0]).toEqual({
      chainId: 4663, inputToken: USDG, inputKind: 'erc20', amountRaw: BigInt(10_000_000), signer: SIGNER, legs: [{ token: A, legBps: 4000 }, { token: B, legBps: 6000 }],
      slippageBps: 100, maxPriceImpactBps: 500,
    });
    const quote = await quoteBag(doc(), req(), { provider: fakeProvider(), trust: TRUST });
    expect(quote.priceImpactBps).toBe(12);
    expect('transaction' in quote).toBe(false);
  });

  it('refuses a provider answer that does not match the plan', async () => {
    const bad: [string, (r: ComposerCompileResult) => ComposerCompileResult][] = [
      ['chain', (r) => ({ ...r, transaction: { ...r.transaction, chainId: 1 } })],
      ['missing transaction chain', (r) => ({ ...r, transaction: { ...r.transaction, chainId: null } })],
      ['native value', (r) => ({ ...r, transaction: { ...r.transaction, value: '1' } })],
      ['approval token', (r) => ({ ...r, approvals: [{ token: A, spender: SPENDER, amountRaw: '1' }] })],
      ['approval amount', (r) => ({ ...r, approvals: [{ token: USDG, spender: SPENDER, amountRaw: '10000001' }] })],
      ['untrusted transaction target (checked after provider response)', (r) => ({ ...r, transaction: { ...r.transaction, to: '0x' + '9'.repeat(40) } })],
      ['untrusted approval spender (checked after provider response)', (r) => ({ ...r, approvals: [{ token: USDG, spender: '0x' + '9'.repeat(40), amountRaw: '10000000' }] })],
      ['leg token', (r) => ({ ...r, legs: [r.legs[1], r.legs[0]] })],
      ['leg count', (r) => ({ ...r, legs: [r.legs[0]] })],
      ['price impact above policy', (r) => ({ ...r, priceImpactBps: 501 })],
      ['missing price impact', (r) => ({ ...r, priceImpactBps: null })],
      ['non-finite price impact', (r) => ({ ...r, priceImpactBps: Number.NaN })],
      ['negative price impact', (r) => ({ ...r, priceImpactBps: -1 })],
      ['fractional price impact', (r) => ({ ...r, priceImpactBps: 1.5 })],
      ['missing output token', (r) => ({ ...r, legs: [{ ...r.legs[0], token: null }, r.legs[1]] })],
      ['missing output recipient', (r) => ({ ...r, legs: [{ ...r.legs[0], recipient: null }, r.legs[1]] })],
      ['wrong output recipient', (r) => ({ ...r, legs: [{ ...r.legs[0], recipient: '0x' + '9'.repeat(40) }, r.legs[1]] })],
      ['delayed output delivery', (r) => ({ ...r, legs: [{ ...r.legs[0], deliveryWhen: 'later' }, r.legs[1]] })],
      ['missing output minimum', (r) => ({ ...r, legs: [{ ...r.legs[0], minOutRaw: null }, r.legs[1]] })],
      ['zero output minimum', (r) => ({ ...r, legs: [{ ...r.legs[0], minOutRaw: '0' }, r.legs[1]] })],
      ['minimum above expected output', (r) => ({ ...r, legs: [{ ...r.legs[0], minOutRaw: '1001' }, r.legs[1]] })],
      ['zero approval amount', (r) => ({ ...r, approvals: [{ ...r.approvals[0], amountRaw: '0' }] })],
      ['duplicate approval spender', (r) => ({ ...r, approvals: [r.approvals[0], r.approvals[0]] })],
      ['odd-length transaction calldata', (r) => ({ ...r, transaction: { ...r.transaction, data: '0x123456789' } })],
      ['malformed executor', (r) => ({ ...r, executor: 'not-an-address' })],
      ['malformed gas limit', (r) => ({ ...r, gasLimit: '-1' })],
      ['malformed fee', (r) => ({ ...r, fees: [{ token: 'not-an-address', recipient: SIGNER, bps: 1, amountRaw: '1' }] })],
      ['malformed tx', (r) => ({ ...r, transaction: { ...r.transaction, to: 'nope' } })],
    ];
    for (const [name, mutate] of bad) {
      await expect(compileBag(doc(), req(), { provider: fakeProvider(mutate), trust: TRUST }), name).rejects.toBeInstanceOf(ProviderResponseError);
    }
  });

  it('requires an explicit chain-matched caller trust policy', async () => {
    const provider = fakeProvider();
    await expect(compileBag(doc(), req(), { provider } as never)).rejects.toThrow(/trust policy chain missing/);
    expect(provider.requests).toHaveLength(0);
    await expect(compileBag(doc(), req(), { provider, trust: { ...TRUST, allowedTransactionTargets: [] } })).rejects.toThrow(/at least one valid transaction target/);
    expect(provider.requests).toHaveLength(0);
    const wrongChainProvider = fakeProvider();
    await expect(compileBag(doc(), req(), { provider: wrongChainProvider, trust: { ...TRUST, chainId: 1 } })).rejects.toThrow(/does not match plan chain/);
    expect(wrongChainProvider.requests).toHaveLength(0);
  });

  it('calls the provider once, then rejects unallowlisted returned targets and spenders before returning a transaction', async () => {
    const untrustedTargetProvider = fakeProvider((r) => ({ ...r, transaction: { ...r.transaction, to: '0x' + '9'.repeat(40) } }));
    await expect(compileBag(doc(), req(), { provider: untrustedTargetProvider, trust: TRUST })).rejects.toThrow(/transaction target .* not in the caller's trusted target allowlist/);
    expect(untrustedTargetProvider.requests).toHaveLength(1);

    const untrustedSpenderProvider = fakeProvider((r) => ({ ...r, approvals: [{ token: USDG, spender: '0x' + '9'.repeat(40), amountRaw: '10000000' }] }));
    await expect(compileBag(doc(), req(), { provider: untrustedSpenderProvider, trust: TRUST })).rejects.toThrow(/approval spender .* not in the caller's trusted spender allowlist/);
    expect(untrustedSpenderProvider.requests).toHaveLength(1);
  });

  it('never calls the provider for a purchase it cannot plan', async () => {
    const provider = fakeProvider();
    await expect(compileBag(doc(), req({ slippageBps: 1000 }), { provider, trust: TRUST })).rejects.toBeInstanceOf(PurchasePlanError);
    expect(provider.requests).toHaveLength(0);
  });
});

describe('lifiComposer adapter (real @lifi/composer-sdk, network mocked at fetch)', () => {
  // A fresh copy per response: the SDK client converts amounts in place while parsing.
  function composeFetch(data: Record<string, unknown>) {
    const wire = JSON.stringify({ data });
    return vi.fn(async () => ({ ok: true, status: 200, headers: new Headers(), json: async () => JSON.parse(wire), text: async () => wire })) as unknown as typeof fetch;
  }
  const compileData = {
    outputs: {
      'swap_0.amountOut': { role: 'terminal', owner: SIGNER, delivery: { when: 'now' }, resource: { kind: 'erc20', token: A, chainId: 4663 }, amount: { estimate: { basis: 'simulated', value: '4000' }, minimum: { basis: 'op', value: '3960' } } },
      'swap_1.amountOut': { role: 'terminal', owner: SIGNER, delivery: { when: 'now' }, resource: { kind: 'erc20', token: B, chainId: 4663 }, amount: { estimate: { basis: 'simulated', value: '6000' }, minimum: { basis: 'op', value: '5940' } } },
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

  it('builds the partition/swap flow from the plan and maps the compile response', async () => {
    const fetchImpl = composeFetch(compileData);
    const compiled = await compileBag(doc(), req(), { provider: lifiComposer({ apiKey: 'test-key', baseUrl: 'https://composer.test', fetch: fetchImpl }), trust: TRUST });
    expect(compiled.transaction).toEqual({ to: ROUTER, data: '0xdeadbeef', value: BigInt(0), chainId: 4663 });
    expect(compiled.quote.legs.map((l) => [l.expectedOutRaw, l.minOutRaw])).toEqual([['4000', '3960'], ['6000', '5940']]);
    expect(compiled.quote.priceImpactBps).toBe(10);

    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls as [string, RequestInit][];
    const compose = calls.find(([url]) => String(url).endsWith('/compose'))!;
    const body = String(compose[1].body);
    expect(body).toContain('"bps":[4000,6000]'); // one core.partition by the legs' bps
    expect(body).not.toContain('core.split');
    expect(body).toContain('"maxPriceImpactBps":500');
    expect(body.toLowerCase()).toContain(SIGNER);
    expect(JSON.stringify(compose[1].headers)).toContain('test-key');
  });

  it('a price impact above the limit from the real adapter is refused', async () => {
    const fetchImpl = composeFetch({ ...compileData, priceImpact: { ...compileData.priceImpact, impactBps: 735 } });
    await expect(compileBag(doc(), req(), { provider: lifiComposer({ apiKey: 'k', baseUrl: 'https://composer.test', fetch: fetchImpl }), trust: TRUST })).rejects.toThrow(/735 bps is above the limit 500/);
  });

  it('refuses Composer output delivered to another recipient or deferred for later', async () => {
    const redirected = JSON.parse(JSON.stringify(compileData));
    redirected.outputs['swap_0.amountOut'].owner = '0x' + '9'.repeat(40);
    const wrongRecipientFetch = composeFetch(redirected);
    await expect(
      compileBag(doc(), req(), { provider: lifiComposer({ apiKey: 'k', baseUrl: 'https://composer.test', fetch: wrongRecipientFetch }), trust: TRUST }),
    ).rejects.toThrow(/output recipient .* does not match requested signer/);

    const deferred = JSON.parse(JSON.stringify(compileData));
    deferred.outputs['swap_0.amountOut'].delivery.when = 'later';
    const deferredFetch = composeFetch(deferred);
    await expect(
      compileBag(doc(), req(), { provider: lifiComposer({ apiKey: 'k', baseUrl: 'https://composer.test', fetch: deferredFetch }), trust: TRUST }),
    ).rejects.toThrow(/output is not reported as delivered now/);
  });
});

describe('simulateBag', () => {
  const client = (o: { chainId?: number; balance?: bigint; allowance?: bigint; revert?: string; targetNoCode?: boolean; spenderNoCode?: boolean } = {}): SimulationClient & { calls: number } => {
    const c = {
      calls: 0,
      getChainId: async () => o.chainId ?? 4663,
      getCode: async ({ address }: { address: `0x${string}` }) => {
        if (o.targetNoCode && address.toLowerCase() === ROUTER.toLowerCase()) return '0x' as `0x${string}`;
        if (o.spenderNoCode && address.toLowerCase() === SPENDER.toLowerCase()) return '0x' as `0x${string}`;
        return '0x60006000' as `0x${string}`;
      },
      readContract: async ({ functionName }: { functionName: string }) => (functionName === 'balanceOf' ? o.balance ?? BigInt(10_000_000) : o.allowance ?? BigInt(10_000_000)),
      call: async () => {
        c.calls++;
        if (o.revert) throw Object.assign(new Error(`${o.revert}\nURL: hidden`), { shortMessage: o.revert });
        return { data: '0x' };
      },
    };
    return c;
  };
  const compiled = () => compileBag(doc(), req(), { provider: fakeProvider(), trust: TRUST });

  it('OK when balance and approvals are in place and the call succeeds', async () => {
    expect(await simulateBag(await compiled(), { client: client() })).toEqual({ status: 'OK' });
  });

  it('does not report OK if the transaction target or approval spender has no contract code', async () => {
    expect(await simulateBag(await compiled(), { client: client({ targetNoCode: true }) })).toEqual({
      status: 'INVALID_TARGET',
      address: ROUTER,
    });
    expect(await simulateBag(await compiled(), { client: client({ spenderNoCode: true }) })).toEqual({
      status: 'INVALID_APPROVAL_SPENDER',
      spender: SPENDER,
    });
  });

  it('reports what is missing instead of a meaningless revert', async () => {
    expect(await simulateBag(await compiled(), { client: client({ balance: BigInt(1) }) })).toEqual({ status: 'INSUFFICIENT_BALANCE', balanceRaw: BigInt(1), requiredRaw: BigInt(10_000_000) });
    const c = client({ allowance: BigInt(0) });
    const r = await simulateBag(await compiled(), { client: c });
    expect(r.status).toBe('NEEDS_APPROVAL');
    expect(c.calls).toBe(0);
  });

  it('requires enough balance to preserve the retained input-token allocation', async () => {
    const bag = doc((d) => {
      d.definition.assets[1].address = USDG;
      delete d.metadata;
    });
    const purchase = await compileBag(bag, req(), { provider: fakeProvider(), trust: TRUST });
    // 7m covers the 6m swap amount, but not the 4m share that is supposed to remain in the wallet.
    expect(await simulateBag(purchase, { client: client({ balance: BigInt(7_000_000) }) })).toEqual({
      status: 'INSUFFICIENT_BALANCE',
      balanceRaw: BigInt(7_000_000),
      requiredRaw: BigInt(10_000_000),
    });
  });

  it('a revert is reported with its first line only; a wrong-chain client is refused', async () => {
    expect(await simulateBag(await compiled(), { client: client({ revert: 'execution reverted: TOO_LITTLE_RECEIVED' }) })).toEqual({ status: 'REVERTED', reason: 'execution reverted: TOO_LITTLE_RECEIVED' });
    await expect(simulateBag(await compiled(), { client: client({ chainId: 1 }) })).rejects.toThrow(/chain 1/);
  });
});

describe('native ETH input (the chain\'s native coin, paid as the transaction value)', () => {
  const ETH = NATIVE_TOKEN;
  const ethReq = (over: Record<string, unknown> = {}) => req({ inputToken: ETH, amountRaw: BigInt('1000000000000000'), ...over });
  /** A well-behaved provider for a native purchase: value = the swapped amount, no approval. */
  const nativeProvider = (override: (r: ComposerCompileResult, q: ComposerCompileRequest) => ComposerCompileResult = (r) => r) =>
    fakeProvider((r, q) => override({ ...r, transaction: { ...r.transaction, value: String(q.amountRaw) }, approvals: [] }, q));

  it('plans a native purchase: inputKind native, every asset swapped, same exact allocation as an ERC-20 deposit', () => {
    const plan = planPurchase(doc(), ethReq());
    expect(plan.inputKind).toBe('native');
    expect(plan.inputToken).toBe(ETH);
    expect(plan.kept).toBeNull();
    expect(plan.swapAmountRaw).toBe(BigInt('1000000000000000'));
    expect(plan.legs.map((l) => l.legBps)).toEqual([4000, 6000]);
    expect(planPurchase(doc(), req()).inputKind).toBe('erc20');
  });

  it('a strategy holding the native coin itself cannot be paid in it (nothing native is ever kept)', () => {
    const bag = doc((d) => {
      d.definition.assets[1].address = ETH;
      delete d.metadata;
    });
    expect(codes(() => planPurchase(bag, ethReq()))).toContain('NATIVE_INPUT_KEPT');
  });

  it('compiles: the provider is asked for a native input, and the unsigned transaction carries exactly the ETH as msg.value, no approval', async () => {
    const provider = nativeProvider();
    const compiled = await compileBag(doc(), ethReq(), { provider, trust: TRUST });
    expect(provider.requests[0]).toMatchObject({ inputToken: ETH, inputKind: 'native', amountRaw: BigInt('1000000000000000'), signer: SIGNER, chainId: 4663 });
    expect(compiled.transaction).toEqual({ to: ROUTER, data: '0x12345678abcdef', value: BigInt('1000000000000000'), chainId: 4663 });
    expect(compiled.approvals).toEqual([]);
  });

  it('msg.value must be exactly the swapped amount: more, less, or none is refused', async () => {
    for (const value of ['1000000000000001', '999999999999999', '0']) {
      const provider = nativeProvider((r) => ({ ...r, transaction: { ...r.transaction, value } }));
      await expect(compileBag(doc(), ethReq(), { provider, trust: TRUST })).rejects.toThrow(/must send exactly 1000000000000000 wei/);
    }
    // 0x-hex is accepted when it is the exact amount
    const hex = nativeProvider((r) => ({ ...r, transaction: { ...r.transaction, value: '0x38d7ea4c68000' } }));
    expect((await compileBag(doc(), ethReq(), { provider: hex, trust: TRUST })).transaction.value).toBe(BigInt('1000000000000000'));
  });

  it('a native purchase with any approval request is refused; an ERC-20 purchase that sends ETH still is', async () => {
    const withApproval = nativeProvider((r, q) => ({ ...r, approvals: [{ token: q.inputToken, spender: SPENDER, amountRaw: '1' }] }));
    await expect(compileBag(doc(), ethReq(), { provider: withApproval, trust: TRUST })).rejects.toThrow(/needs no approval/);
    const erc20WithValue = fakeProvider((r) => ({ ...r, transaction: { ...r.transaction, value: '5' } }));
    await expect(compileBag(doc(), req(), { provider: erc20WithValue, trust: TRUST })).rejects.toThrow(/must not send native value/);
  });

  it('chain, target, legs, slippage and minimum output stay checked for a native purchase', async () => {
    const wrongChain = nativeProvider((r) => ({ ...r, transaction: { ...r.transaction, chainId: 1 } }));
    await expect(compileBag(doc(), ethReq(), { provider: wrongChain, trust: TRUST })).rejects.toThrow(/chain 1 does not match plan chain 4663/);
    const wrongTarget = nativeProvider((r) => ({ ...r, transaction: { ...r.transaction, to: '0x' + '9'.repeat(40) } }));
    await expect(compileBag(doc(), ethReq(), { provider: wrongTarget, trust: TRUST })).rejects.toThrow(/not in the caller's trusted target allowlist/);
    const wrongLeg = nativeProvider((r) => ({ ...r, legs: [{ ...r.legs[0], token: '0x' + 'd'.repeat(40) }, r.legs[1]] }));
    await expect(compileBag(doc(), ethReq(), { provider: wrongLeg, trust: TRUST })).rejects.toThrow(/leg 0 delivers/);
    const badMin = nativeProvider((r) => ({ ...r, legs: r.legs.map((l) => ({ ...l, expectedOutRaw: '1000', minOutRaw: '1001' })) }));
    await expect(compileBag(doc(), ethReq(), { provider: badMin, trust: TRUST })).rejects.toThrow(/minimum output is above its expected output/);
    // slippage: the caller can only tighten, for native as for ERC-20
    expect(codes(() => planPurchase(doc(), ethReq({ slippageBps: 301 })))).toContain('LOOSER_THAN_POLICY');
    const tight = nativeProvider();
    await compileBag(doc(), ethReq({ slippageBps: 50 }), { provider: tight, trust: TRUST });
    expect(tight.requests[0].slippageBps).toBe(50);
  });

  it('the LI.FI adapter declares the native resource, sweeps outputs to the signer, and returns the exact value', async () => {
    const wire = JSON.stringify({
      data: {
        outputs: {
          'swap_0.amountOut': { role: 'terminal', owner: SIGNER, delivery: { when: 'now' }, resource: { kind: 'erc20', token: A, chainId: 4663 }, amount: { estimate: { basis: 'simulated', value: '4000' }, minimum: { basis: 'op', value: '3960' } } },
          'swap_1.amountOut': { role: 'terminal', owner: SIGNER, delivery: { when: 'now' }, resource: { kind: 'erc20', token: B, chainId: 4663 }, amount: { estimate: { basis: 'simulated', value: '6000' }, minimum: { basis: 'op', value: '5940' } } },
        },
        transactionRequest: { to: ROUTER, chainId: 4663, data: '0xdeadbeef', value: '1000000000000000' },
        userProxy: '0x' + '8'.repeat(40),
        approvals: [],
        fees: [],
      },
    });
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, headers: new Headers(), json: async () => JSON.parse(wire), text: async () => wire })) as unknown as typeof fetch;
    const compiled = await compileBag(doc(), ethReq(), { provider: lifiComposer({ apiKey: 'k', baseUrl: 'https://composer.test', fetch: fetchImpl }), trust: TRUST });
    expect(compiled.transaction.value).toBe(BigInt('1000000000000000'));
    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls as [string, RequestInit][];
    const body = JSON.parse(String(calls.find(([url]) => String(url).endsWith('/compose'))![1].body));
    expect(body.flow.inputs[0].resource).toEqual({ kind: 'native', chainId: 4663 });
    expect(body.run.inputs.amountIn).toEqual({ kind: 'directDeposit', amount: '1000000000000000' });
    expect(body.run.sweepTo).toEqual({ $ref: 'context.sender' }); // recipient: every output back to the signer
    expect(body.run.signer.toLowerCase()).toBe(SIGNER);
  });

  it('simulateBag reads the native balance (getBalance), never an ERC-20 allowance', async () => {
    const compiled = await compileBag(doc(), ethReq(), { provider: nativeProvider(), trust: TRUST });
    let readContractCalls = 0;
    let callValue: bigint | undefined;
    const client = (balance: bigint): SimulationClient => ({
      getChainId: async () => 4663,
      getBalance: async () => balance,
      readContract: async () => {
        readContractCalls++;
        return BigInt(0);
      },
      call: async (a) => {
        callValue = a.value;
        return { data: '0x' };
      },
    });
    expect(await simulateBag(compiled, { client: client(BigInt('2000000000000000')) })).toEqual({ status: 'OK' });
    expect(callValue).toBe(BigInt('1000000000000000'));
    expect(readContractCalls).toBe(0);
    expect(await simulateBag(compiled, { client: client(BigInt(1)) })).toEqual({ status: 'INSUFFICIENT_BALANCE', balanceRaw: BigInt(1), requiredRaw: BigInt('1000000000000000') });
    const noBalance = { getChainId: async () => 4663, readContract: async () => BigInt(0), call: async () => ({}) } as SimulationClient;
    await expect(simulateBag(compiled, { client: noBalance })).rejects.toThrow(/getBalance/);
  });
});
