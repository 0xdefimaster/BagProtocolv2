import { beforeEach, describe, expect, it, vi } from 'vitest';

const requireSession = vi.fn();
const settle = vi.fn();
const loadUserActivity = vi.fn();
vi.mock('@/lib/supabase/server', () => ({ isSupabaseConfigured: () => true, supabaseAdmin: () => ({}) }));
vi.mock('@/lib/auth/require-session', () => ({ requireSession: () => requireSession() }));
vi.mock('@/lib/server/purchase-execution', () => ({ settleUnsettledPurchasesForUser: (...a: unknown[]) => settle(...a) }));
vi.mock('@/lib/server/user-activity', () => ({ loadUserActivity: (...a: unknown[]) => loadUserActivity(...a) }));

import { GET } from '@/app/api/activity/route';

beforeEach(() => {
  [requireSession, settle, loadUserActivity].forEach((m) => m.mockReset());
  requireSession.mockResolvedValue({ ok: true, session: { userId: 'u1', walletAddress: '0xw' } });
  settle.mockResolvedValue({ checked: 0, settled: 0 });
  loadUserActivity.mockResolvedValue([{ id: 'a1', action: 'Bought $4.00 of X', timestamp: 1, kind: 'PURCHASE', bagId: null }]);
});

describe('GET /api/activity', () => {
  it('requires a session', async () => {
    requireSession.mockResolvedValue({ ok: false, response: new Response(null, { status: 401 }) });
    expect((await GET()).status).toBe(401);
    expect(loadUserActivity).not.toHaveBeenCalled();
  });

  it("settles the user's unverified purchases first, then returns only their activity", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect((await res.json()).activity).toHaveLength(1);
    expect(settle.mock.calls[0][1]).toEqual({ userId: 'u1', walletAddress: '0xw' });
    expect(loadUserActivity.mock.calls[0][1]).toBe('u1');
    expect(settle.mock.invocationCallOrder[0]).toBeLessThan(loadUserActivity.mock.invocationCallOrder[0]);
  });
});
