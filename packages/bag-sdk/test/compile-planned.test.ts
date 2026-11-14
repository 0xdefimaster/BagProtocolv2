import { describe, expect, it } from 'vitest';
import {
  BagSdkError,
  compilePlannedPurchase,
  NATIVE_TOKEN,
  ProviderResponseError,
  type ComposerCompileRequest,
  type ComposerCompileResult,
  type ComposerProvider,
  type PlannedComposerPurchase,
} from '../src';

// compilePlannedPurchase: an application's own plan (BAG App's allocation, its leg order) through the SAME provider
// call and response checks as compileBag. The trust policy comes from the caller's reviewed deployment config; the
// provider response never widens it.

const A = '0xa0000000000000000000000000000000000000aa';
const B = '0xb0000000000000000000000000000000000000bb';
const USDG = '0x' + 'c'.repeat(40);
const SIGNER = '0x' + '5'.repeat(40);
const SPENDER = '0x' + '6'.repeat(40);
const ROUTER = '0x' + '7'.repeat(40);
const EVIL = '0x' + 'e'.repeat(40);
const TRUST = { chainId: 4663, allowedTransactionTargets: [ROUTER], allowedApprovalSpenders: [SPENDER] };

const planned = (over: Partial<PlannedComposerPurchase> = {}): PlannedComposerPurchase => ({
  chainId: 4663,
  inputToken: USDG,
  inputKind: 'erc20',
  signer: SIGNER,
  swapAmountRaw: BigInt(10_000_000),
  // Caller's order (B before A): kept as given, not re-sorted.
  legs: [
    { token: B, targetInputRaw: BigInt(6_000_000), legBps: 6000 },
    { token: A, targetInputRaw: BigInt(4_000_000), legBps: 4000 },
  ],
  slippageBps: 100,
  maxPriceImpactBps: 300,
  definitionHash: null,
  ...over,
});

function provider(override: (r: ComposerCompileResult, q: ComposerCompileRequest) => ComposerCompileResult = (r) => r): ComposerProvider & { requests: ComposerCompileRequest[] } {
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
          legs: q.legs.map((l) => ({ token: l.token, expectedOutRaw: '1000', minOutRaw: String((BigInt(1000) * BigInt(10_000 - q.slippageBps)) / BigInt(10_000)) })),
          priceImpactBps: 12,
          gasLimit: '400000',
          fees: [],
        },
        q
      );
    },
  };
}

const compile = (p: PlannedComposerPurchase, prov = provider(), trust: typeof TRUST = TRUST) => compilePlannedPurchase(p, { provider: prov, trust });
async function rejects(p: Promise<unknown>, code?: string) {
  const e = await p.then(
    () => null,
    (x) => x
  );
  expect(e).toBeInstanceOf(ProviderResponseError);
  if (code) expect(e.code).toBe(code);
}

describe('compilePlannedPurchase', () => {
  it("sends the caller's legs in the caller's order with its limits, and returns the checked compile", async () => {
    const prov = provider();
    const out = await compile(planned(), prov);
    expect(prov.requests).toHaveLength(1);
    const q = prov.requests[0];
    expect(q.chainId).toBe(4663);
    expect(q.inputToken).toBe(USDG);
    expect(q.amountRaw).toBe(BigInt(10_000_000));
    expect(q.legs.map((l) => l.token)).toEqual([B, A]);
    expect(q.slippageBps).toBe(100);
    expect(out.transaction.to).toBe(ROUTER);
    expect(out.quote.legs.map((l) => l.token)).toEqual([B, A]);
    expect(out.quote.plan.accounting).toBe('NOT_BAG_ACCOUNTED');
    expect(out.quote.plan.kept).toBeNull();
    expect(out.quote.plan.definitionHash).toBe('0x' + '0'.repeat(64));
  });

  it('carries a caller-supplied definition hash unchanged', async () => {
    const h = ('0x' + '1f'.repeat(32)) as `0x${string}`;
    expect((await compile(planned({ definitionHash: h }))).quote.plan.definitionHash).toBe(h);
  });

  describe('adversarial provider responses are refused (same checks as compileBag)', () => {
    it('a transaction target outside the reviewed allowlist', async () => {
      await rejects(compile(planned(), provider((r) => ({ ...r, transaction: { ...r.transaction, to: EVIL } }))));
    });
    it('an approval spender outside the reviewed allowlist', async () => {
      await rejects(compile(planned(), provider((r) => ({ ...r, approvals: [{ ...r.approvals[0], spender: EVIL }] }))), 'UNTRUSTED_SPENDER');
    });
    it('an approval for a token other than the input', async () => {
      await rejects(compile(planned(), provider((r) => ({ ...r, approvals: [{ ...r.approvals[0], token: A }] }))), 'APPROVAL_INVALID');
    });
    it('an approval larger than the swapped amount', async () => {
      await rejects(compile(planned(), provider((r) => ({ ...r, approvals: [{ ...r.approvals[0], amountRaw: '10000001' }] }))), 'APPROVAL_INVALID');
    });
    it('a leg delivering a different token, or legs reordered', async () => {
      await rejects(compile(planned(), provider((r) => ({ ...r, legs: [{ ...r.legs[0], token: EVIL }, r.legs[1]] }))), 'OUTPUT_INVALID');
      await rejects(compile(planned(), provider((r) => ({ ...r, legs: [r.legs[1], r.legs[0]] }))), 'OUTPUT_INVALID');
    });
    it('a missing leg', async () => {
      await rejects(compile(planned(), provider((r) => ({ ...r, legs: [r.legs[0]] }))));
    });
    it('a minimum below the slippage floor', async () => {
      await rejects(compile(planned(), provider((r) => ({ ...r, legs: r.legs.map((l) => ({ ...l, minOutRaw: '1' })) }))));
    });
    it('a wrong chain or a native value on an ERC-20 purchase', async () => {
      await rejects(compile(planned(), provider((r) => ({ ...r, transaction: { ...r.transaction, chainId: 1 } }))));
      await rejects(compile(planned(), provider((r) => ({ ...r, transaction: { ...r.transaction, value: '1' } }))));
    });
    it("a price impact above the caller's limit", async () => {
      await rejects(compile(planned({ maxPriceImpactBps: 10 }), provider((r) => ({ ...r, priceImpactBps: 11 }))));
    });
    it('malformed responses', async () => {
      await rejects(compile(planned(), provider((r) => ({ ...r, transaction: { ...r.transaction, data: 'not-hex' as `0x${string}` } }))));
      await rejects(compile(planned(), provider((r) => ({ ...r, legs: r.legs.map((l) => ({ ...l, minOutRaw: '-5' })) }))));
      await rejects(compile(planned(), provider(() => null as unknown as ComposerCompileResult)));
    });
  });

  it('a native-input plan expects the value to equal the swapped amount', async () => {
    const native = planned({ inputToken: NATIVE_TOKEN, inputKind: 'native' });
    const ok = provider((r, q) => ({ ...r, approvals: [], transaction: { ...r.transaction, value: String(q.amountRaw) } }));
    expect((await compile(native, ok)).transaction.value).toBe(BigInt(10_000_000));
    await rejects(compile(native, provider((r) => ({ ...r, approvals: [], transaction: { ...r.transaction, value: '0' } }))));
  });

  describe('invalid caller plans never reach the provider', () => {
    const cases: [string, Partial<PlannedComposerPurchase>][] = [
      ['shares not summing to 10000', { legs: [{ token: A, targetInputRaw: BigInt(1), legBps: 4000 }] }],
      ['duplicate leg tokens', { legs: [{ token: A, targetInputRaw: BigInt(1), legBps: 5000 }, { token: A, targetInputRaw: BigInt(1), legBps: 5000 }] }],
      ['mixed-case leg token', { legs: [{ token: '0xA0000000000000000000000000000000000000AA', targetInputRaw: BigInt(1), legBps: 10_000 }] }],
      ['zero swap amount', { swapAmountRaw: BigInt(0) }],
      ['no legs', { legs: [] }],
      ['bad signer', { signer: '0x1234' }],
      ['bad slippage', { slippageBps: 10_000 }],
      ['bad definition hash', { definitionHash: '0x12' as `0x${string}` }],
    ];
    for (const [name, over] of cases) {
      it(name, async () => {
        const prov = provider();
        const e = await compile(planned(over), prov).then(
          () => null,
          (x) => x
        );
        expect(e).toBeInstanceOf(BagSdkError);
        expect(prov.requests).toHaveLength(0);
      });
    }
  });

  it('an empty or wrong-chain trust policy refuses before calling the provider', async () => {
    const prov = provider();
    await expect(compile(planned(), prov, { ...TRUST, allowedTransactionTargets: [] })).rejects.toBeInstanceOf(BagSdkError);
    await expect(compile(planned(), prov, { ...TRUST, chainId: 1 })).rejects.toBeInstanceOf(BagSdkError);
    expect(prov.requests).toHaveLength(0);
  });
});
