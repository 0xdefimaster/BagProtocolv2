import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const session = vi.fn();
const recoverBagVersions = vi.fn();
const getBagVersionStatus = vi.fn();
vi.mock('@/lib/supabase/server', () => ({ isSupabaseConfigured: () => true, supabaseAdmin: () => ({}) }));
vi.mock('@/lib/auth/require-session', () => ({ requireSession: async () => session() }));
vi.mock('@/lib/server/rate-limit', () => ({ checkRateLimit: async () => ({ allowed: true }), rateLimitedResponseBody: () => ({}) }));
vi.mock('@/lib/server/bag-version-recovery', () => ({
  recoverBagVersions: (...a: unknown[]) => recoverBagVersions(...a),
  getBagVersionStatus: (...a: unknown[]) => getBagVersionStatus(...a),
}));

import { POST } from '@/app/api/bags/[id]/versions/recover/route';
import { GET } from '@/app/api/bags/[id]/versions/status/route';

const ctx = { params: Promise.resolve({ id: 'bag1' }) };
const post = (body: unknown) => POST(new NextRequest('http://x/api/bags/bag1/versions/recover', { method: 'POST', body: JSON.stringify(body) }), ctx);

beforeEach(() => {
  [session, recoverBagVersions, getBagVersionStatus].forEach((m) => m.mockReset());
  session.mockReturnValue({ ok: true, session: { userId: 'u1', walletAddress: '0xabc' } });
});

describe('version recovery routes', () => {
  it('need a session', async () => {
    session.mockReturnValue({ ok: false, response: NextResponse.json({ error: 'no' }, { status: 401 }) });
    expect((await post({})).status).toBe(401);
    expect((await GET(new NextRequest('http://x'), ctx)).status).toBe(401);
    expect(recoverBagVersions).not.toHaveBeenCalled();
  });

  it('pass the session user (never a body field) and an optional hash; map refusals', async () => {
    recoverBagVersions.mockResolvedValue({ ok: false, error: 'FORBIDDEN' });
    const res = await post({ txHash: ' 0xdead ', userId: 'evil' });
    expect(res.status).toBe(403);
    expect(recoverBagVersions.mock.calls[0].slice(1, 4)).toEqual([{ userId: 'u1', walletAddress: '0xabc' }, 'bag1', { txHash: '0xdead' }]);
    expect((await post({ txHash: 5 })).status).toBe(400);

    recoverBagVersions.mockResolvedValue({ ok: false, error: 'NO_PROPOSAL', version: 2, txHash: null, onChainCompositionHash: null });
    expect((await post({})).status).toBe(409);
    recoverBagVersions.mockResolvedValue({ ok: false, error: 'CHAIN_UNAVAILABLE', message: 'x' });
    expect((await post({})).status).toBe(503);
    recoverBagVersions.mockResolvedValue({ ok: false, error: 'PENDING', message: 'x' });
    expect((await post({})).status).toBe(202);
    recoverBagVersions.mockResolvedValue({ ok: true, recovered: [], recordedVersion: 2, chainVersion: 2, inSync: true, pendingProposals: 0 });
    expect(await (await post({})).json()).toEqual({ recovered: [], recordedVersion: 2, chainVersion: 2, inSync: true, pendingProposals: 0 });
  });
});
