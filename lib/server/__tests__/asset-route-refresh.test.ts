import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanonicalAsset } from '@/types/basket-protocol';

const listAssetsMock = vi.fn();
const updateAssetRouteStatusMock = vi.fn();
vi.mock('../asset-repo', () => ({
  listAssets: (...a: unknown[]) => listAssetsMock(...a),
  updateAssetRouteStatus: (...a: unknown[]) => updateAssetRouteStatusMock(...a),
}));
vi.mock('../asset-route-check', () => ({ checkAssetRoute: vi.fn() }));

const { pickAssetsToCheck, refreshAssetRouteStatuses } = await import('../asset-route-refresh');

const asset = (id: string, routeCheckedAt?: string): CanonicalAsset => ({
  id,
  chain: 'robinhood',
  address: `0x${id.padStart(40, '0')}`,
  symbol: id,
  decimals: 18,
  name: id,
  status: 'VERIFIED',
  assetType: 'stock',
  routeCheckedAt,
  createdAt: '',
  updatedAt: '',
});

describe('pickAssetsToCheck', () => {
  it('takes never-checked first, then oldest, skipping fresh ones, up to the limit', () => {
    const now = Date.parse('2026-09-29T12:00:00Z');
    const picked = pickAssetsToCheck(
      [asset('a', '2026-09-29T11:00:00Z'), asset('b'), asset('c', '2026-09-28T00:00:00Z'), asset('d', '2026-09-29T02:00:00Z')],
      now,
      2,
      6 * 60 * 60 * 1000
    );
    expect(picked.map((a) => a.id)).toEqual(['b', 'c']);
  });
});

describe('refreshAssetRouteStatuses', () => {
  beforeEach(() => vi.clearAllMocks());

  it('stores ROUTABLE / NO_ROUTE and leaves UNKNOWN untouched for a retry', async () => {
    listAssetsMock.mockResolvedValue([asset('a'), asset('b'), asset('c')]);
    const statuses: Record<string, 'ROUTABLE' | 'NO_ROUTE' | 'UNKNOWN'> = {
      [asset('a').address]: 'ROUTABLE',
      [asset('b').address]: 'NO_ROUTE',
      [asset('c').address]: 'UNKNOWN',
    };
    const result = await refreshAssetRouteStatuses({} as never, { concurrency: 2 }, async (a) => statuses[a.address]);

    expect(result).toEqual({ checked: 3, routable: 1, noRoute: 1, unknown: 1 });
    expect(updateAssetRouteStatusMock.mock.calls.map((c) => [c[1], c[2]]).sort()).toEqual([
      ['a', 'ROUTABLE'],
      ['b', 'NO_ROUTE'],
    ]);
  });
});
