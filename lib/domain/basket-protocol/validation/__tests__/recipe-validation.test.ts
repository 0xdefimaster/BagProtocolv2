import { describe, expect, it } from 'vitest';
import { BasketRecipe, DEFAULT_REBALANCE_RULE, RecipeAsset } from '@/types/basket-protocol';
import { getErrors, getWarnings, VALIDATION_CODES, validateBasketRecipe } from '../index';

// -----------------------------------------------------------------------------
// Fixtures. `baseRecipe()` returns a known-valid recipe (BTC 40 / ETH 30 /
// SOL 20 / USDC 10 on ethereum) — every test starts from a deep-ish clone of
// this and mutates just the thing under test, so a failure always points at
// exactly one broken invariant.
// -----------------------------------------------------------------------------

function asset(overrides: Partial<RecipeAsset>): RecipeAsset {
  return {
    chain: 'ethereum',
    address: '0x000000000000000000000000000000000000dEaD',
    symbol: 'BTC',
    decimals: 18,
    weightBps: 4000,
    ...overrides,
  };
}

function baseRecipe(overrides: Partial<BasketRecipe> = {}): BasketRecipe {
  return {
    id: 'recipe_test_v1',
    bagId: 'bag_test',
    name: 'Majors Basket',
    symbol: 'MAJORS',
    description: 'BTC, ETH, SOL and a USDC cash buffer.',
    chain: 'ethereum',
    strategyType: 'STATIC_BASKET',
    assets: [
      asset({ symbol: 'BTC', address: '0x111111111111111111111111111111111111111a', weightBps: 4000 }),
      asset({ symbol: 'ETH', address: '0x222222222222222222222222222222222222222b', weightBps: 3000 }),
      asset({ symbol: 'SOL', address: '0x333333333333333333333333333333333333333c', weightBps: 2000 }),
      asset({ symbol: 'USDC', address: '0x444444444444444444444444444444444444444d', decimals: 6, weightBps: 1000 }),
    ],
    rebalanceRule: DEFAULT_REBALANCE_RULE,
    minInvestment: 100,
    maxAssets: 10,
    minWeightBps: 100,
    maxWeightBps: 7000,
    mutability: 'MUTABLE',
    version: 1,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('validateBasketRecipe — valid cases', () => {
  it('accepts BTC 40 / ETH 30 / SOL 20 / USDC 10', () => {
    const result = validateBasketRecipe(baseRecipe());
    expect(getErrors(result)).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('tolerates float→bps rounding: 33.33 + 33.33 + 33.34 = 100', () => {
    const recipe = baseRecipe({
      assets: [
        asset({ symbol: 'BTC', address: '0x111111111111111111111111111111111111111a', weightBps: 3333 }),
        asset({ symbol: 'ETH', address: '0x222222222222222222222222222222222222222b', weightBps: 3333 }),
        asset({ symbol: 'SOL', address: '0x333333333333333333333333333333333333333c', weightBps: 3334 }),
      ],
    });
    const result = validateBasketRecipe(recipe);
    expect(result.valid).toBe(true);
  });
});

describe('validateBasketRecipe — weight invariants', () => {
  it('rejects 40 + 30 + 20 = 90 (weights != 100)', () => {
    const recipe = baseRecipe({
      assets: [
        asset({ symbol: 'BTC', address: '0x111111111111111111111111111111111111111a', weightBps: 4000 }),
        asset({ symbol: 'ETH', address: '0x222222222222222222222222222222222222222b', weightBps: 3000 }),
        asset({ symbol: 'SOL', address: '0x333333333333333333333333333333333333333c', weightBps: 2000 }),
      ],
    });
    const result = validateBasketRecipe(recipe);
    expect(result.valid).toBe(false);
    expect(getErrors(result).map((i) => i.code)).toContain(VALIDATION_CODES.WEIGHTS_NOT_100);
  });

  it('rejects BTC 50 / ETH 30 (weights != 100)', () => {
    const recipe = baseRecipe({
      assets: [
        asset({ symbol: 'BTC', address: '0x111111111111111111111111111111111111111a', weightBps: 5000 }),
        asset({ symbol: 'ETH', address: '0x222222222222222222222222222222222222222b', weightBps: 3000 }),
      ],
    });
    const result = validateBasketRecipe(recipe);
    expect(result.valid).toBe(false);
    expect(getErrors(result).map((i) => i.code)).toContain(VALIDATION_CODES.WEIGHTS_NOT_100);
  });
});

describe('validateBasketRecipe — min/max weight bounds', () => {
  it('rejects BTC 60 / ETH 40 when maxWeightBps = 5000 (50%)', () => {
    const recipe = baseRecipe({
      maxWeightBps: 5000,
      assets: [
        asset({ symbol: 'BTC', address: '0x111111111111111111111111111111111111111a', weightBps: 6000 }),
        asset({ symbol: 'ETH', address: '0x222222222222222222222222222222222222222b', weightBps: 4000 }),
      ],
    });
    const result = validateBasketRecipe(recipe);
    expect(result.valid).toBe(false);
    expect(getErrors(result).map((i) => i.code)).toContain(VALIDATION_CODES.ABOVE_MAX_WEIGHT);
  });

  it('rejects BTC 2 / ETH 98 when minWeightBps = 500 (5%)', () => {
    const recipe = baseRecipe({
      minWeightBps: 500,
      assets: [
        asset({ symbol: 'BTC', address: '0x111111111111111111111111111111111111111a', weightBps: 200 }),
        asset({ symbol: 'ETH', address: '0x222222222222222222222222222222222222222b', weightBps: 9800 }),
      ],
    });
    const result = validateBasketRecipe(recipe);
    expect(result.valid).toBe(false);
    expect(getErrors(result).map((i) => i.code)).toContain(VALIDATION_CODES.BELOW_MIN_WEIGHT);
  });
});

describe('validateBasketRecipe — assets', () => {
  it('rejects duplicate BTC', () => {
    const recipe = baseRecipe({
      assets: [
        asset({ symbol: 'BTC', address: '0x111111111111111111111111111111111111111a', weightBps: 5000 }),
        asset({ symbol: 'BTC', address: '0x111111111111111111111111111111111111111a', weightBps: 5000 }),
      ],
    });
    const result = validateBasketRecipe(recipe);
    expect(result.valid).toBe(false);
    const codes = getErrors(result).map((i) => i.code);
    expect(codes).toContain(VALIDATION_CODES.DUPLICATE_ASSET);
    expect(codes).toContain(VALIDATION_CODES.DUPLICATE_ASSET_ADDRESS);
  });

  it('rejects an empty asset list', () => {
    const recipe = baseRecipe({ assets: [] });
    const result = validateBasketRecipe(recipe);
    expect(result.valid).toBe(false);
    expect(getErrors(result).map((i) => i.code)).toContain(VALIDATION_CODES.NO_ASSETS);
  });

  it('rejects an invalid EVM address', () => {
    const recipe = baseRecipe({
      assets: [asset({ symbol: 'BTC', address: 'not-an-address', weightBps: 10000 })],
    });
    const result = validateBasketRecipe(recipe);
    expect(result.valid).toBe(false);
    expect(getErrors(result).map((i) => i.code)).toContain(VALIDATION_CODES.INVALID_ADDRESS);
  });

  it('rejects the Phase-1 "__PENDING__" placeholder address', () => {
    // lib/domain/basket-protocol/recipe.ts uses this placeholder for assets
    // not yet mapped to a real deployment — validation must reject it, that
    // is exactly the seam that stops an unmapped asset from being deployed.
    const recipe = baseRecipe({
      assets: [asset({ symbol: 'BTC', address: '__PENDING__', weightBps: 10000 })],
    });
    const result = validateBasketRecipe(recipe);
    expect(result.valid).toBe(false);
    expect(getErrors(result).map((i) => i.code)).toContain(VALIDATION_CODES.INVALID_ADDRESS);
  });

  it('accepts a valid Solana address on a Solana recipe', () => {
    const recipe = baseRecipe({
      chain: 'solana',
      minWeightBps: 0,
      maxWeightBps: 10000,
      assets: [
        asset({
          chain: 'solana',
          symbol: 'SOL',
          address: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
          decimals: 9,
          weightBps: 10000,
        }),
      ],
    });
    const result = validateBasketRecipe(recipe);
    expect(getErrors(result)).toEqual([]);
  });

  it('rejects negative weight', () => {
    const recipe = baseRecipe({
      assets: [asset({ symbol: 'BTC', address: '0x111111111111111111111111111111111111111a', weightBps: -100 })],
    });
    const result = validateBasketRecipe(recipe);
    expect(result.valid).toBe(false);
    expect(getErrors(result).map((i) => i.code)).toContain(VALIDATION_CODES.INVALID_WEIGHT);
  });

  it('rejects invalid decimals', () => {
    const recipe = baseRecipe({
      assets: [
        asset({ symbol: 'BTC', address: '0x111111111111111111111111111111111111111a', decimals: 25, weightBps: 10000 }),
      ],
    });
    const result = validateBasketRecipe(recipe);
    expect(result.valid).toBe(false);
    expect(getErrors(result).map((i) => i.code)).toContain(VALIDATION_CODES.INVALID_DECIMALS);
  });

  it('rejects too many assets', () => {
    const recipe = baseRecipe({
      maxAssets: 2,
      assets: [
        asset({ symbol: 'BTC', address: '0x111111111111111111111111111111111111111a', weightBps: 3334 }),
        asset({ symbol: 'ETH', address: '0x222222222222222222222222222222222222222b', weightBps: 3333 }),
        asset({ symbol: 'SOL', address: '0x333333333333333333333333333333333333333c', weightBps: 3333 }),
      ],
    });
    const result = validateBasketRecipe(recipe);
    expect(result.valid).toBe(false);
    expect(getErrors(result).map((i) => i.code)).toContain(VALIDATION_CODES.TOO_MANY_ASSETS);
  });
});

describe('validateBasketRecipe — rebalance rule', () => {
  it('rejects a negative drift threshold', () => {
    const recipe = baseRecipe({ rebalanceRule: { ...DEFAULT_REBALANCE_RULE, driftThresholdBps: -1 } });
    const result = validateBasketRecipe(recipe);
    expect(result.valid).toBe(false);
    expect(getErrors(result).map((i) => i.code)).toContain(VALIDATION_CODES.INVALID_DRIFT_THRESHOLD);
  });

  it('rejects a drift threshold above 100%', () => {
    const recipe = baseRecipe({ rebalanceRule: { ...DEFAULT_REBALANCE_RULE, driftThresholdBps: 10_001 } });
    const result = validateBasketRecipe(recipe);
    expect(result.valid).toBe(false);
    expect(getErrors(result).map((i) => i.code)).toContain(VALIDATION_CODES.INVALID_DRIFT_THRESHOLD);
  });

  it('rejects an invalid frequency', () => {
    const recipe = baseRecipe({
      rebalanceRule: { ...DEFAULT_REBALANCE_RULE, frequency: 'YEARLY' as never },
    });
    const result = validateBasketRecipe(recipe);
    expect(result.valid).toBe(false);
    expect(getErrors(result).map((i) => i.code)).toContain(VALIDATION_CODES.INVALID_REBALANCE_FREQUENCY);
  });

  it('warns (does not invalidate) when frequency is MANUAL but a threshold is still set', () => {
    const recipe = baseRecipe({
      rebalanceRule: { ...DEFAULT_REBALANCE_RULE, frequency: 'MANUAL', driftThresholdBps: 500 },
    });
    const result = validateBasketRecipe(recipe);
    expect(result.valid).toBe(true);
    expect(getWarnings(result).map((i) => i.code)).toContain(VALIDATION_CODES.INVALID_REBALANCE_FREQUENCY);
  });
});

describe('validateBasketRecipe — warnings never block validity', () => {
  it('a single-asset basket is valid but produces a LOW_ASSET_COUNT warning', () => {
    const recipe = baseRecipe({
      minWeightBps: 0,
      maxWeightBps: 10000,
      assets: [asset({ symbol: 'BTC', address: '0x111111111111111111111111111111111111111a', weightBps: 10000 })],
    });
    const result = validateBasketRecipe(recipe);
    expect(getErrors(result)).toEqual([]);
    expect(result.valid).toBe(true);
    expect(getWarnings(result).map((i) => i.code)).toContain(VALIDATION_CODES.LOW_ASSET_COUNT);
  });

  it('a missing description is valid but produces a warning', () => {
    const recipe = baseRecipe({ description: '' });
    const result = validateBasketRecipe(recipe);
    expect(result.valid).toBe(true);
    expect(getWarnings(result).map((i) => i.code)).toContain(VALIDATION_CODES.INVALID_DESCRIPTION);
  });
});

describe('validateBasketRecipe — purity', () => {
  it('returns the same result for the same input, called twice', () => {
    const recipe = baseRecipe();
    const a = validateBasketRecipe(recipe);
    const b = validateBasketRecipe(recipe);
    expect(a).toEqual(b);
  });

  it('does not mutate the input recipe', () => {
    const recipe = baseRecipe();
    const snapshot = JSON.stringify(recipe);
    validateBasketRecipe(recipe);
    expect(JSON.stringify(recipe)).toEqual(snapshot);
  });
});

// ----------------------------- Strategy type (Phase 11) --------------------------

describe('validateBasketRecipe — strategy type', () => {
  it('accepts STATIC_BASKET', () => {
    const recipe = baseRecipe({ strategyType: 'STATIC_BASKET' });
    const result = validateBasketRecipe(recipe);
    expect(getErrors(result)).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('rejects an unknown strategy type', () => {
    // Cast needed: `strategyType` is a closed union at the type level, so
    // this simulates untyped input (an API payload, a stale DB row) rather
    // than something the type system would let real code construct.
    const recipe = baseRecipe({ strategyType: 'UNKNOWN_STRATEGY' as BasketRecipe['strategyType'] });
    const result = validateBasketRecipe(recipe);
    expect(result.valid).toBe(false);
    expect(getErrors(result).map((i) => i.code)).toContain(VALIDATION_CODES.INVALID_STRATEGY_TYPE);
  });

  it('rejects a missing strategy type', () => {
    const recipe = baseRecipe({ strategyType: undefined as unknown as BasketRecipe['strategyType'] });
    const result = validateBasketRecipe(recipe);
    expect(result.valid).toBe(false);
    expect(getErrors(result).map((i) => i.code)).toContain(VALIDATION_CODES.INVALID_STRATEGY_TYPE);
  });
});
