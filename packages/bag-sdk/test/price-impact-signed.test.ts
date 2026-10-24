import { describe, expect, it, vi } from 'vitest';
import { compileBag, parseBag, type ComposerCompileRequest, type ComposerCompileResult, type ComposerProvider } from '../src';
import { markSignedUsdPriceImpactProvider, type PriceImpactUsd } from '../src/execution';
import { lifiComposer } from '../src/adapters/lifi';
import { externalBag } from './helpers';

const INPUT = '0x' + 'c'.repeat(40);
const SIGNER = '0x' + '5'.repeat(40);
const ROUTER = '0x' + '7'.repeat(40);
const SPENDER = '0x' + '6'.repeat(40);
const TRUST = { chainId: 4663, allowedTransactionTargets: [ROUTER], allowedApprovalSpenders: [SPENDER] };
const REQUEST = { inputToken: INPUT, amountRaw: BigInt(1000), inputTokenDecimals: 6, signer: SIGNER };
// Observed on Robinhood Chain, Composer 0.11.3 revision 9169cc8 (5 USDG into four stock tokens).
const OBSERVED = { inputValueUsd: 4.9918325034999995, outputValueUsd: 4.99499414537114, impactBps: -6 };

function document() {
  const raw = externalBag();
  raw.definition.rules.minInvestment = null;
  delete raw.metadata;
  const parsed = parseBag(raw);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  return parsed.bag;
}

/** The real LI.FI adapter over a fixture HTTP response. */
function lifiWith(priceImpact: unknown, legMinimum = '990') {
  const bag = document();
  const data = {
    outputs: Object.fromEntries(bag.definition.assets.slice().sort((a, b) => a.address.toLowerCase().localeCompare(b.address.toLowerCase())).map((asset, i) => [
      `swap_${i}.amountOut`, { role: 'terminal', owner: SIGNER, delivery: { when: 'now' }, resource: { kind: 'erc20', token: asset.address, chainId: 4663 },
        amount: { estimate: { basis: 'simulated', value: '1000' }, minimum: { basis: 'op', value: legMinimum } } },
    ])),
    transactionRequest: { to: ROUTER, data: '0x12345678', value: '0', chainId: 4663 }, userProxy: SPENDER, approvals: [],
    ...(priceImpact === undefined ? {} : { priceImpact }),
  };
  // Raw text, so JSON-only values such as 1e400 (parsed as Infinity) reach the adapter unchanged.
  const wire = typeof priceImpact === 'string' ? JSON.stringify({ data: { ...data, priceImpact: '__RAW__' } }).replace('"__RAW__"', priceImpact) : JSON.stringify({ data });
  return lifiComposer({ apiKey: 'fixture-only', baseUrl: 'https://composer.test',
    fetch: vi.fn(async () => new Response(wire, { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch });
}
const impact = (over: Partial<typeof OBSERVED & { unpricedInputs: unknown; unpricedOutputs: unknown }> = {}) =>
  ({ ...OBSERVED, unpricedInputs: [], unpricedOutputs: [], ...over });
const compile = (provider: ComposerProvider) => compileBag(document(), REQUEST, { provider, trust: TRUST });
const code = async (provider: ComposerProvider) => compile(provider).then(() => 'ACCEPTED', (e: { code?: string }) => e.code);

/** A directly constructed result, for values JSON cannot carry (NaN). */
function direct(priceImpactBps: number | null, priceImpactUsd: unknown, signed: boolean): ComposerProvider {
  const provider: ComposerProvider = { name: signed ? 'signed-fixture' : 'other-provider', async compile(q: ComposerCompileRequest): Promise<ComposerCompileResult> {
    return { transaction: { to: ROUTER, data: '0x12345678', value: '0', chainId: q.chainId }, executor: null,
      approvals: [{ token: q.inputToken, spender: SPENDER, amountRaw: String(q.amountRaw) }],
      legs: q.legs.map(l => ({ token: l.token, expectedOutRaw: '1000', minOutRaw: '990' })),
      priceImpactBps, priceImpactUsd: priceImpactUsd as PriceImpactUsd, gasLimit: null, fees: [] };
  } };
  return signed ? markSignedUsdPriceImpactProvider(provider) : provider;
}

describe('LI.FI Composer signed price impact', () => {
  it('accepts the observed favorable impact unchanged and preserves the USD values', async () => {
    const compiled = await compile(lifiWith(impact()));
    expect(compiled.quote.priceImpactBps).toBe(-6);
    expect(compiled.quote.priceImpactUsd).toEqual({ inputValueUsd: OBSERVED.inputValueUsd, outputValueUsd: OBSERVED.outputValueUsd, unpricedInputs: [], unpricedOutputs: [] });
  });

  it('accepts reported values within ±1 bps of the USD ratio (−6.33) and refuses those outside it', async () => {
    expect(await code(lifiWith(impact({ impactBps: -7 })))).toBe('ACCEPTED');
    expect(await code(lifiWith(impact({ impactBps: -5 })))).toBe('PRICE_IMPACT_INVALID');
    expect(await code(lifiWith(impact({ impactBps: -8 })))).toBe('PRICE_IMPACT_INVALID');
    expect(await code(lifiWith(impact({ impactBps: -50 })))).toBe('PRICE_IMPACT_INVALID');
  });

  it('keeps positive losses and the maximum-loss limit as before', async () => {
    const loss = await compile(lifiWith(impact({ inputValueUsd: 5, outputValueUsd: 4.985, impactBps: 30 })));
    expect(loss.quote.priceImpactBps).toBe(30);
    const max = loss.quote.plan.maxPriceImpactBps;
    expect(await code(lifiWith(impact({ inputValueUsd: 5, outputValueUsd: 5 * (1 - (max + 1) / 10_000), impactBps: max + 1 })))).toBe('PRICE_IMPACT_EXCEEDED');
    expect(await code(lifiWith(impact({ impactBps: 0, inputValueUsd: 5, outputValueUsd: 5 })))).toBe('ACCEPTED');
  });

  it('refuses a negative impact whose USD values point the other way', async () => {
    expect(await code(lifiWith(impact({ inputValueUsd: 4.99499414537114, outputValueUsd: 4.9918325034999995, impactBps: -6 })))).toBe('PRICE_IMPACT_INVALID');
    expect(await code(lifiWith(impact({ inputValueUsd: 5, outputValueUsd: 5, impactBps: -1 })))).toBe('PRICE_IMPACT_INVALID');
  });

  it('refuses a negative impact with missing, partial or malformed USD data', async () => {
    expect(await code(lifiWith(undefined))).toBe('PRICE_IMPACT_INVALID'); // not reported at all
    expect(await code(lifiWith({ impactBps: -6, unpricedInputs: [], unpricedOutputs: [] }))).toBe('PRICE_IMPACT_INVALID');
    expect(await code(lifiWith(impact({ inputValueUsd: undefined })))).toBe('PRICE_IMPACT_INVALID');
    expect(await code(lifiWith(impact({ inputValueUsd: '4.99' as never })))).toBe('PRICE_IMPACT_INVALID');
    expect(await code(lifiWith(impact({ inputValueUsd: 0 })))).toBe('PRICE_IMPACT_INVALID');
    expect(await code(lifiWith(impact({ inputValueUsd: -4.99 })))).toBe('PRICE_IMPACT_INVALID');
    expect(await code(lifiWith(impact({ unpricedOutputs: ['0x' + 'a'.repeat(40)] })))).toBe('PRICE_IMPACT_INVALID');
    expect(await code(lifiWith(impact({ unpricedInputs: 'none' })))).toBe('PRICE_IMPACT_INVALID');
    expect(await code(lifiWith(impact({ unpricedInputs: [7] })))).toBe('PRICE_IMPACT_INVALID');
  });

  it('refuses Infinity (JSON 1e400) and invalid impact numbers', async () => {
    expect(await code(lifiWith('{"impactBps":-6,"inputValueUsd":1e400,"outputValueUsd":4.99,"unpricedInputs":[],"unpricedOutputs":[]}'))).toBe('PRICE_IMPACT_INVALID');
    expect(await code(lifiWith('{"impactBps":-6,"inputValueUsd":4.99,"outputValueUsd":1e400,"unpricedInputs":[],"unpricedOutputs":[]}'))).toBe('PRICE_IMPACT_INVALID');
    expect(await code(lifiWith(impact({ impactBps: -6.5 })))).toBe('PRICE_IMPACT_INVALID');
    expect(await code(lifiWith(impact({ impactBps: '-6' as never })))).toBe('PRICE_IMPACT_INVALID');
    expect(await code(lifiWith('{"impactBps":-1e400,"inputValueUsd":4.99,"outputValueUsd":5,"unpricedInputs":[],"unpricedOutputs":[]}'))).toBe('PRICE_IMPACT_INVALID');
  });

  it('refuses NaN and Infinity in directly reported values', async () => {
    const usd = { ...impact() } as unknown as PriceImpactUsd;
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(await code(direct(bad, usd, true))).toBe('PRICE_IMPACT_INVALID');
      expect(await code(direct(-6, { ...usd, inputValueUsd: bad }, true))).toBe('PRICE_IMPACT_INVALID');
      expect(await code(direct(-6, { ...usd, outputValueUsd: bad }, true))).toBe('PRICE_IMPACT_INVALID');
    }
  });

  it('still enforces minimum output and slippage with a favorable impact', async () => {
    expect(await code(lifiWith(impact(), '0'))).toBe('OUTPUT_INVALID');
    expect(await code(lifiWith(impact(), '900'))).toBe('SLIPPAGE_EXCEEDED');
  });
});

describe('other providers keep the non-negative rule', () => {
  it('refuses a negative impact even with consistent USD values', async () => {
    const usd = { inputValueUsd: OBSERVED.inputValueUsd, outputValueUsd: OBSERVED.outputValueUsd, unpricedInputs: [], unpricedOutputs: [] };
    expect(await code(direct(-6, usd, false))).toBe('PRICE_IMPACT_INVALID');
    expect(await code(direct(-6, null, false))).toBe('PRICE_IMPACT_INVALID');
  });

  it('ignores USD values from other providers and keeps them out of the quote', async () => {
    const compiled = await compile(direct(10, { inputValueUsd: 1, outputValueUsd: 1, unpricedInputs: [], unpricedOutputs: [] }, false));
    expect(compiled.quote.priceImpactBps).toBe(10);
    expect(compiled.quote.priceImpactUsd).toBeNull();
  });
});
