import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// The fork route is the only way to create lineage. It must derive parent/root from the source Bag it loaded
// itself, whatever the request body says (root_bag_id decides the fork-royalty recipient).

const getBagById = vi.fn();
const getCurrentBagVersion = vi.fn();
const createForkBag = vi.fn();
const isBagNameAvailable = vi.fn();
vi.mock('@/lib/supabase/server', () => ({ isSupabaseConfigured: () => true, supabaseAdmin: () => ({}) }));
vi.mock('@/lib/auth/require-session', () => ({ requireSession: async () => ({ ok: true, session: { userId: 'forker', walletAddress: '0xf' } }) }));
vi.mock('@/lib/server/rate-limit', () => ({ checkRateLimit: async () => ({ allowed: true }), rateLimitedResponseBody: () => ({}) }));
vi.mock('@/lib/server/bag-asset-context', () => ({ loadRecipeAssets: async () => new Map() }));
const getAssetsByIdentities = vi.fn(async () => [] as unknown[]);
vi.mock('@/lib/server/asset-repo', () => ({ getAssetsByIdentities: (...a: unknown[]) => getAssetsByIdentities(...(a as [])) }));
vi.mock('@/lib/server/user-profile-repo', () => ({ loadCreatorProfiles: async () => new Map() }));
vi.mock('@/lib/mappers/bag-mapper', () => ({ mapBagRecordToApiResponse: (b: unknown) => b }));
vi.mock('@/lib/server/bag-repo', async () => ({
  ...(await vi.importActual<typeof import('@/lib/server/bag-repo')>('@/lib/server/bag-repo')),
  getBagById: (...a: unknown[]) => getBagById(...a),
  getCurrentBagVersion: (...a: unknown[]) => getCurrentBagVersion(...a),
  createForkBag: (...a: unknown[]) => createForkBag(...a),
  countRecentDraftBags: async () => 0,
  isBagNameAvailable: (...a: unknown[]) => isBagNameAvailable(...a),
}));

import { POST } from '@/app/api/bags/[id]/fork/route';
import { forkLineageOf } from '@/lib/server/bag-repo';

const source = { id: 'source', slug: 's', name: 'Source', creatorId: 'alice', status: 'ACTIVE', mutability: 'MUTABLE', rootBagId: 'original' };
const call = (body: unknown) =>
  POST(new NextRequest('http://x/api/bags/source/fork', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }), { params: Promise.resolve({ id: 'source' }) });

beforeEach(() => {
  [getBagById, getCurrentBagVersion, createForkBag, isBagNameAvailable].forEach((m) => m.mockReset());
  isBagNameAvailable.mockResolvedValue(true);
  getBagById.mockResolvedValue(source);
  getCurrentBagVersion.mockResolvedValue({ version: 3, recipe: { description: '', chain: 'robinhood', strategyType: 'STATIC_BASKET', assets: [{}], rebalanceRule: {}, minInvestment: 1, maxAssets: 10, minWeightBps: 0, maxWeightBps: 10000 } });
  createForkBag.mockResolvedValue({ ok: true, bag: { id: 'new', creatorId: 'forker' }, version: {} });
});

describe('POST /api/bags/:id/fork lineage', () => {
  it('passes the server-loaded source, ignoring any lineage in the body', async () => {
    const res = await call({ name: 'Mine', parentBagId: 'evil-parent', rootBagId: 'evil-root' });
    expect(res.status).toBe(201);
    const [, input, passedSource, passedVersion] = createForkBag.mock.calls[0];
    expect(passedSource).toBe(source);
    // Fork provenance: the exact source version the fork copied, from the server-loaded current version.
    expect(passedVersion).toBe(3);
    expect(input).not.toHaveProperty('parentBagId');
    expect(input).not.toHaveProperty('rootBagId');
    expect(JSON.stringify(input)).not.toContain('evil');
  });

  it('forkLineageOf: parent is the source, root is the source\'s root (or the source itself)', () => {
    expect(forkLineageOf({ id: 'source', rootBagId: 'original' }, 3)).toEqual({ parentBagId: 'source', rootBagId: 'original', parentBagVersion: 3 });
    expect(forkLineageOf({ id: 'original', rootBagId: null }, 1)).toEqual({ parentBagId: 'original', rootBagId: 'original', parentBagVersion: 1 });
  });
});

describe('POST /api/bags/:id/fork names (names are unique, migration 0058)', () => {
  it('without a name, takes the first free of "X (Fork)", "X (Fork 2)", …', async () => {
    isBagNameAvailable.mockImplementation(async (_admin: unknown, name: string) => name === 'Source (Fork 3)');
    expect((await call({})).status).toBe(201);
    expect(createForkBag.mock.calls[0][1].recipe.name).toBe('Source (Fork 3)');
    expect(isBagNameAvailable.mock.calls.map((c) => c[1])).toEqual(['Source (Fork)', 'Source (Fork 2)', 'Source (Fork 3)']);
  });

  it('a chosen name is used as typed (the insert decides), and a taken one comes back as 409 DUPLICATE_NAME', async () => {
    createForkBag.mockResolvedValue({ ok: false, error: 'DUPLICATE_NAME', message: 'A Bag named "Mine" already exists. Pick another name.' });
    const res = await call({ name: 'Mine' });
    expect(isBagNameAvailable).not.toHaveBeenCalled();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'DUPLICATE_NAME' });
  });
});

describe('POST /api/bags/:id/fork with the forker\'s own composition (same editor as Edit strategy)', () => {
  const HELD = '0x' + 'a'.repeat(40);
  const NEW = '0x' + 'c'.repeat(40);
  beforeEach(() => {
    getCurrentBagVersion.mockResolvedValue({
      version: 2,
      recipe: {
        description: '',
        chain: 'robinhood',
        strategyType: 'STATIC_BASKET',
        assets: [{ chain: 'robinhood', address: HELD, symbol: 'AAA', decimals: 6, weightBps: 10000 }],
        rebalanceRule: {},
        minInvestment: 1,
        maxAssets: 10,
        minWeightBps: 0,
        maxWeightBps: 10000,
      },
    });
    getAssetsByIdentities.mockReset();
    getAssetsByIdentities.mockResolvedValue([{ chain: 'robinhood', address: NEW, symbol: 'CCC', decimals: 18, status: 'VERIFIED' }]);
  });

  it('creates the draft with the chosen assets: held ones keep their stored data, new ones come from the registry', async () => {
    const res = await call({ name: 'Mine', composition: [{ address: HELD, weightBps: 4000 }, { address: NEW, weightBps: 6000 }] });
    expect(res.status).toBe(201);
    expect(createForkBag.mock.calls[0][1].recipe.assets).toEqual([
      { chain: 'robinhood', address: HELD, symbol: 'AAA', decimals: 6, weightBps: 4000 },
      { chain: 'robinhood', address: NEW, symbol: 'CCC', decimals: 18, weightBps: 6000 },
    ]);
    expect(createForkBag.mock.calls[0][1].recipe.name).toBe('Mine');
  });

  it('refuses an unverified asset (422) and a malformed composition (400); nothing is created', async () => {
    getAssetsByIdentities.mockResolvedValue([]);
    expect((await call({ composition: [{ address: NEW, weightBps: 10000 }] })).status).toBe(422);
    expect((await call({ composition: [{ address: 'nope', weightBps: 10000 }] })).status).toBe(400);
    expect(createForkBag).not.toHaveBeenCalled();
  });

  it('without a composition the source is copied as before', async () => {
    expect((await call({ name: 'Copy' })).status).toBe(201);
    expect(createForkBag.mock.calls[0][1].recipe.assets).toEqual([{ chain: 'robinhood', address: HELD, symbol: 'AAA', decimals: 6, weightBps: 10000 }]);
    expect(getAssetsByIdentities).not.toHaveBeenCalled();
  });
});
