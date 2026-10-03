import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// The public Bag listing must never expose unpublished (DRAFT/ARCHIVED)
// Bags; a `status` filter is honoured only on the caller's own listing.

const listBagsMock = vi.fn();
let signedIn = false;

vi.mock('@/lib/supabase/server', () => ({ isSupabaseConfigured: () => true, supabaseAdmin: () => ({}) as never }));
vi.mock('@/lib/auth/require-session', () => ({
  requireSession: async () =>
    signedIn
      ? { ok: true, session: { userId: 'creator_1', walletAddress: '0xabc' } }
      : { ok: false, response: new Response(null, { status: 401 }) },
}));
vi.mock('@/lib/server/bag-repo', () => ({
  listBags: (...a: unknown[]) => listBagsMock(...a),
  getCurrentBagVersion: vi.fn(),
  createBag: vi.fn(),
}));
vi.mock('@/lib/server/bag-asset-context', () => ({ loadRecipeAssets: async () => new Map() }));
vi.mock('@/lib/server/user-profile-repo', () => ({ loadCreatorProfiles: async () => new Map() }));
const getNavSummariesMock = vi.fn();
const getBagSocialCountsMock = vi.fn();
vi.mock('@/lib/server/bag-nav-snapshots', () => ({ getNavSummaries: (...a: unknown[]) => getNavSummariesMock(...a) }));
vi.mock('@/lib/server/bag-social-counts', () => ({ getBagSocialCounts: (...a: unknown[]) => getBagSocialCountsMock(...a) }));

const { GET } = await import('@/app/api/bags/route');

beforeEach(() => {
  listBagsMock.mockReset().mockResolvedValue([]);
  getNavSummariesMock.mockReset().mockResolvedValue(new Map());
  getBagSocialCountsMock.mockReset().mockResolvedValue(new Map());
  signedIn = false;
});

describe('GET /api/bags', () => {
  it('ignores ?status=DRAFT on the public listing — ACTIVE only', async () => {
    await GET(new NextRequest('http://localhost/api/bags?status=DRAFT'));
    expect(listBagsMock).toHaveBeenCalledWith(expect.anything(), { creatorId: undefined, status: 'ACTIVE' });
  });

  it('honours the status filter on the caller\'s own listing', async () => {
    signedIn = true;
    await GET(new NextRequest('http://localhost/api/bags?mine=1&status=DRAFT'));
    expect(listBagsMock).toHaveBeenCalledWith(expect.anything(), { creatorId: 'creator_1', status: 'DRAFT' });
  });

  it('fills TVL, recorded returns, forks and holders from one summary call each', async () => {
    const bag = {
      id: 'bag_1', name: 'B', slug: 'b', symbol: 'B', description: '', creatorId: 'u', status: 'ACTIVE', chain: 'robinhood',
      strategyType: 'STATIC_BASKET', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    };
    listBagsMock.mockResolvedValue([bag]);
    getNavSummariesMock.mockResolvedValue(
      new Map([['bag_1', { tvl: 1.48, latestAt: '', performance: { '7D': null, '30D': null, YTD: 2.5, sinceFirst: null, firstSnapshotAt: null, snapshots: 0 } }]])
    );
    getBagSocialCountsMock.mockResolvedValue(new Map([['bag_1', { forks: 2, holders: 3 }]]));

    const res = await GET(new NextRequest('http://localhost/api/bags'));
    const [out] = (await res.json()).bags;
    expect(getNavSummariesMock).toHaveBeenCalledWith(expect.anything(), ['bag_1']);
    expect(out).toMatchObject({ tvl: 1.48, forks: 2, holders: 3, performanceRecorded: { YTD: 2.5, '7D': null } });
  });

  it('a summary failure (e.g. migration not applied) still returns the listing', async () => {
    listBagsMock.mockResolvedValue([
      { id: 'bag_1', name: 'B', slug: 'b', symbol: 'B', description: '', creatorId: 'u', status: 'ACTIVE', chain: 'robinhood', strategyType: 'STATIC_BASKET', createdAt: '', updatedAt: '' },
    ]);
    getNavSummariesMock.mockRejectedValue(new Error('function bag_nav_summaries does not exist'));
    getBagSocialCountsMock.mockRejectedValue(new Error('boom'));
    const res = await GET(new NextRequest('http://localhost/api/bags'));
    expect(res.status).toBe(200);
    const [out] = (await res.json()).bags;
    expect(out.tvl).toBe(0);
    expect(out.performanceRecorded).toBeUndefined();
  });
});
