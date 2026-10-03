import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { CanonicalAsset } from '@/types/basket-protocol';

// -----------------------------------------------------------------------------
// Phase 17 — route-level tests for `GET /api/assets`, the first read path
// from the Phase 16 asset registry out to the client (feeds Create Basket's
// `AssetSelector`). Placed under `lib/server/__tests__` importing the route
// handler from its real `app/api/...` path — same convention as
// trades-route.test.ts (vitest.config.ts's `include` is scoped to
// `lib/**/*.test.ts`).
// -----------------------------------------------------------------------------

const listAssetsMock = vi.fn();
const isSupabaseConfiguredMock = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  isSupabaseConfigured: () => isSupabaseConfiguredMock(),
  supabaseAdmin: () => ({}) as never,
}));

vi.mock('@/lib/server/asset-repo', () => ({
  listAssets: (...args: unknown[]) => listAssetsMock(...args),
}));

import { GET } from '@/app/api/assets/route';

function getRequest(query = ''): NextRequest {
  return new NextRequest(`http://localhost/api/assets${query}`);
}

function asset(overrides: Partial<CanonicalAsset> = {}): CanonicalAsset {
  return {
    id: 'asset_1',
    chain: 'robinhood',
    address: '0xaaaa000000000000000000000000000000aaaa',
    symbol: 'NVDA',
    decimals: 18,
    name: 'NVIDIA',
    status: 'VERIFIED',
    assetType: 'stock',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  isSupabaseConfiguredMock.mockReturnValue(true);
  listAssetsMock.mockResolvedValue([]);
});

describe('GET /api/assets', () => {
  it('returns an empty list, not an error, when Supabase is not configured (dev/local fallback)', async () => {
    isSupabaseConfiguredMock.mockReturnValue(false);

    const res = await GET(getRequest());
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.assets).toEqual([]);
    expect(listAssetsMock).not.toHaveBeenCalled();
  });

  it('always queries VERIFIED only — never UNKNOWN or DEPRECATED', async () => {
    await GET(getRequest());

    expect(listAssetsMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ status: 'VERIFIED' }));
  });

  it('with no ?chain filter, does not restrict by chain', async () => {
    await GET(getRequest());

    const options = listAssetsMock.mock.calls[0][1];
    expect(options.chain).toBeUndefined();
  });

  it('with ?chain=robinhood, filters to that chain only', async () => {
    await GET(getRequest('?chain=robinhood'));

    expect(listAssetsMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: 'VERIFIED', chain: 'robinhood' })
    );
  });

  it('an unrecognized ?chain value is ignored (not passed through as a filter)', async () => {
    await GET(getRequest('?chain=not-a-real-chain'));

    const options = listAssetsMock.mock.calls[0][1];
    expect(options.chain).toBeUndefined();
  });

  it('returns the registry assets as-is in the response body', async () => {
    const nvda = asset({ symbol: 'NVDA' });
    const aapl = asset({ id: 'asset_2', symbol: 'AAPL', address: '0xbbbb000000000000000000000000000000bbbb' });
    listAssetsMock.mockResolvedValue([nvda, aapl]);

    const res = await GET(getRequest());
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.assets).toEqual([nvda, aapl]);
  });
});
