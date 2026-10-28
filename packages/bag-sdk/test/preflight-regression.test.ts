import { describe, expect, it, vi } from 'vitest';
import { compileBag, hashBag, parseBag, ProviderResponseError, simulateBag, type BagDocument, type ComposerCompileRequest, type ComposerCompileResult, type ComposerProvider, type Hex } from '../src';
import { run } from '../examples/compile-purchase';
import { externalBag } from './helpers';

const A = '0xa0000000000000000000000000000000000000aa';
const INPUT = '0x' + 'c'.repeat(40);
const SIGNER = '0x' + '5'.repeat(40);
const ROUTER = '0x' + '7'.repeat(40);
const SPENDER = '0x' + '6'.repeat(40);
const CREATOR = '0x' + '1'.repeat(40);
const REGISTRY = '0x907cc27d644c8ea1c24b8320ad09ecf2819209a8' as Hex;
const ZERO32 = '0x' + '0'.repeat(64);
const TRUST = { chainId: 4663, allowedTransactionTargets: [ROUTER], allowedApprovalSpenders: [SPENDER] };

function bag(): BagDocument {
  const raw = externalBag();
  raw.definition.rules.minInvestment = null;
  delete raw.metadata;
  const parsed = parseBag(raw);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  return parsed.bag;
}

function provider(mutate: (r: ComposerCompileResult) => ComposerCompileResult = r => r): ComposerProvider {
  return { name: 'regression', compile: vi.fn(async (q: ComposerCompileRequest) => mutate({
    transaction: { to: ROUTER, data: '0x12345678', value: '0', chainId: q.chainId },
    executor: null, approvals: [{ token: q.inputToken, spender: SPENDER, amountRaw: String(q.amountRaw) }],
    legs: q.legs.map(l => ({ token: l.token, expectedOutRaw: '1000', minOutRaw: String(BigInt(1000) * BigInt(10_000 - q.slippageBps) / BigInt(10_000)) })),
    priceImpactBps: 0, gasLimit: null, fees: [],
  })) };
}

const request = { inputToken: INPUT, amountRaw: BigInt(1000), inputTokenDecimals: 6, signer: SIGNER };
const compile = (p = provider(), slippageBps = 100) => compileBag(bag(), { ...request, slippageBps }, { provider: p, trust: TRUST });

describe('purchase preflight regression checks (#118)', () => {
  it.each([
    ['990', 100], ['995', 50], ['999', 1],
  ])('accepts the exact floor %s at %i bps', async (minimum, slippageBps) => {
    const result = await compile(provider(r => ({ ...r, legs: r.legs.map(l => ({ ...l, minOutRaw: minimum })) })), slippageBps);
    expect(result.quote.legs[0].minOutRaw).toBe(minimum);
  });

  it.each([
    ['1000', '989'], ['1000', '1'], ['1000', '0'], ['1000', null],
    ['1000', '1001'], [null, '990'], ['0', '1'], ['1.5', '1'],
  ])('refuses an inconsistent/unbounded quote (estimate %s, minimum %s)', async (expectedOutRaw, minOutRaw) => {
    await expect(compile(provider(r => ({ ...r, legs: r.legs.map(l => ({ ...l, expectedOutRaw, minOutRaw })) })))).rejects.toBeInstanceOf(ProviderResponseError);
  });

  it('refuses a positive floor that ignores the tighter caller tolerance', async () => {
    await expect(compile(provider(r => ({ ...r, legs: r.legs.map(l => ({ ...l, minOutRaw: '990' })) })), 50)).rejects.toThrow(/configured slippage 50 bps/);
  });

  it('permits documented raw-unit floor rounding without using floating point', async () => {
    const result = await compile(provider(r => ({ ...r, legs: r.legs.map(l => ({ ...l, expectedOutRaw: '10', minOutRaw: '9' })) })));
    expect(result.quote.legs[0].minOutRaw).toBe('9');
  });

  it('compares outputs above the JavaScript safe-integer range exactly', async () => {
    const p = (minimum: string) => provider(r => ({ ...r, legs: r.legs.map(l => ({ ...l,
      expectedOutRaw: '1000000000000000000000000000000', minOutRaw: minimum,
    })) }));
    await expect(compile(p('990000000000000000000000000000'))).resolves.toBeDefined();
    await expect(compile(p('989999999999999999999999999999'))).rejects.toBeInstanceOf(ProviderResponseError);
  });

  it.each([600, 999])('requires the retained share when balance is %i of a 1000-unit budget', async balance => {
    const compiled = await compileBag(bag(), { ...request, inputToken: A, inputTokenDecimals: 18 }, { provider: provider(), trust: TRUST });
    expect(compiled.quote.plan.swapAmountRaw).toBe(BigInt(600));
    const client = { getChainId: async () => 4663,
      readContract: vi.fn(async () => BigInt(balance)), call: vi.fn(async () => ({})) };
    expect(await simulateBag(compiled, { client })).toEqual({ status: 'INSUFFICIENT_BALANCE', balanceRaw: BigInt(balance), requiredRaw: BigInt(1000) });
    expect(client.readContract).toHaveBeenCalledTimes(1);
    expect(client.call).not.toHaveBeenCalled();
  });

  it('accepts the full budget while requiring approval for only the swapped share', async () => {
    const compiled = await compileBag(bag(), { ...request, inputToken: A, inputTokenDecimals: 18 }, { provider: provider(), trust: TRUST });
    expect(compiled.approvals[0].amountRaw).toBe(BigInt(600));
    const client = { getChainId: async () => 4663,
      readContract: vi.fn(async ({ functionName }: { functionName: string }) => BigInt(functionName === 'balanceOf' ? 1000 : 600)),
      call: vi.fn(async () => ({})) };
    expect(await simulateBag(compiled, { client })).toEqual({ status: 'OK' });
    expect(client.call).toHaveBeenCalledTimes(1);
  });

  it.each(['wrong creator', 'wrong hash', 'missing record'])('stops the consumer before the provider on %s', async failure => {
    const raw = { ...bag(), ref: { strategyId: '33333333-3333-4333-8333-333333333333', version: 1, parentVersion: null, createdAt: '2026-10-06T00:00:00Z' } };
    const p = provider();
    const client = {
      getChainId: async () => 4663, getCode: async (): Promise<Hex> => '0x6000',
      readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
        if (functionName === 'decimals') return 18;
        if (functionName === 'strategyOf') return {
          creator: failure === 'wrong creator' ? SIGNER : failure === 'missing record' ? '0x' + '0'.repeat(40) : CREATOR,
          latestVersion: failure === 'missing record' ? 0 : 1, forkOfStrategyId: ZERO32, forkOfVersion: 0,
        };
        if (functionName === 'definitionHashOf') return failure === 'wrong hash' ? ZERO32 : hashBag(raw);
        throw new Error('Execution reads must not be reached');
      }),
      call: vi.fn(async () => ({})),
    };
    const report = await run({ source: 'fixture', readText: async () => JSON.stringify(raw), ...request,
      provider: p, allowedTransactionTargets: [ROUTER], allowedApprovalSpenders: [SPENDER], client,
      registry: { address: REGISTRY, expectedCreator: CREATOR } });
    expect(report.parse).toBe('ok');
    expect(report.validate).toBe('ok');
    expect(report.verify).toEqual(expect.arrayContaining([expect.objectContaining({ ok: false })]));
    expect(p.compile).not.toHaveBeenCalled();
    expect(client.call).not.toHaveBeenCalled();
    expect(report.quote).toBeUndefined();
    expect(report.unsignedTransaction).toBeUndefined();
  });
});
