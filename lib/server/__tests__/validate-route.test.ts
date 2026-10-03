import { beforeEach, describe, expect, it, vi } from 'vitest';

const getAssetsByIdentities = vi.fn();
vi.mock('@/lib/supabase/server', () => ({ isSupabaseConfigured: () => true, supabaseAdmin: () => ({}) }));
vi.mock('@/lib/server/asset-repo', () => ({ getAssetsByIdentities: (...a: unknown[]) => getAssetsByIdentities(...a) }));
vi.mock('@/lib/server/rate-limit', () => ({
  checkRateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
  getClientIp: () => '1.2.3.4',
  rateLimitedResponseBody: () => ({}),
}));

import { POST } from '@/app/api/bags/validate/route';

const A = '0x00000000000000000000000000000000000000a1';
const post = (body: unknown) => POST(new Request('http://x/api/bags/validate', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }));

beforeEach(() => {
  getAssetsByIdentities.mockReset();
  getAssetsByIdentities.mockResolvedValue([
    { id: 'a', chain: 'robinhood', address: A, symbol: 'NVDA', decimals: 18, name: 'NVIDIA', status: 'VERIFIED', assetType: 'stock', routeStatus: 'ROUTABLE', createdAt: '', updatedAt: '' },
  ]);
});

describe('POST /api/bags/validate', () => {
  it('returns the machine-readable validation result', async () => {
    const res = await post({ assets: [{ address: A, weightBps: 10000 }], policy: { maxSingleAssetWeightBps: 10000 } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ schemaVersion: 2, valid: true, policy: { schemaVersion: 2 } });
    expect(Array.isArray(body.checks)).toBe(true);
  });

  it('only well-formed addresses reach the registry query', async () => {
    await post({ assets: [{ address: A, weightBps: 5000 }, { address: 'x),or(status.eq.UNKNOWN', weightBps: 5000 }] });
    expect(getAssetsByIdentities.mock.calls[0][1]).toEqual([{ chain: 'robinhood', address: A }]);
  });

  it('400s a malformed body', async () => {
    expect((await post('not json')).status).toBe(400);
    expect((await post({ assets: 'nope' })).status).toBe(400);
  });
});
