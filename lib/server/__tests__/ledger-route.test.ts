import { beforeEach, describe, expect, it, vi } from 'vitest';

const requireSession = vi.fn();
const listLedger = vi.fn();
vi.mock('@/lib/supabase/server', () => ({ isSupabaseConfigured: () => true, supabaseAdmin: () => ({}) }));
vi.mock('@/lib/auth/require-session', () => ({ requireSession: () => requireSession() }));
vi.mock('@/lib/server/ledger-repo', () => ({ MAX_LEDGER_PAGE: 100, listLedgerEventsForUser: (...a: unknown[]) => listLedger(...a) }));

import { GET } from '@/app/api/users/me/ledger/route';

const BAG = '1fe43bff-5772-4baa-8159-b58e9bb8a446';
const get = (qs = '') => GET(new Request(`http://x/api/users/me/ledger${qs}`) as never);

beforeEach(() => {
  vi.clearAllMocks();
  requireSession.mockResolvedValue({ ok: true, session: { userId: 'u1', walletAddress: '0xw' } });
  listLedger.mockResolvedValue({ events: [], nextBefore: null });
});

describe('GET /api/users/me/ledger', () => {
  it('requires a session', async () => {
    requireSession.mockResolvedValue({ ok: false, response: new Response(null, { status: 401 }) });
    expect((await get()).status).toBe(401);
    expect(listLedger).not.toHaveBeenCalled();
  });

  it("reads only the session user's events, with filters passed through", async () => {
    const res = await get(`?strategyId=${BAG.toUpperCase()}&before=42&limit=10`);
    expect(res.status).toBe(200);
    expect(listLedger.mock.calls[0][1]).toBe('u1');
    expect(listLedger.mock.calls[0][2]).toEqual({ bagId: BAG, before: '42', limit: 10 });
  });

  it('rejects malformed parameters before touching the database', async () => {
    for (const qs of ['?strategyId=nope', '?before=0', '?before=abc', '?limit=0', '?limit=101', '?limit=2.5']) {
      expect((await get(qs)).status).toBe(400);
    }
    expect(listLedger).not.toHaveBeenCalled();
  });
});
