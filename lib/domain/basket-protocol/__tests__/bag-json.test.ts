import { describe, expect, it } from 'vitest';
import vectors from '@/docs/schemas/bag-json.v1.vectors.json';
import { assetDisplayFromRecipe, canonicalJson, computeDefinitionHash, decimalString, definitionFromRecipe, definitionHashPreimage, normalizeDefinition } from '../bag-json';
import type { BagDefinition } from '@/types/strategy';
import type { BasketRecipe } from '@/types/basket-protocol';

const A = '0xA0000000000000000000000000000000000000aA';
const B = '0xb0000000000000000000000000000000000000bB';
const recipe = {
  chain: 'robinhood', strategyType: 'STATIC_BASKET', mutability: 'MUTABLE', name: 'n', symbol: 's', description: 'd',
  assets: [
    { chain: 'robinhood', address: B, symbol: 'TSLA', decimals: 18, weightBps: 6000 },
    { chain: 'robinhood', address: A, symbol: 'AAPL', decimals: 18, weightBps: 4000 },
  ],
  minWeightBps: 500, maxWeightBps: 7000, maxAssets: 10, minInvestment: 10, performanceFeeBps: 1000, unroutablePolicy: 'HOLD_INPUT',
  rebalanceRule: { frequency: 'THRESHOLD_ONLY', driftThresholdBps: 500, maxSlippageBps: 100 },
} as unknown as BasketRecipe;

describe('canonicalJson (RFC 8785)', () => {
  it('sorts keys by UTF-16 code units, emits no whitespace, keeps array order', () => {
    expect(canonicalJson({ b: 1, a: [3, 1, { d: null, c: true }], A: 'x' })).toBe('{"A":"x","a":[3,1,{"c":true,"d":null}],"b":1}');
    // Code-unit order, not locale order: "Z" (0x5A) < "a" (0x61) < "é" (0xE9).
    expect(canonicalJson({ é: 1, a: 2, Z: 3 })).toBe('{"Z":3,"a":2,"é":1}');
    expect(canonicalJson({ s: 'line\n"quote"' })).toBe('{"s":"line\\n\\"quote\\""}');
  });

  it('refuses values JSON cannot represent instead of dropping them', () => {
    expect(() => canonicalJson({ a: undefined })).toThrow();
    expect(() => canonicalJson({ a: NaN })).toThrow();
    expect(() => canonicalJson({ a: Infinity })).toThrow();
    expect(() => canonicalJson({ a: BigInt(1) })).toThrow();
  });
});

describe('definitionHash', () => {
  it('matches the published test vectors (verified independently with js-sha3)', () => {
    for (const v of vectors.vectors) {
      const input = v.input as BagDefinition;
      expect(normalizeDefinition(input)).toEqual(v.canonical);
      expect(definitionHashPreimage(input)).toBe(v.preimage);
      expect(computeDefinitionHash(input)).toBe(v.definitionHash);
    }
  });

  it('does not depend on asset order, address case or key order', () => {
    const base = definitionFromRecipe(recipe);
    const reordered = definitionFromRecipe({ ...recipe, assets: [...recipe.assets].reverse() });
    const lowercased = definitionFromRecipe({ ...recipe, assets: recipe.assets.map((a) => ({ ...a, address: a.address.toLowerCase() })) });
    const shuffledKeys = JSON.parse(JSON.stringify({ rules: base.rules, assets: base.assets, mutability: base.mutability, chain: base.chain, kind: base.kind }));
    const h = computeDefinitionHash(base);
    expect(computeDefinitionHash(reordered)).toBe(h);
    expect(computeDefinitionHash(lowercased)).toBe(h);
    expect(computeDefinitionHash(shuffledKeys)).toBe(h);
    expect(h).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('changes with any committed value', () => {
    const h = computeDefinitionHash(definitionFromRecipe(recipe));
    const variants: Partial<BasketRecipe>[] = [
      { assets: [{ ...recipe.assets[0], weightBps: 5000 }, { ...recipe.assets[1], weightBps: 5000 }] },
      { assets: [{ ...recipe.assets[0], decimals: 6 }, recipe.assets[1]] },
      { maxWeightBps: 6900 },
      { minWeightBps: 400 },
      { maxAssets: 9 },
      { minInvestment: 11 },
      { performanceFeeBps: 900 },
      { unroutablePolicy: 'BLOCK' },
      { mutability: 'IMMUTABLE' },
      { rebalanceRule: { ...recipe.rebalanceRule, maxSlippageBps: 101 } },
      { rebalanceRule: { ...recipe.rebalanceRule, frequency: 'MONTHLY' } },
      { rebalanceRule: { ...recipe.rebalanceRule, driftThresholdBps: 400 } },
    ];
    const hashes = variants.map((v) => computeDefinitionHash(definitionFromRecipe({ ...recipe, ...v } as BasketRecipe)));
    for (const x of hashes) expect(x).not.toBe(h);
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it('display metadata is not part of the definition: Bag name/symbol/description and asset symbols', () => {
    const h = computeDefinitionHash(definitionFromRecipe(recipe));
    const renamed = { ...recipe, name: 'Other', symbol: 'OTH', description: 'changed' } as BasketRecipe;
    expect(computeDefinitionHash(definitionFromRecipe(renamed))).toBe(h);
    // Identity is chain + address: a token shown as "TSLA", "Tesla" or "TSLA-RH" is the same asset.
    const relabeled = { ...recipe, assets: recipe.assets.map((a, i) => ({ ...a, symbol: ['Tesla', 'Apple Inc.'][i] })) } as BasketRecipe;
    expect(computeDefinitionHash(definitionFromRecipe(relabeled))).toBe(h);
    expect(JSON.stringify(definitionFromRecipe(recipe))).not.toContain('TSLA');
    expect(assetDisplayFromRecipe(recipe)).toEqual([
      { chain: 'robinhood', address: A.toLowerCase(), symbol: 'AAPL' },
      { chain: 'robinhood', address: B.toLowerCase(), symbol: 'TSLA' },
    ]);
  });

  it('numbers are canonical by value: 1 and 1.0 in the submitted JSON text hash the same', () => {
    const asText = (weight: string) =>
      `{"kind":null,"chain":"robinhood","mutability":null,"assets":[{"chain":"robinhood","address":"${A}","decimals":18,"weightBps":${weight}}],` +
      `"rules":{"weightBounds":{"minBps":null,"maxBps":null},"maxAssets":null,"minInvestment":null,"swapSlippageBps":null,"rebalance":null,"performanceFeeBps":null,"noRouteAssetPolicy":null}}`;
    const h = computeDefinitionHash(JSON.parse(asText('10000')));
    expect(computeDefinitionHash(JSON.parse(asText('10000.0')))).toBe(h);
    expect(computeDefinitionHash(JSON.parse(asText('1e4')))).toBe(h);
    expect(definitionHashPreimage(JSON.parse(asText('10000.0')))).toContain('"weightBps":10000}');
  });
});

describe('definitionFromRecipe', () => {
  it('maps the recipe without inventing values', () => {
    const d = definitionFromRecipe(recipe);
    expect(d).toEqual({
      kind: 'STATIC_BASKET',
      chain: 'robinhood',
      mutability: 'MUTABLE',
      assets: [
        { chain: 'robinhood', address: A.toLowerCase(), decimals: 18, weightBps: 4000 },
        { chain: 'robinhood', address: B.toLowerCase(), decimals: 18, weightBps: 6000 },
      ],
      rules: {
        weightBounds: { minBps: 500, maxBps: 7000 },
        maxAssets: 10,
        minInvestment: { amount: '10', measuredAs: 'PAYMENT_TOKEN_AMOUNT' },
        swapSlippageBps: 100,
        rebalance: { frequency: 'THRESHOLD_ONLY', driftThresholdBps: 500 },
        performanceFeeBps: 1000,
        noRouteAssetPolicy: 'HOLD_INPUT',
      },
    });
  });

  it('a field the recipe does not carry is null, never today\'s default (so old hashes never move)', () => {
    const legacy = { chain: 'robinhood', assets: recipe.assets } as unknown as BasketRecipe;
    const d = definitionFromRecipe(legacy);
    expect(d.kind).toBeNull();
    expect(d.mutability).toBeNull();
    expect(d.rules).toEqual({
      weightBounds: { minBps: null, maxBps: null }, maxAssets: null, minInvestment: null, swapSlippageBps: null, rebalance: null, performanceFeeBps: null, noRouteAssetPolicy: null,
    });
    // "Not set" and "set to the current default" are different commitments.
    expect(computeDefinitionHash(d)).not.toBe(computeDefinitionHash(definitionFromRecipe({ ...legacy, unroutablePolicy: 'BLOCK' } as BasketRecipe)));
  });

  it('slippage counts as set only when positive (same rule as the policy view); this is the only 0 → null normalization', () => {
    const zero = { ...recipe, rebalanceRule: { ...recipe.rebalanceRule, maxSlippageBps: 0 } } as BasketRecipe;
    expect(definitionFromRecipe(zero).rules.swapSlippageBps).toBeNull();
    // Elsewhere an explicit 0 is a real value and differs from "not set".
    const zeroFee = definitionFromRecipe({ ...recipe, performanceFeeBps: 0 } as BasketRecipe);
    const unsetFee = definitionFromRecipe({ ...recipe, performanceFeeBps: undefined } as unknown as BasketRecipe);
    expect(zeroFee.rules.performanceFeeBps).toBe(0);
    expect(unsetFee.rules.performanceFeeBps).toBeNull();
    expect(computeDefinitionHash(zeroFee)).not.toBe(computeDefinitionHash(unsetFee));
  });

  it('keeps non-EVM addresses as-is (case-sensitive)', () => {
    const sol = { chain: 'solana', assets: [{ chain: 'solana', address: 'So11111111111111111111111111111111111111112', symbol: 'SOL', decimals: 9, weightBps: 10000 }] } as unknown as BasketRecipe;
    expect(definitionFromRecipe(sol).assets[0].address).toBe('So11111111111111111111111111111111111111112');
  });
});

describe('decimalString', () => {
  it('never uses exponent notation and rejects non-amounts', () => {
    expect(decimalString(10)).toBe('10');
    expect(decimalString(0.5)).toBe('0.5');
    expect(decimalString(1e-7)).toBe('0.0000001');
    expect(decimalString(1e21)).toBe('1000000000000000000000');
    expect(decimalString(1.5e-7)).toBe('0.00000015');
    expect(decimalString(1.25e22)).toBe('12500000000000000000000');
    expect(decimalString(-1)).toBeNull();
    expect(decimalString(NaN)).toBeNull();
    expect(decimalString('10')).toBeNull();
    expect(decimalString(undefined)).toBeNull();
  });
});
