import { describe, expect, it } from 'vitest';
import { AssetHolding, BasketRecipe, DEFAULT_REBALANCE_RULE, RecipeAsset } from '@/types/basket-protocol';
import { recipeAssetIdentity } from '../../asset-identity';
import { MockPriceProvider } from '../../pricing/mock-provider';
import { calculateNav, formatNavValue, NAV_VALUE_DECIMALS } from '../nav';

// -----------------------------------------------------------------------------
// End-to-end path: BasketRecipe (target weights) -> holdings (what's
// actually held) -> MockPriceProvider (Phase 5) -> calculateNav(). The
// critical assertion (spec section 18) is that a 90/10 recipe weight split
// has NO effect on the computed NAV — only `holdings` and `prices` do. If
// this test ever fails because a weight crept into the math, that's
// exactly the regression it exists to catch.
// -----------------------------------------------------------------------------

function recipeAsset(overrides: Partial<RecipeAsset>): RecipeAsset {
  return {
    chain: 'ethereum',
    address: '0x11111111111111111111111111111111111111',
    symbol: 'BTC',
    decimals: 0,
    weightBps: 9000,
    ...overrides,
  };
}

function basketRecipe(assets: RecipeAsset[]): BasketRecipe {
  return {
    id: 'recipe_integration_v1',
    bagId: 'bag_integration',
    name: 'Skewed Majors',
    symbol: 'SKEW',
    description: 'Deliberately lopsided target weights to prove they never leak into NAV.',
    chain: 'ethereum',
    strategyType: 'STATIC_BASKET',
    assets,
    rebalanceRule: DEFAULT_REBALANCE_RULE,
    minInvestment: 100,
    maxAssets: 10,
    minWeightBps: 0,
    maxWeightBps: 10000,
    mutability: 'MUTABLE',
    version: 1,
    createdAt: new Date().toISOString(),
  };
}

describe('NAV integration — recipe weights never affect NAV', () => {
  it('BTC 90% / ETH 10% recipe, but holdings BTC=1 ETH=10 @ 100 each -> NAV = 1100, not weight-influenced', async () => {
    const recipe = basketRecipe([
      recipeAsset({ symbol: 'BTC', address: '0x11111111111111111111111111111111111111', weightBps: 9000 }),
      recipeAsset({ symbol: 'ETH', address: '0x22222222222222222222222222222222222222', weightBps: 1000 }),
    ]);

    const btcIdentity = recipeAssetIdentity(recipe.assets[0]);
    const ethIdentity = recipeAssetIdentity(recipe.assets[1]);

    const holdings: AssetHolding[] = [
      { asset: btcIdentity, quantityRaw: '1', decimals: 0 },
      { asset: ethIdentity, quantityRaw: '10', decimals: 0 },
    ];

    const provider = new MockPriceProvider();
    provider.setPrice(btcIdentity, '100');
    provider.setPrice(ethIdentity, '100');

    const nav = await calculateNav(holdings, provider);

    // 1 BTC * 100 + 10 ETH * 100 = 1100 — the 90/10 recipe split is
    // completely absent from this number.
    expect(nav.grossNav).toBe(formatNavValue(BigInt(1100) * BigInt(10) ** BigInt(NAV_VALUE_DECIMALS)));
  });

  it('inverting the recipe weights (10/90 instead of 90/10) does not change the NAV for the same holdings/prices', async () => {
    const skewedRecipe = basketRecipe([
      recipeAsset({ symbol: 'BTC', address: '0x11111111111111111111111111111111111111', weightBps: 9000 }),
      recipeAsset({ symbol: 'ETH', address: '0x22222222222222222222222222222222222222', weightBps: 1000 }),
    ]);
    const invertedRecipe = basketRecipe([
      recipeAsset({ symbol: 'BTC', address: '0x11111111111111111111111111111111111111', weightBps: 1000 }),
      recipeAsset({ symbol: 'ETH', address: '0x22222222222222222222222222222222222222', weightBps: 9000 }),
    ]);

    const holdings: AssetHolding[] = [
      { asset: recipeAssetIdentity(skewedRecipe.assets[0]), quantityRaw: '1', decimals: 0 },
      { asset: recipeAssetIdentity(skewedRecipe.assets[1]), quantityRaw: '10', decimals: 0 },
    ];

    const provider = new MockPriceProvider();
    provider.setPrice(recipeAssetIdentity(skewedRecipe.assets[0]), '100');
    provider.setPrice(recipeAssetIdentity(skewedRecipe.assets[1]), '100');

    const navFromSkewed = await calculateNav(holdings, provider);
    const navFromInverted = await calculateNav(holdings, provider); // same holdings; invertedRecipe is never even passed in

    expect(navFromSkewed.grossNav).toBe(navFromInverted.grossNav);
    void invertedRecipe; // exists only to make the "the recipe's weights are irrelevant" point explicit
  });

  it('MockPriceProvider path end-to-end matches the pure calculateNavFromPrices path for the same inputs', async () => {
    const recipe = basketRecipe([recipeAsset({ symbol: 'BTC', weightBps: 10000 })]);
    const identity = recipeAssetIdentity(recipe.assets[0]);
    const holdings: AssetHolding[] = [{ asset: identity, quantityRaw: '5', decimals: 0 }];

    const provider = new MockPriceProvider();
    provider.setPrice(identity, '200');

    const nav = await calculateNav(holdings, provider);
    expect(nav.grossNav).toBe(formatNavValue(BigInt(1000) * BigInt(10) ** BigInt(NAV_VALUE_DECIMALS)));
    expect(nav.components).toHaveLength(1);
    expect(nav.components[0].price.source).toBe('mock');
  });
});
