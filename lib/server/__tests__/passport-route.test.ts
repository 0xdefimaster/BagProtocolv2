import { beforeEach, describe, expect, it, vi } from 'vitest';

const getBagById = vi.fn();
const getSession = vi.fn();
const loadStrategyPassport = vi.fn();
vi.mock('@/lib/supabase/server', () => ({ isSupabaseConfigured: () => true, supabaseAdmin: () => ({}) }));
vi.mock('@/lib/server/bag-repo', () => ({ getBagById: (...a: unknown[]) => getBagById(...a) }));
vi.mock('@/lib/auth/session', () => ({ getSession: () => getSession() }));
vi.mock('@/lib/server/strategy-passport', () => ({ loadStrategyPassport: (...a: unknown[]) => loadStrategyPassport(...a) }));

import { GET } from '@/app/api/bags/[id]/passport/route';

const call = (id: string) => GET({} as never, { params: Promise.resolve({ id }) });

beforeEach(() => {
  getBagById.mockReset();
  getSession.mockReset();
  loadStrategyPassport.mockReset();
  loadStrategyPassport.mockResolvedValue({ schemaVersion: 1 });
});

describe('GET /api/bags/:id/passport', () => {
  it('serves an ACTIVE Bag to anyone, passing the viewer so their own private forks can be shown', async () => {
    getBagById.mockResolvedValue({ id: 'b', status: 'ACTIVE', creatorId: 'alice' });
    getSession.mockResolvedValue({ userId: 'carol' });
    const res = await call('b');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ passport: { schemaVersion: 1 } });
    expect(loadStrategyPassport.mock.calls[0][2]).toBe('carol');
  });

  it('hides a DRAFT Bag from everyone but its creator, without confirming it exists', async () => {
    getBagById.mockResolvedValue({ id: 'b', status: 'DRAFT', creatorId: 'alice' });
    getSession.mockResolvedValue(null);
    expect((await call('b')).status).toBe(404);
    getSession.mockResolvedValue({ userId: 'bob' });
    expect((await call('b')).status).toBe(404);
    getSession.mockResolvedValue({ userId: 'alice' });
    expect((await call('b')).status).toBe(200);
  });

  it('404s an unknown Bag', async () => {
    getBagById.mockResolvedValue(null);
    expect((await call('missing')).status).toBe(404);
  });
});
