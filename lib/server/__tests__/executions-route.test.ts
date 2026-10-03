import { beforeEach, describe, expect, it, vi } from 'vitest';

const getBagById = vi.fn();
const requireSession = vi.fn();
const listPurchase = vi.fn();
const listRedeem = vi.fn();
vi.mock('@/lib/supabase/server', () => ({ isSupabaseConfigured: () => true, supabaseAdmin: () => fakeAdmin }));
vi.mock('@/lib/auth/require-session', () => ({ requireSession: () => requireSession() }));
vi.mock('@/lib/server/bag-repo', () => ({ getBagById: (...a: unknown[]) => getBagById(...a) }));
vi.mock('@/lib/server/purchase-intent-repo', () => ({ listPurchaseIntentsForUserBag: (...a: unknown[]) => listPurchase(...a) }));
vi.mock('@/lib/server/redeem-intent-repo', () => ({ listRedeemIntentsForUserBag: (...a: unknown[]) => listRedeem(...a) }));
vi.mock('@/lib/server/asset-repo', () => ({ getAssetsByIdentities: async () => [] }));

// Minimal supabase-js stand-in for the two read queries (claims, version hashes).
const fakeAdmin = {
  from: (table: string) => {
    const result = table === 'bag_versions' ? [{ version: 1, composition_hash: 'h1' }] : [];
    const q = { select: () => q, eq: () => q, in: () => q, then: (r: (v: unknown) => unknown) => Promise.resolve({ data: result, error: null }).then(r) };
    return q;
  },
};

import { GET } from '@/app/api/bags/[id]/executions/route';

const TX = '0x' + 'ab'.repeat(32);
const intent = (id: string, userId: string, bagId: string, txHash: string | null = TX) => ({
  id, userId, walletAddress: '0xw', bagId, inputAsset: { chain: 'robinhood', address: '0x' + '11'.repeat(20) }, inputAmountRaw: '1', sharesRaw: '1', shareDecimals: 18,
  recipeVersion: 1, compositionHash: 'h1', steps: [{ stepIndex: 0, action: 'SWAP', inputAsset: { chain: 'robinhood', address: '0x' + '11'.repeat(20) }, outputAsset: { chain: 'robinhood', address: '0x' + '22'.repeat(20) }, sourceChain: 'robinhood', destinationChain: 'robinhood', inputAmountRaw: '1', outputAmountRaw: '1', outputDecimals: 18, minOutputRaw: '1', lifiStep: null, status: 'COMPLETED', approvalTxHash: null, txHash }],
  composerTransaction: { to: '', data: '', value: '0', chainId: 4663, userProxy: '' }, bagRouterTransaction: null, providerId: null, executionPlanHash: null, fallback: null,
  status: 'COMPLETED', createdAt: '2026-10-01T00:00:00Z', executedAt: null,
});
const call = (id = 'bag-1') => GET({} as never, { params: Promise.resolve({ id }) });

beforeEach(() => {
  [getBagById, requireSession, listPurchase, listRedeem].forEach((m) => m.mockReset());
  requireSession.mockResolvedValue({ ok: true, session: { userId: 'alice' } });
  getBagById.mockResolvedValue({ id: 'bag-1', status: 'ACTIVE', creatorId: 'bob' });
  listPurchase.mockResolvedValue([]);
  listRedeem.mockResolvedValue([]);
});

describe('GET /api/bags/:id/executions', () => {
  it('requires a session', async () => {
    requireSession.mockResolvedValue({ ok: false, response: new Response(null, { status: 401 }) });
    expect((await call()).status).toBe(401);
  });

  it('returns only the viewer\'s own executions in this Bag, versioned, with no internal user id', async () => {
    listPurchase.mockResolvedValue([intent('mine', 'alice', 'bag-1'), intent('theirs', 'carol', 'bag-1'), intent('other-bag', 'alice', 'bag-2'), intent('never-sent', 'alice', 'bag-1', null)]);
    const res = await call();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ schemaVersion: 1, bagId: 'bag-1', scope: 'VIEWER_OWN_EXECUTIONS' });
    expect(body.executions.map((e: { executionId: string }) => e.executionId)).toEqual(['mine']);
    expect(listPurchase.mock.calls[0].slice(1, 3)).toEqual(['alice', 'bag-1']);
    expect(JSON.stringify(body)).not.toContain('"alice"');
  });

  it('a non-public Bag is 404 unless the viewer created it or has executions in it', async () => {
    getBagById.mockResolvedValue({ id: 'bag-1', status: 'ARCHIVED', creatorId: 'bob' });
    expect((await call()).status).toBe(404);
    listPurchase.mockResolvedValue([intent('mine', 'alice', 'bag-1')]);
    expect((await call()).status).toBe(200);
    listPurchase.mockResolvedValue([]);
    requireSession.mockResolvedValue({ ok: true, session: { userId: 'bob' } });
    expect((await call()).status).toBe(200);
  });

  it('404s an unknown Bag', async () => {
    getBagById.mockResolvedValue(null);
    expect((await call('missing')).status).toBe(404);
  });
});
