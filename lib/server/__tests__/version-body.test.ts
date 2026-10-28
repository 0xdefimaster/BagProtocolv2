import { describe, expect, it } from 'vitest';
import { deriveVersionBody, sameBody } from '@/lib/server/bag-versioning';
import type { BasketRecipe } from '@/types/basket-protocol';

const A = { chain: 'robinhood' as const, address: '0x' + 'a'.repeat(40), symbol: 'AAA', decimals: 6, weightBps: 6000 };
const B = { chain: 'robinhood' as const, address: '0x' + 'b'.repeat(40), symbol: 'BBB', decimals: 18, weightBps: 4000 };
const current = {
  id: 'recipe_x_v1',
  bagId: 'x',
  version: 1,
  createdAt: '2026-01-01T00:00:00Z',
  name: 'N',
  symbol: 'S',
  description: 'd',
  chain: 'robinhood',
  strategyType: 'STATIC_BASKET',
  assets: [A, B],
  rebalanceRule: { frequency: 'MANUAL', driftThresholdBps: 500, maxSlippageBps: 100 },
  minInvestment: 10,
  maxAssets: 2,
  minWeightBps: 100,
  maxWeightBps: 8000,
  mutability: 'MUTABLE',
  performanceFeeBps: 1000,
} as BasketRecipe;

describe('deriveVersionBody', () => {
  it('replaces only the assets (canonical order, hashed fields only), drops per-call fields, raises maxAssets to fit', () => {
    const body = deriveVersionBody(current, [{ ...B, weightBps: 5000, extra: 'x' } as never, { ...A, weightBps: 5000 }]);
    expect(body).not.toHaveProperty('id');
    expect(body).not.toHaveProperty('version');
    expect(body).not.toHaveProperty('createdAt');
    expect(body.assets).toEqual([{ ...A, weightBps: 5000 }, { ...B, weightBps: 5000 }]);
    expect(body).toMatchObject({ name: 'N', performanceFeeBps: 1000, rebalanceRule: current.rebalanceRule, minInvestment: 10, maxAssets: 10 });
  });

  it('is deterministic: same current version + same assets in any order → same body', () => {
    expect(sameBody(deriveVersionBody(current, [A, B]), deriveVersionBody(current, [B, A]))).toBe(true);
    expect(sameBody(deriveVersionBody(current, [A, B]), deriveVersionBody({ ...current, minInvestment: 11 }, [A, B]))).toBe(false);
  });

  it('sameBody compares by value, ignoring key order and undefined keys', () => {
    expect(sameBody({ a: 1, b: { c: [1, 2] } }, { b: { c: [1, 2] }, a: 1, d: undefined })).toBe(true);
    expect(sameBody({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
  });
});
