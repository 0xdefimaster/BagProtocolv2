import { describe, expect, it } from 'vitest';
import { ValidateBagInputError, ValidateBagRequest, parseValidateBagRequest, validateBag } from '../validate-bag';
import { deriveStrategyPolicy } from '../strategy-policy';
import { CanonicalAsset } from '@/types/basket-protocol';

const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
function reg(n: number, symbol: string, over: Partial<CanonicalAsset> = {}): CanonicalAsset {
  return {
    id: symbol, chain: 'robinhood', address: addr(n), symbol, decimals: 18, name: symbol, status: 'VERIFIED', assetType: 'stock',
    routeStatus: 'ROUTABLE', createdAt: '', updatedAt: '', ...over,
  };
}
const registry = [reg(1, 'NVDA'), reg(2, 'AMD'), reg(3, 'MSFT'), reg(4, 'BTC', { assetType: 'crypto' })];
const req = (assets: [number, number][], extra: Partial<ValidateBagRequest> = {}): ValidateBagRequest => ({
  assets: assets.map(([n, weightBps]) => ({ address: addr(n), weightBps })),
  ...extra,
});
const codes = (r: ReturnType<typeof validateBag>) => [...r.errors, ...r.warnings, ...r.info].map((f) => f.code);
const check = (r: ReturnType<typeof validateBag>, rule: string) => r.checks.find((c) => c.rule === rule)!;

describe('validateBag', () => {
  it('a valid composition passes every rule and returns the policy it was checked against', () => {
    const r = validateBag(req([[1, 3000], [2, 3000], [3, 2000], [4, 2000]], { policy: { maxSingleAssetWeightBps: 3000 } }), registry);
    expect(r).toMatchObject({ schemaVersion: 1, valid: true, errors: [], warnings: [], info: [] });
    expect(r.checks.filter((c) => c.result === 'FAIL')).toEqual([]);
    expect(check(r, 'minInvestmentUsd').result).toBe('SKIPPED');
    expect(r.policy.maxSingleAssetWeightBps.value).toBe(3000);
  });

  it('max weight: reports the asset, requested and allowed bps, and who enforces the rule', () => {
    const r = validateBag(req([[1, 3400], [2, 3300], [3, 3300]], { policy: { maxSingleAssetWeightBps: 3000 } }), registry);
    expect(r.valid).toBe(false);
    const nvda = r.errors.find((e) => e.asset?.symbol === 'NVDA')!;
    expect(nvda).toMatchObject({ code: 'ABOVE_MAX_WEIGHT', rule: 'maxSingleAssetWeightBps', field: 'assets[0].weightBps', severity: 'error', requested: 3400, allowed: 3000 });
    expect(check(r, 'maxSingleAssetWeightBps')).toMatchObject({ result: 'FAIL', enforcement: 'SERVER_ENFORCED', findings: 3 });
  });

  it('weights must sum to 100%', () => {
    const r = validateBag(req([[1, 4000], [2, 3000], [3, 2000]]), registry);
    expect(r.errors.find((e) => e.code === 'WEIGHTS_NOT_100')).toMatchObject({ rule: 'weightsSum', requested: 9000, allowed: 10000 });
  });

  it('duplicate assets', () => {
    const r = validateBag(req([[1, 5000], [1, 5000]]), registry);
    expect(codes(r)).toContain('DUPLICATE_ASSET_ADDRESS');
    expect(check(r, 'uniqueAssets').result).toBe('FAIL');
  });

  it('unknown, unverified and malformed assets', () => {
    const unverified = [...registry, reg(9, 'SHADY', { status: 'UNKNOWN' })];
    const r = validateBag({ assets: [{ address: addr(1), weightBps: 4000 }, { address: addr(8), weightBps: 3000 }, { address: addr(9), weightBps: 2000 }, { address: 'nope', weightBps: 1000 }] }, unverified);
    expect(r.errors.find((e) => e.code === 'ASSET_NOT_FOUND' && e.field === 'assets[1].address')).toBeTruthy();
    expect(r.errors.find((e) => e.code === 'ASSET_NOT_VERIFIED')).toMatchObject({ asset: { symbol: 'SHADY' } });
    expect(r.errors.find((e) => e.code === 'INVALID_ADDRESS')).toMatchObject({ field: 'assets[3].address' });
  });

  it('max assets', () => {
    const r = validateBag(req([[1, 4000], [2, 3000], [3, 3000]], { policy: { maxAssets: 2 } }), registry);
    expect(r.errors.find((e) => e.code === 'TOO_MANY_ASSETS')).toMatchObject({ rule: 'maxAssets', requested: 3, allowed: 2 });
  });

  it('min investment is checked like a purchase when a size is given', () => {
    const base = req([[1, 5000], [2, 5000]], { policy: { minInvestmentUsd: 50 } });
    expect(validateBag({ ...base, investmentUsd: 20 }, registry).errors.find((e) => e.code === 'MIN_INVESTMENT_NOT_MET')).toMatchObject({ requested: 20, allowed: 50 });
    expect(validateBag({ ...base, investmentUsd: 50 }, registry).valid).toBe(true);
  });

  it('no-route assets are warnings (BAG-attested background check), never blocking on their own', () => {
    const noRoute = registry.map((a) => (a.symbol === 'BTC' ? { ...a, routeStatus: 'NO_ROUTE' as const } : a));
    const blocked = validateBag(req([[1, 4000], [2, 3000], [4, 3000]]), noRoute);
    expect(blocked.valid).toBe(true);
    expect(blocked.warnings.find((w) => w.code === 'ASSET_NO_ROUTE')).toMatchObject({ rule: 'routes', severity: 'warning', asset: { symbol: 'BTC' } });
    expect(blocked.warnings[0].message).toMatch(/BLOCK/);
    expect(check(blocked, 'routes')).toMatchObject({ result: 'WARN', enforcement: 'ATTESTED_ONLY' });

    const heavy = validateBag(req([[1, 6000], [4, 4000]], { policy: { noRouteAssetPolicy: 'HOLD_INPUT' } }), noRoute);
    expect(heavy.warnings.find((w) => w.code === 'UNROUTABLE_WEIGHT_TOO_HIGH')).toMatchObject({ requested: 4000, allowed: 3000 });

    const unchecked = validateBag(req([[1, 5000], [2, 5000]]), registry.map((a) => (a.symbol === 'AMD' ? { ...a, routeStatus: undefined } : a)));
    expect(unchecked.info.map((i) => i.code)).toEqual(['ROUTE_UNCHECKED']);
  });

  it('separates blocking errors, warnings and info, and a single-asset Bag is only a warning', () => {
    const r = validateBag(req([[1, 10000]], { policy: { maxSingleAssetWeightBps: 10000 } }), registry);
    expect(r.valid).toBe(true);
    expect(r.warnings.map((w) => w.code)).toEqual(['LOW_ASSET_COUNT']);
  });

  it('invalid policy values are findings, not crashes', () => {
    const r = validateBag(req([[1, 5000], [2, 5000]], { policy: { maxSingleAssetWeightBps: 0, noRouteAssetPolicy: 'YOLO' as never, performanceFeeBps: 5000 } }), registry);
    expect(codes(r)).toEqual(expect.arrayContaining(['INVALID_POLICY_VALUE', 'INVALID_PERFORMANCE_FEE']));
    expect(r.errors.filter((e) => e.code === 'INVALID_POLICY_VALUE').map((e) => e.field).sort()).toEqual(['policy.maxSingleAssetWeightBps', 'policy.noRouteAssetPolicy']);
  });

  it('is deterministic: same input, same output, in a fixed order', () => {
    const input = req([[3, 3400], [1, 3400], [2, 3200]], { policy: { maxSingleAssetWeightBps: 3000, maxAssets: 2 } });
    const a = validateBag(input, registry);
    const b = validateBag(JSON.parse(JSON.stringify(input)), [...registry].reverse());
    expect(b).toEqual(a);
    expect(a.errors.map((e) => e.rule)).toEqual(['maxSingleAssetWeightBps', 'maxSingleAssetWeightBps', 'maxSingleAssetWeightBps', 'maxAssets']);
  });

  it('returns the same policy object the Passport shows for the same recipe values', () => {
    const r = validateBag(req([[1, 5000], [2, 5000]], { policy: { maxSingleAssetWeightBps: 6000, maxSlippageBps: 80, performanceFeeBps: 500, minInvestmentUsd: 10, noRouteAssetPolicy: 'REFUND' } }), registry);
    const fromRecipe = deriveStrategyPolicy(
      { maxWeightBps: 6000, minWeightBps: 100, maxAssets: 10, minInvestment: 10, performanceFeeBps: 500, unroutablePolicy: 'REFUND', rebalanceRule: { frequency: 'THRESHOLD_ONLY', driftThresholdBps: 500, maxSlippageBps: 80 } },
      { mutability: 'MUTABLE', deployed: false, performanceFeeBpsLocked: null }
    );
    expect(r.policy).toEqual(fromRecipe);
  });
});

describe('parseValidateBagRequest', () => {
  it('rejects malformed bodies with a clear message', () => {
    expect(() => parseValidateBagRequest(null)).toThrow(ValidateBagInputError);
    expect(() => parseValidateBagRequest({})).toThrow(/assets must be an array/);
    expect(() => parseValidateBagRequest({ assets: [{ address: 1, weightBps: 1 }] })).toThrow(/assets\[0\]/);
    expect(() => parseValidateBagRequest({ assets: [], chain: 'mars' })).toThrow(/Unsupported chain/);
    expect(() => parseValidateBagRequest({ assets: [], policy: { maxAssets: '3' } })).toThrow(/policy.maxAssets must be a number/);
    expect(parseValidateBagRequest({ assets: [{ address: addr(1), weightBps: 10000 }] }).assets).toHaveLength(1);
  });
});
