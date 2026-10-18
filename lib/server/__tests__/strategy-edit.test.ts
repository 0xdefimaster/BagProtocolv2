import { beforeEach, describe, expect, it, vi } from 'vitest';

const getBagById = vi.fn();
const getCurrentBagVersion = vi.fn();
vi.mock('@/lib/server/bag-repo', () => ({ getBagById: (...a: unknown[]) => getBagById(...a), getCurrentBagVersion: (...a: unknown[]) => getCurrentBagVersion(...a) }));
vi.mock('@/lib/server/asset-repo', () => ({ getAssetsByIdentities: vi.fn(async () => []) }));

import { buildEditedRecipe, parseCompositionEdit } from '@/lib/server/strategy-edit';
import { resolveVersionBody } from '@/app/api/bags/[id]/versions/_shared';
import { describeVersionFailure } from '@/hooks/use-edit-strategy';

const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';
const C = '0x3333333333333333333333333333333333333333';
const recipe = {
  id: 'recipe_bag_v1',
  bagId: 'bag',
  version: 1,
  createdAt: 'x',
  name: 'Majors',
  symbol: 'MAJ',
  description: 'd',
  chain: 'robinhood',
  strategyType: 'STATIC_BASKET',
  assets: [
    { chain: 'robinhood', address: A, symbol: 'AAA', decimals: 6, weightBps: 6000 },
    { chain: 'robinhood', address: B, symbol: 'BBB', decimals: 18, weightBps: 4000 },
  ],
  rebalanceRule: { frequency: 'MANUAL', driftThresholdBps: 500, maxSlippageBps: 100 },
  minInvestment: 10,
  maxAssets: 10,
  minWeightBps: 100,
  maxWeightBps: 8000,
  mutability: 'MUTABLE',
  performanceFeeBps: 1000,
};

beforeEach(() => {
  getBagById.mockResolvedValue({ id: 'bag', chain: 'robinhood' });
  getCurrentBagVersion.mockResolvedValue({ version: 1, recipe });
});

describe('parseCompositionEdit', () => {
  it('accepts (address, integer bps) lists and nothing else', () => {
    expect(parseCompositionEdit([{ address: A, weightBps: 10_000 }])).toEqual([{ address: A, weightBps: 10_000 }]);
    for (const bad of [[], 'x', [{ address: 'nope', weightBps: 1 }], [{ address: A, weightBps: 1.5 }], [{ address: A, weightBps: -1 }], [{ address: A, weightBps: 10_001 }], [{ address: A }]]) {
      expect(parseCompositionEdit(bad)).toBeNull();
    }
  });
});

describe('buildEditedRecipe', () => {
  it('returns only the assets (the rest is derived server-side); held assets keep their stored symbol and decimals', async () => {
    const r = await buildEditedRecipe({} as never, 'bag', [
      { address: B.toUpperCase().replace('0X', '0x'), weightBps: 7000 },
      { address: A, weightBps: 3000 },
    ]);
    if (!r.ok) throw new Error(JSON.stringify(r));
    expect(Object.keys(r.recipe)).toEqual(['assets']);
    expect(r.recipe.assets).toEqual([
      { chain: 'robinhood', address: B, symbol: 'BBB', decimals: 18, weightBps: 7000 },
      { chain: 'robinhood', address: A, symbol: 'AAA', decimals: 6, weightBps: 3000 },
    ]);
  });

  it('a new asset comes from the registry only when VERIFIED on the Bag chain', async () => {
    const lookup = vi.fn(async () => [{ chain: 'robinhood', address: C, symbol: 'CCC', decimals: 8, status: 'VERIFIED' }] as never);
    const ok = await buildEditedRecipe({} as never, 'bag', [{ address: A, weightBps: 5000 }, { address: C, weightBps: 5000 }], { lookupAssets: lookup });
    if (!ok.ok) throw new Error(JSON.stringify(ok));
    expect(ok.recipe.assets[1]).toEqual({ chain: 'robinhood', address: C, symbol: 'CCC', decimals: 8, weightBps: 5000 });

    const deprecated = vi.fn(async () => [{ chain: 'robinhood', address: C, symbol: 'CCC', decimals: 8, status: 'DEPRECATED' }] as never);
    expect(await buildEditedRecipe({} as never, 'bag', [{ address: C, weightBps: 10_000 }], { lookupAssets: deprecated })).toMatchObject({ ok: false, error: 'VALIDATION_FAILED' });
  });

  it('missing Bag -> BAG_NOT_FOUND', async () => {
    getBagById.mockResolvedValue(null);
    expect(await buildEditedRecipe({} as never, 'nope', [{ address: A, weightBps: 10_000 }])).toEqual({ ok: false, error: 'BAG_NOT_FOUND' });
  });
});

describe('resolveVersionBody', () => {
  it('turns a composition body into an assets-only change, keeping reason and txHash', async () => {
    const r = await resolveVersionBody({} as never, 'bag', { composition: [{ address: A, weightBps: 10_000 }], reason: ' swap ', txHash: '0xabc' });
    if (!r.ok) throw new Error('expected ok');
    expect(r.body).toMatchObject({ reason: 'swap', txHash: '0xabc' });
    expect(Object.keys(r.body.recipe)).toEqual(['assets']);
    expect(r.body.recipe.assets).toHaveLength(1);
  });

  it('a malformed composition is a 400; an unknown asset is a 422 with the validation issues', async () => {
    const bad = await resolveVersionBody({} as never, 'bag', { composition: [{ address: 'x', weightBps: 1 }] });
    expect(bad.ok ? 0 : bad.response.status).toBe(400);
    const unknown = await resolveVersionBody({} as never, 'bag', { composition: [{ address: C, weightBps: 10_000 }] });
    expect(unknown.ok ? 0 : unknown.response.status).toBe(422);
  });

  it('a { recipe } body still works as before', async () => {
    const r = await resolveVersionBody({} as never, 'bag', { recipe: { name: 'x' } });
    expect(r.ok && r.body.recipe).toEqual({ name: 'x' });
    expect((await resolveVersionBody({} as never, 'bag', null)).ok).toBe(false);
  });
});

describe('describeVersionFailure', () => {
  it('says what to do for the common refusals', () => {
    expect(describeVersionFailure({ code: 'NO_CHANGE' })).toMatch(/Nothing changed/);
    expect(describeVersionFailure({ code: 'VALIDATION_FAILED', issues: [{ severity: 'ERROR', message: 'Weights must add up to 100%.' }] })).toBe('Weights must add up to 100%.');
    expect(describeVersionFailure({ code: 'WRONG_WALLET', expected: '0xabc' })).toMatch(/0xabc/);
    expect(describeVersionFailure({ error: 'boom' })).toBe('boom');
  });
});
