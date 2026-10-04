import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// The fork route is the only way to create lineage. It must derive parent/root from the source Bag it loaded
// itself, whatever the request body says (root_bag_id decides the fork-royalty recipient).

const getBagById = vi.fn();
const getCurrentBagVersion = vi.fn();
const createForkBag = vi.fn();
vi.mock('@/lib/supabase/server', () => ({ isSupabaseConfigured: () => true, supabaseAdmin: () => ({}) }));
vi.mock('@/lib/auth/require-session', () => ({ requireSession: async () => ({ ok: true, session: { userId: 'forker', walletAddress: '0xf' } }) }));
vi.mock('@/lib/server/rate-limit', () => ({ checkRateLimit: async () => ({ allowed: true }), rateLimitedResponseBody: () => ({}) }));
vi.mock('@/lib/server/bag-asset-context', () => ({ loadRecipeAssets: async () => new Map() }));
vi.mock('@/lib/server/user-profile-repo', () => ({ loadCreatorProfiles: async () => new Map() }));
vi.mock('@/lib/mappers/bag-mapper', () => ({ mapBagRecordToApiResponse: (b: unknown) => b }));
vi.mock('@/lib/server/bag-repo', async () => ({
  ...(await vi.importActual<typeof import('@/lib/server/bag-repo')>('@/lib/server/bag-repo')),
  getBagById: (...a: unknown[]) => getBagById(...a),
  getCurrentBagVersion: (...a: unknown[]) => getCurrentBagVersion(...a),
  createForkBag: (...a: unknown[]) => createForkBag(...a),
  countRecentDraftBags: async () => 0,
}));

import { POST } from '@/app/api/bags/[id]/fork/route';
import { forkLineageOf } from '@/lib/server/bag-repo';

const source = { id: 'source', slug: 's', name: 'Source', creatorId: 'alice', status: 'ACTIVE', mutability: 'MUTABLE', rootBagId: 'original' };
const call = (body: unknown) =>
  POST(new NextRequest('http://x/api/bags/source/fork', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }), { params: Promise.resolve({ id: 'source' }) });

beforeEach(() => {
  [getBagById, getCurrentBagVersion, createForkBag].forEach((m) => m.mockReset());
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
