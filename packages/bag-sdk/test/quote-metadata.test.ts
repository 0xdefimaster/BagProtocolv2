import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { compileBag, parseBag, ProviderResponseError, quoteBag, simulateBag, type ComposerCompileRequest, type ComposerCompileResult, type ComposerProvider, type Hex } from '../src';
import { lifiComposer } from '../src/adapters/lifi';
import { run } from '../examples/compile-purchase';
import { externalBag } from './helpers';

const NOW = 1_800_000_000_000;
const INPUT = '0x' + 'c'.repeat(40);
const SIGNER = '0x' + '5'.repeat(40);
const ROUTER = '0x' + '7'.repeat(40);
const SPENDER = '0x' + '6'.repeat(40);
const RECIPIENT = '0x' + '9'.repeat(40);
const TRUST = { chainId: 4663, allowedTransactionTargets: [ROUTER], allowedApprovalSpenders: [SPENDER] };
const REQUEST = { inputToken: INPUT, amountRaw: BigInt(1000), inputTokenDecimals: 6, signer: SIGNER };

function document() {
  const raw = externalBag();
  raw.definition.rules.minInvestment = null;
  delete raw.metadata;
  const parsed = parseBag(raw);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  return parsed.bag;
}

function provider(mutate: (r: ComposerCompileResult) => ComposerCompileResult = r => r): ComposerProvider {
  return { name: 'metadata-fixture', async compile(q: ComposerCompileRequest) { return mutate({
    transaction: { to: ROUTER, data: '0x12345678', value: '0', chainId: q.chainId },
    executor: null, approvals: [{ token: q.inputToken, spender: SPENDER, amountRaw: String(q.amountRaw) }],
    legs: q.legs.map(l => ({ token: l.token, expectedOutRaw: '1000', minOutRaw: '990' })),
    priceImpactBps: 0, gasLimit: null, fees: [],
  }); } };
}
const compile = (p = provider()) => compileBag(document(), REQUEST, { provider: p, trust: TRUST });
function client() {
  return { getChainId: vi.fn(async () => 4663), getCode: vi.fn(async (): Promise<Hex> => '0x6000'),
    readContract: vi.fn(async ({ functionName }: { functionName: string }) => functionName === 'decimals' ? 18 : BigInt(1000)),
    call: vi.fn(async () => ({ data: '0x' })),
  };
}
const fee = () => ({ token: INPUT, recipient: 'integrator', recipientAddress: RECIPIENT, bps: 12.5, amountRaw: '17' });
const warning = () => ({ kind: 'UPSTREAM_NOTICE', message: 'Review the route', path: 'flow.swap_0', port: 'amountOut', fix: 'Recompile if needed' });

function wireData(): Record<string, unknown> {
  const bag = document();
  return { outputs: Object.fromEntries(bag.definition.assets.slice().sort((a, b) => a.address.toLowerCase().localeCompare(b.address.toLowerCase())).map((asset, i) => [
    `swap_${i}.amountOut`, { role: 'terminal', owner: SIGNER, delivery: { when: 'now' },
      resource: { kind: 'erc20', token: asset.address, chainId: 4663 },
      amount: { estimate: { basis: 'simulated', value: '1000' }, minimum: { basis: 'op', value: '990' } } },
  ])), transactionRequest: { to: ROUTER, data: '0x12345678', value: '0', chainId: 4663 }, userProxy: SPENDER,
  approvals: [], priceImpact: { impactBps: 0, inputValueUsd: 1, outputValueUsd: 1, unpricedInputs: [], unpricedOutputs: [] },
  fill: { spends: [], validUntilMs: NOW + 30_000 },
  fees: [{ input: 'amountIn', token: INPUT, recipient: 'integrator', recipientAddress: RECIPIENT, bps: 12.5, amount: '17' }],
  warnings: [{ ...warning(), extra: 'must not be forwarded' }] };
}
function adapter(data: Record<string, unknown>) {
  const wire = JSON.stringify({ data });
  return lifiComposer({ apiKey: 'fixture-only', baseUrl: 'https://composer.test',
    fetch: vi.fn(async () => new Response(wire, { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch });
}

beforeEach(() => { vi.spyOn(Date, 'now').mockReturnValue(NOW); });
afterEach(() => { vi.restoreAllMocks(); });

describe('quote metadata and preflight freshness (#119)', () => {
  it('preserves Composer deadlines, actual fee addresses and every declared warning field', async () => {
    const result = await compile(adapter(wireData()));
    expect(result.quote).toMatchObject({ requestedAtMs: NOW, receivedAtMs: NOW, validUntilMs: NOW + 30_000 });
    expect(result.quote.fees).toEqual([fee()]);
    expect(result.quote.warnings).toEqual([warning()]);
    expect(JSON.stringify(result.quote.warnings)).not.toContain('must not be forwarded');
  });

  it('keeps old custom providers compatible and does not infer an address from a role', async () => {
    const result = await quoteBag(document(), REQUEST, { provider: provider(r => ({ ...r, fees: [{ token: INPUT, recipient: 'integrator', bps: 10, amountRaw: null }] })), trust: TRUST });
    expect(result.validUntilMs).toBeNull();
    expect(result.warnings).toEqual([]);
    expect(result.fees[0]).toMatchObject({ recipient: 'integrator', recipientAddress: null, amountRaw: null });
  });

  it('copies fee and warning data rather than retaining mutable provider objects', async () => {
    const originalFee = fee(); const originalWarning = warning();
    const result = await compile(provider(r => ({ ...r, fees: [originalFee], warnings: [originalWarning] })));
    originalFee.recipientAddress = ROUTER; originalWarning.message = 'changed later';
    expect(result.quote.fees[0].recipientAddress).toBe(RECIPIENT);
    expect(result.quote.warnings[0].message).toBe('Review the route');
  });

  it('records request/response times separately and includes provider latency in local age', async () => {
    const result = await compile(provider(r => { vi.mocked(Date.now).mockReturnValue(NOW + 1000); return r; }));
    expect(result.quote).toMatchObject({ requestedAtMs: NOW, receivedAtMs: NOW + 1000, validUntilMs: null });
    vi.mocked(Date.now).mockReturnValue(NOW + 2000);
    const rpc = client();
    expect(await simulateBag(result, { client: rpc, maxQuoteAgeMs: 1500 })).toMatchObject({ status: 'QUOTE_EXPIRED', source: 'LOCAL_MAX_AGE', expiresAtMs: NOW + 1500 });
    expect(rpc.getChainId).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 'soon'])('refuses malformed provider deadline %s', async validUntilMs => {
    await expect(compile(provider(r => ({ ...r, validUntilMs: validUntilMs as number })))).rejects.toBeInstanceOf(ProviderResponseError);
  });

  it.each([NOW - 1, NOW])('refuses a response already expired at %i', async validUntilMs => {
    await expect(compile(provider(r => ({ ...r, validUntilMs })))).rejects.toThrow(/quote expired/);
  });

  it('refuses a deadline that elapses while waiting for the provider', async () => {
    await expect(compile(provider(r => { vi.mocked(Date.now).mockReturnValue(NOW + 100); return { ...r, validUntilMs: NOW + 50 }; }))).rejects.toThrow(/quote expired/);
  });

  it.each(['before reads', 'during reads', 'during call'])('never reports OK when the quote expires %s', async phase => {
    const result = await compile(provider(r => ({ ...r, validUntilMs: NOW + 100 })));
    const rpc = client();
    if (phase === 'before reads') vi.mocked(Date.now).mockReturnValue(NOW + 100);
    if (phase === 'during reads') rpc.readContract.mockImplementation(async () => { vi.mocked(Date.now).mockReturnValue(NOW + 100); return BigInt(1000); });
    if (phase === 'during call') rpc.call.mockImplementation(async () => { vi.mocked(Date.now).mockReturnValue(NOW + 100); return { data: '0x' }; });
    expect(await simulateBag(result, { client: rpc })).toEqual({ status: 'QUOTE_EXPIRED', source: 'PROVIDER', expiresAtMs: NOW + 100, checkedAtMs: NOW + 100 });
    if (phase === 'before reads') expect(rpc.getChainId).not.toHaveBeenCalled();
    if (phase !== 'during call') expect(rpc.call).not.toHaveBeenCalled();
  });

  it.each([
    [100, 500, 'PROVIDER', 100], [500, 100, 'LOCAL_MAX_AGE', 100], [null, 100, 'LOCAL_MAX_AGE', 100],
  ] as const)('uses the earlier deadline (provider %s, max age %s)', async (providerAge, maxQuoteAgeMs, source, age) => {
    const result = await compile(provider(r => ({ ...r, validUntilMs: providerAge === null ? null : NOW + providerAge })));
    vi.mocked(Date.now).mockReturnValue(NOW + age);
    expect(await simulateBag(result, { client: client(), maxQuoteAgeMs })).toMatchObject({ status: 'QUOTE_EXPIRED', source, expiresAtMs: NOW + age });
  });

  it('can still simulate a quote with unknown validity without claiming a provider deadline', async () => {
    const result = await compile();
    expect(result.quote.validUntilMs).toBeNull();
    expect(await simulateBag(result, { client: client() })).toEqual({ status: 'OK' });
  });

  it('expires immediately for a zero local age policy', async () => {
    const result = await compile(); const rpc = client();
    expect(await simulateBag(result, { client: rpc, maxQuoteAgeMs: 0 })).toMatchObject({ status: 'QUOTE_EXPIRED', source: 'LOCAL_MAX_AGE', expiresAtMs: NOW });
    expect(rpc.getChainId).not.toHaveBeenCalled();
  });

  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('refuses invalid local age %s before RPC', async maxQuoteAgeMs => {
    const result = await compile(); const rpc = client();
    await expect(simulateBag(result, { client: rpc, maxQuoteAgeMs })).rejects.toThrow(/maxQuoteAgeMs/);
    expect(rpc.getChainId).not.toHaveBeenCalled();
  });

  it('refuses a local policy for a stored quote without timing or with deadline overflow', async () => {
    const result = await compile(); const rpc = client();
    await expect(simulateBag(result, { client: rpc, maxQuoteAgeMs: Number.MAX_SAFE_INTEGER })).rejects.toThrow(/safe integer range/);
    delete (result.quote as Partial<typeof result.quote>).requestedAtMs;
    await expect(simulateBag(result, { client: rpc, maxQuoteAgeMs: 100 })).rejects.toThrow(/local quote age is unknown/);
    expect(rpc.getChainId).not.toHaveBeenCalled();
  });

  const badFees: [string, Record<string, unknown>][] = [
    ['address', { recipientAddress: 'not-an-address' }], ['token', { token: 'not-a-token' }],
    ['role', { recipient: '' }], ['negative bps', { bps: -1 }], ['excessive bps', { bps: 10001 }],
    ['nonfinite bps', { bps: NaN }], ['amount', { amountRaw: '-1' }],
  ];
  it.each(badFees)('refuses malformed fee %s', async (_name, patch) => {
    await expect(compile(provider(r => ({ ...r, fees: [{ ...fee(), ...patch }] as ComposerCompileResult['fees'] })))).rejects.toBeInstanceOf(ProviderResponseError);
  });

  const badWarnings: [string, unknown][] = [
    ['list', 'not-a-list'], ['null entry', [null]], ['kind', [{ kind: '', message: 'hello' }]],
    ['message', [{ kind: 'NOTICE', message: 42 }]], ['optional field', [{ ...warning(), port: 42 }]],
  ];
  it.each(badWarnings)('refuses malformed warning %s', async (_name, warnings) => {
    await expect(compile(provider(r => ({ ...r, warnings: warnings as ComposerCompileResult['warnings'] })))).rejects.toBeInstanceOf(ProviderResponseError);
  });

  it.each([
    { fees: [null] }, { warnings: [null] }, { fill: 'not-an-object' },
  ])('rejects malformed upstream metadata before mapping', async patch => {
    await expect(compile(adapter({ ...wireData(), ...patch }))).rejects.toBeInstanceOf(ProviderResponseError);
  });

  it('shows metadata but omits transaction/approvals if the consumer simulation expires', async () => {
    const rpc = client();
    rpc.call.mockImplementation(async () => { vi.mocked(Date.now).mockReturnValue(NOW + 100); return { data: '0x' }; });
    const report = await run({ source: 'fixture', readText: async () => JSON.stringify(document()), ...REQUEST,
      provider: provider(r => ({ ...r, validUntilMs: NOW + 100, fees: [fee()], warnings: [warning()] })),
      allowedTransactionTargets: [ROUTER], allowedApprovalSpenders: [SPENDER], client: rpc });
    expect(report.quote).toMatchObject({ validUntilMs: NOW + 100, fees: [fee()], warnings: [warning()] });
    expect(report.simulate).toMatchObject({ status: 'QUOTE_EXPIRED' });
    expect(report.unsignedTransaction).toBeUndefined();
    expect(report.approvals).toBeUndefined();
  });
});
