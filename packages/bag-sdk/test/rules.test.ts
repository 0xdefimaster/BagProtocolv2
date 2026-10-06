import { describe, expect, it } from 'vitest';
import { parseBag, resolveV1Rules, splitByWeight, V1_DEFAULTS, type BagDocument } from '../src';
import { externalBag } from './helpers';

const doc = (mutate: (d: any) => void = () => {}): BagDocument => {
  const raw = externalBag();
  mutate(raw);
  const r = parseBag(raw);
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.bag;
};

describe('v1 default resolution (normative, frozen)', () => {
  it('the table is fixed', () => {
    expect(V1_DEFAULTS).toEqual({
      kind: 'STATIC_BASKET',
      mutability: 'MUTABLE',
      minWeightBps: 100,
      maxWeightBps: 7000,
      maxAssetsFloor: 10,
      minInvestmentAmount: '0',
      swapSlippageBps: 100,
      rebalanceFrequency: 'THRESHOLD_ONLY',
      driftThresholdBps: 500,
      performanceFeeBps: 0,
      noRouteAssetPolicy: 'BLOCK',
    });
    expect(Object.isFrozen(V1_DEFAULTS)).toBe(true);
  });

  it('declared values win and are labelled DECLARED', () => {
    const r = resolveV1Rules(doc().definition);
    expect(r.maxWeightBps).toEqual({ value: 7000, source: 'DECLARED' });
    expect(r.performanceFeeBps).toEqual({ value: 1000, source: 'DECLARED' });
    expect(r.minInvestmentAmount).toEqual({ value: '10', source: 'DECLARED' });
  });

  it('every null resolves through the table, labelled V1_DEFAULT', () => {
    const def = doc((d) => {
      d.definition.kind = null;
      d.definition.mutability = null;
      d.definition.rules = {
        weightBounds: { minBps: null, maxBps: null },
        maxAssets: null,
        minInvestment: null,
        swapSlippageBps: null,
        rebalance: null,
        performanceFeeBps: null,
        noRouteAssetPolicy: null,
      };
    }).definition;
    const r = resolveV1Rules(def);
    const values = Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.value]));
    expect(values).toEqual({
      kind: 'STATIC_BASKET',
      mutability: 'MUTABLE',
      minWeightBps: 100,
      maxWeightBps: 7000,
      maxAssets: 10,
      minInvestmentAmount: '0',
      swapSlippageBps: 100,
      rebalanceFrequency: 'THRESHOLD_ONLY',
      driftThresholdBps: 500,
      performanceFeeBps: 0,
      noRouteAssetPolicy: 'BLOCK',
    });
    expect(Object.values(r).every((v) => v.source === 'V1_DEFAULT')).toBe(true);
    // Resolution never writes into the definition.
    expect(def.rules.weightBounds.maxBps).toBeNull();
  });

  it('a partly set rebalance resolves field by field; 0 is a declared value, not "unset"', () => {
    const r = resolveV1Rules(doc((d) => (d.definition.rules.rebalance = { frequency: 'MONTHLY', driftThresholdBps: null })).definition);
    expect(r.rebalanceFrequency).toEqual({ value: 'MONTHLY', source: 'DECLARED' });
    expect(r.driftThresholdBps).toEqual({ value: 500, source: 'V1_DEFAULT' });
    expect(resolveV1Rules(doc((d) => (d.definition.rules.performanceFeeBps = 0)).definition).performanceFeeBps).toEqual({ value: 0, source: 'DECLARED' });
  });
});

describe('splitByWeight (normative v1 deposit split)', () => {
  it('is exact, floors then hands leftover units to the largest remainders, ties by chain:address', () => {
    const def = { assets: [
      { chain: 'robinhood' as const, address: '0xB0000000000000000000000000000000000000bb', decimals: 18, weightBps: 3334 },
      { chain: 'robinhood' as const, address: '0xa0000000000000000000000000000000000000aa', decimals: 18, weightBps: 3333 },
      { chain: 'robinhood' as const, address: '0xc0000000000000000000000000000000000000cc', decimals: 18, weightBps: 3333 },
    ] };
    const parts = splitByWeight(BigInt(100), def);
    // floors 33/33/33 (remainders 3400, 3300, 3300) → the one leftover unit goes to the largest remainder (0xb…).
    expect(Object.fromEntries(parts)).toEqual({
      'robinhood:0xb0000000000000000000000000000000000000bb': BigInt(34),
      'robinhood:0xa0000000000000000000000000000000000000aa': BigInt(33),
      'robinhood:0xc0000000000000000000000000000000000000cc': BigInt(33),
    });
    const even = splitByWeight(BigInt(1), { assets: [{ ...def.assets[1], weightBps: 5000 }, { ...def.assets[2], weightBps: 5000 }] });
    expect(even.get('robinhood:0xa0000000000000000000000000000000000000aa')).toBe(BigInt(1)); // tie → lower address
    expect(() => splitByWeight(BigInt(100), { assets: [{ ...def.assets[0], weightBps: 9998 }] })).toThrow(/9998/);
  });
});
