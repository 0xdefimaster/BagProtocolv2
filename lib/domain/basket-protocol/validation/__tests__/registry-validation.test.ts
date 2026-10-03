import { describe, expect, it } from 'vitest';
import { BasketRecipe, DEFAULT_REBALANCE_RULE, RecipeAsset } from '@/types/basket-protocol';
import { assetIdentityKey } from '../../asset-identity';
import { validateRecipeAssetsAgainstRegistry } from '../registry-validation';

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
    description: 'BTC + ETH.',
    chain: 'ethereum',
    strategyType: 'STATIC_BASKET',
    assets: [
      asset({ symbol: 'BTC', address: '0x111111111111111111111111111111111111111a', weightBps: 6000 }),
      asset({ symbol: 'ETH', address: '0x222222222222222222222222222222222222222b', weightBps: 4000 }),
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

describe('validateRecipeAssetsAgainstRegistry', () => {
  it('reports no issues when every asset is verified', () => {
    const recipe = baseRecipe();
    const verifiedIdentityKeys = new Set(
      recipe.assets.map((a) => assetIdentityKey({ chain: a.chain, address: a.address }))
    );
    const issues = validateRecipeAssetsAgainstRegistry(recipe, { verifiedIdentityKeys });
    expect(issues).toEqual([]);
  });

  it('flags an asset that is not in the verified set, defaulting to ERROR severity', () => {
    const recipe = baseRecipe();
    const verifiedIdentityKeys = new Set([
      assetIdentityKey({ chain: recipe.assets[0].chain, address: recipe.assets[0].address }),
    ]);
    const issues = validateRecipeAssetsAgainstRegistry(recipe, { verifiedIdentityKeys });
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('ASSET_NOT_VERIFIED');
    expect(issues[0].severity).toBe('ERROR');
    expect(issues[0].path).toBe('assets[1]');
  });

  it('flags every unverified asset, one issue each', () => {
    const recipe = baseRecipe();
    const issues = validateRecipeAssetsAgainstRegistry(recipe, { verifiedIdentityKeys: new Set() });
    expect(issues).toHaveLength(2);
  });

  it('downgrades to WARNING severity when explicitly requested (draft save)', () => {
    const recipe = baseRecipe();
    const issues = validateRecipeAssetsAgainstRegistry(recipe, {
      verifiedIdentityKeys: new Set(),
      severity: 'WARNING',
    });
    expect(issues.every((i) => i.severity === 'WARNING')).toBe(true);
  });

  it('is address-normalization aware — mixed-case verified key still matches', () => {
    const recipe = baseRecipe({
      assets: [asset({ symbol: 'BTC', address: '0xAbCdEf1111111111111111111111111111111111', weightBps: 10000 })],
    });
    const verifiedIdentityKeys = new Set([
      assetIdentityKey({ chain: 'ethereum', address: '0xabcdef1111111111111111111111111111111111' }),
    ]);
    const issues = validateRecipeAssetsAgainstRegistry(recipe, { verifiedIdentityKeys });
    expect(issues).toEqual([]);
  });
});
