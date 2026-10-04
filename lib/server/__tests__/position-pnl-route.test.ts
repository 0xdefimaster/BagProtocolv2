import { beforeEach, describe, expect, it, vi } from 'vitest';

const requireSession = vi.fn();
const listAll = vi.fn();
vi.mock('@/lib/supabase/server', () => ({ isSupabaseConfigured: () => true, supabaseAdmin: () => ({}) }));
vi.mock('@/lib/auth/require-session', () => ({ requireSession: () => requireSession() }));
vi.mock('@/lib/server/ledger-repo', () => ({ listAllLedgerEventsForPosition: (...a: unknown[]) => listAll(...a) }));

import { GET } from '@/app/api/users/me/positions/[strategyId]/pnl/route';

const BAG = '1fe43bff-5772-4baa-8159-b58e9bb8a446';
const get = (id: string) => GET(new Request('http://x') as never, { params: Promise.resolve({ strategyId: id }) });
const A = { chain: 'robinhood', address: '0xaaa' };

beforeEach(() => {
  vi.clearAllMocks();
  requireSession.mockResolvedValue({ ok: true, session: { userId: 'u1', walletAddress: '0xw' } });
});

describe('GET /api/users/me/positions/:id/pnl', () => {
  it('requires a session and a valid id', async () => {
    requireSession.mockResolvedValueOnce({ ok: false, response: new Response(null, { status: 401 }) });
    expect((await get(BAG)).status).toBe(401);
    expect((await get('nope')).status).toBe(404);
    expect(listAll).not.toHaveBeenCalled();
  });

  it("computes from the session user's own events only", async () => {
    listAll.mockResolvedValue([
      { seq: '1', kind: 'PURCHASE_FILL', legs: [{ ...A, deltaRaw: '10', costQuote: '100' }], quote: {} },
      { seq: '2', kind: 'REDEEM_FILL', legs: [{ ...A, deltaRaw: '-5', proceedsQuote: '70' }], quote: {} },
    ]);
    const res = await get(BAG.toUpperCase());
    expect(res.status).toBe(200);
    expect(listAll.mock.calls[0].slice(1)).toEqual(['u1', BAG]);
    const body = await res.json();
    expect(body).toMatchObject({ strategyId: BAG, costBasisQuote: '50', realizedPnlQuote: '20', method: { costBasis: 'AVERAGE_COST_PER_ASSET' } });
  });

  it('no events → 404', async () => {
    listAll.mockResolvedValue([]);
    expect((await get(BAG)).status).toBe(404);
  });
});
