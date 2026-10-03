import { describe, expect, it } from 'vitest';
import { deriveStrategyPolicy } from '../strategy-policy';
import { bagSlippageBps } from '../purchase-execution';
import { BasketRecipe, DEFAULT_REBALANCE_RULE } from '@/types/basket-protocol';

const recipe = (over: Partial<BasketRecipe> = {}) =>
  ({
    assets: [],
    maxWeightBps: 3000,
    minWeightBps: 100,
    maxAssets: 10,
    minInvestment: 25,
    rebalanceRule: { ...DEFAULT_REBALANCE_RULE, maxSlippageBps: 80 },
    performanceFeeBps: 1000,
    unroutablePolicy: 'HOLD_INPUT',
    ...over,
  }) as BasketRecipe;
const ctx = { mutability: 'MUTABLE' as const, deployed: false, performanceFeeBpsLocked: null };

describe('deriveStrategyPolicy', () => {
  it('reports each rule with its value, value source, enforcement and where it is checked', () => {
    const p = deriveStrategyPolicy(recipe(), ctx);
    expect(p.schemaVersion).toBe(1);
    expect(p.maxSingleAssetWeightBps).toEqual({ value: 3000, source: 'CREATOR_RECIPE', enforcement: 'SERVER_ENFORCED', enforcedAt: ['VERSION_CREATE'], status: 'ACTIVE' });
    expect(p.minInvestmentUsd).toMatchObject({ value: 25, enforcement: 'SERVER_ENFORCED', enforcedAt: ['PURCHASE_CREATE'] });
    expect(p.maxSlippageBps).toMatchObject({ value: 80, source: 'CREATOR_RECIPE', enforcement: 'ONCHAIN_ENFORCED', enforcedAt: ['PURCHASE_TRANSACTION'] });
    expect(p.maxPriceImpactBps).toMatchObject({ value: 500, source: 'LIFI_COMPOSER', enforcement: 'COMPOSER_ENFORCED', consentCeilingBps: 1500 });
    expect(p.performanceFeeBps).toMatchObject({ value: 1000, enforcement: 'DATABASE_TRIGGER', status: 'ACTIVE', maxBps: 3000 });
    expect(p.noRouteAssetPolicy).toMatchObject({ value: 'HOLD_INPUT', source: 'CREATOR_RECIPE', enforcement: 'SERVER_ENFORCED', maxUnroutableWeightBps: 3000 });
    expect(p.rebalanceRule).toMatchObject({ enforcement: 'DECLARED_ONLY', status: 'NOT_EXECUTED', enforcedAt: [] });
    expect(p.compositionChanges).toMatchObject({ value: 'CREATOR_EDITABLE', enforcement: 'DATABASE_TRIGGER' });
  });

  it('only the per-swap slippage floor is claimed as on-chain enforced', () => {
    const onchain = Object.entries(deriveStrategyPolicy(recipe(), ctx)).filter(([, r]) => typeof r === 'object' && r.enforcement === 'ONCHAIN_ENFORCED');
    expect(onchain.map(([k]) => k)).toEqual(['maxSlippageBps']);
  });

  it('slippage is exactly what a purchase uses (bagSlippageBps), including the clamp and the protocol default', () => {
    for (const s of [undefined, 0, 5, 80, 250, 900]) {
      const r = recipe({ rebalanceRule: { ...DEFAULT_REBALANCE_RULE, maxSlippageBps: s as number } });
      const p = deriveStrategyPolicy(r, ctx);
      expect(p.maxSlippageBps.value).toBe(bagSlippageBps({ recipe: r }));
    }
    const fallback = deriveStrategyPolicy(recipe({ rebalanceRule: { ...DEFAULT_REBALANCE_RULE, maxSlippageBps: 0 } }), ctx);
    expect(fallback.maxSlippageBps.source).toBe('BAG_PROTOCOL');
  });

  it('a locked fee, an immutable Bag, a deployed Bag and a missing no-route choice', () => {
    expect(deriveStrategyPolicy(recipe(), { ...ctx, performanceFeeBpsLocked: 500 }).performanceFeeBps).toMatchObject({ value: 500, status: 'LOCKED' });
    expect(deriveStrategyPolicy(recipe(), { ...ctx, mutability: 'IMMUTABLE' }).compositionChanges).toMatchObject({ value: 'IMMUTABLE', status: 'LOCKED' });
    expect(deriveStrategyPolicy(recipe(), { ...ctx, deployed: true }).compositionChanges.value).toBe('ONCHAIN_VERSION_ONLY');
    expect(deriveStrategyPolicy(recipe({ unroutablePolicy: undefined }), ctx).noRouteAssetPolicy).toMatchObject({ value: 'BLOCK', source: 'BAG_PROTOCOL' });
  });
});
