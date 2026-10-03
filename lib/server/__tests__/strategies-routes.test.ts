import { beforeEach, describe, expect, it, vi } from 'vitest';

const getBagById = vi.fn();
const getSession = vi.fn();
const loadStrategyObject = vi.fn();
const loadStrategyVersionRows = vi.fn();
const bagExecutions = vi.fn();
vi.mock('@/lib/supabase/server', () => ({ isSupabaseConfigured: () => true, supabaseAdmin: () => ({}) }));
vi.mock('@/lib/server/bag-repo', () => ({ getBagById: (...a: unknown[]) => getBagById(...a) }));
vi.mock('@/lib/auth/session', () => ({ getSession: () => getSession() }));
vi.mock('@/lib/server/rate-limit', () => ({ checkRateLimit: async () => ({ allowed: true }), getClientIp: () => 'ip', rateLimitedResponseBody: () => ({}) }));
vi.mock('@/lib/server/asset-repo', () => ({ getAssetsByIdentities: async () => [] }));
vi.mock('@/app/api/bags/[id]/executions/route', () => ({ GET: (...a: unknown[]) => bagExecutions(...a) }));
vi.mock('@/lib/server/strategy-api', async (orig) => ({
  ...(await orig<typeof import('@/lib/server/strategy-api')>()),
  loadStrategyObject: (...a: unknown[]) => loadStrategyObject(...a),
  loadStrategyVersionRows: (...a: unknown[]) => loadStrategyVersionRows(...a),
}));
vi.mock('@/lib/server/purchase-execution', () => ({ bagSlippageBps: () => 100 }));

import { GET as getStrategy } from '@/app/api/strategies/[id]/route';
import { GET as getVersions } from '@/app/api/strategies/[id]/versions/route';
import { GET as getVersion } from '@/app/api/strategies/[id]/versions/[version]/route';
import { POST as validate } from '@/app/api/strategies/validate/route';
import { GET as myExecutions } from '@/app/api/users/me/strategies/[id]/executions/route';

const ID = '11111111-1111-4111-8111-111111111111';
const params = <T>(p: T) => ({ params: Promise.resolve(p) });
const row = { id: 'row-v1', version: 1, created_at: '2026-09-01T00:00:00Z', reason: 'Initial', onchain_tx_hash: null, onchain_composition_hash: null,
  recipe: { chain: 'robinhood', name: 'n', symbol: 's', description: 'd', assets: [{ chain: 'robinhood', address: '0x' + '11'.repeat(20), symbol: 'X', decimals: 18, weightBps: 10000 }] } };

beforeEach(() => {
  [getBagById, getSession, loadStrategyObject, loadStrategyVersionRows, bagExecutions].forEach((m) => m.mockReset());
  getBagById.mockResolvedValue({ id: ID, status: 'ACTIVE', creatorId: 'alice', chain: 'robinhood', currentVersionId: 'row-v1', parentBagId: null });
  getSession.mockResolvedValue(null);
  loadStrategyObject.mockResolvedValue({ schemaVersion: 1 });
  loadStrategyVersionRows.mockResolvedValue([row]);
  bagExecutions.mockResolvedValue(new Response('{}', { status: 200 }));
});

describe('GET /api/strategies/:id*', () => {
  it('a malformed id is 404 without touching the database', async () => {
    for (const id of ['bag-1', `${ID}x`, "1' or '1'='1"]) {
      expect((await getStrategy({} as never, params({ id }))).status).toBe(404);
      expect((await getVersions({} as never, params({ id }))).status).toBe(404);
      expect((await getVersion({} as never, params({ id, version: '1' }))).status).toBe(404);
    }
    expect(getBagById).not.toHaveBeenCalled();
  });

  it('serves an ACTIVE strategy to anyone, passing the viewer', async () => {
    getSession.mockResolvedValue({ userId: 'carol' });
    const res = await getStrategy({} as never, params({ id: ID }));
    expect(res.status).toBe(200);
    expect(loadStrategyObject.mock.calls[0][2]).toBe('carol');
  });

  it('a non-public strategy is 404 for everyone but its creator, on every route (same body as missing)', async () => {
    getBagById.mockResolvedValue({ id: ID, status: 'DRAFT', creatorId: 'alice', chain: 'robinhood', currentVersionId: 'row-v1', parentBagId: null });
    getSession.mockResolvedValue({ userId: 'mallory' });
    const hidden = await getStrategy({} as never, params({ id: ID }));
    expect(hidden.status).toBe(404);
    expect((await getVersions({} as never, params({ id: ID }))).status).toBe(404);
    expect((await getVersion({} as never, params({ id: ID, version: '1' }))).status).toBe(404);
    getBagById.mockResolvedValue(null);
    const missing = await getStrategy({} as never, params({ id: ID }));
    expect(await missing.json()).toEqual(await hidden.json());
    getBagById.mockResolvedValue({ id: ID, status: 'DRAFT', creatorId: 'alice', chain: 'robinhood', currentVersionId: 'row-v1', parentBagId: null });
    getSession.mockResolvedValue({ userId: 'alice' });
    expect((await getStrategy({} as never, params({ id: ID }))).status).toBe(200);
  });

  it('versions list and one version as bag.json; unknown or malformed versions are 404', async () => {
    const list = await (await getVersions({} as never, params({ id: ID }))).json();
    expect(list).toMatchObject({ schemaVersion: 1, strategyId: ID, currentVersion: 1 });
    const doc = await (await getVersion({} as never, params({ id: ID, version: '1' }))).json();
    expect(doc).toMatchObject({ bagJson: 1, ref: { strategyId: ID, version: 1 } });
    for (const version of ['2', '0', '-1', '1.0', 'abc', '01', '9999999999']) {
      expect((await getVersion({} as never, params({ id: ID, version }))).status, version).toBe(404);
    }
  });
});

describe('POST /api/strategies/validate', () => {
  const post = (body: unknown) => validate(new Request('http://x/api/strategies/validate', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }));
  it('400 on invalid JSON or a non-bag.json body; 200 with hash and findings otherwise', async () => {
    expect((await post('{')).status).toBe(400);
    expect((await post({ assets: [] })).status).toBe(400);
    const def = {
      kind: null, chain: 'robinhood', mutability: null, assets: [{ chain: 'robinhood', address: '0x' + '11'.repeat(20), symbol: 'X', decimals: 18, weightBps: 10000 }],
      rules: { weightBounds: { minBps: null, maxBps: null }, maxAssets: null, minInvestment: null, swapSlippageBps: null, rebalance: null, performanceFeeBps: null, noRouteAssetPolicy: null },
    };
    const res = await post({ definition: def });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.definitionHash).toMatch(/^0x[0-9a-f]{64}$/);
    // Empty registry: the asset is unknown, so the definition is not valid.
    expect(body.validation.valid).toBe(false);
  });
});

describe('GET /api/users/me/strategies/:id/executions', () => {
  it('delegates to the personal executions handler (same auth, scope and pagination)', async () => {
    const req = { nextUrl: new URL(`http://x/api/users/me/strategies/${ID}/executions?limit=5`) };
    expect((await myExecutions(req as never, params({ id: ID.toUpperCase() }))).status).toBe(200);
    expect(bagExecutions).toHaveBeenCalledTimes(1);
    expect(await bagExecutions.mock.calls[0][1].params).toEqual({ id: ID });
    expect(bagExecutions.mock.calls[0][0]).toBe(req);
  });

  it('a malformed id is 404 and never reaches the handler', async () => {
    expect((await myExecutions({} as never, params({ id: 'nope' }))).status).toBe(404);
    expect(bagExecutions).not.toHaveBeenCalled();
  });
});
