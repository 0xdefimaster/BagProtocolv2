import { beforeEach, describe, expect, it, vi } from 'vitest';

// POST /api/users/me/reconcile: 5-minute interval on connect, 30 seconds after a trade from this app.

const reconcile = vi.fn();
vi.mock('@/lib/auth/require-session', () => ({ requireSession: async () => ({ ok: true, session: { userId: 'u1', walletAddress: '0xabc' } }) }));
vi.mock('@/lib/supabase/server', () => ({ isSupabaseConfigured: () => true, supabaseAdmin: () => ({}) }));
vi.mock('@/lib/blockchain/robinhood-public-client', () => ({ getRobinhoodPublicClient: () => ({}) }));
vi.mock('@/lib/server/wallet-reconciliation', () => ({
  RECONCILE_ON_CONNECT_MIN_INTERVAL_MS: 300_000,
  RECONCILE_AFTER_TRADE_MIN_INTERVAL_MS: 30_000,
  reconcileWalletOnConnect: (...a: unknown[]) => reconcile(...a),
}));

const { POST } = await import('@/app/api/users/me/reconcile/route');
const req = (body?: unknown) => new Request('http://x/api/users/me/reconcile', { method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

beforeEach(() => {
  reconcile.mockReset().mockResolvedValue({ status: 'recent' });
});

describe('POST /api/users/me/reconcile', () => {
  it('no body (wallet connect) → the 5-minute interval; the wallet is the session’s', async () => {
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(reconcile.mock.calls[0][2]).toEqual({ userId: 'u1', walletAddress: '0xabc' });
    expect(reconcile.mock.calls[0][4]).toBe(300_000);
  });

  it('reason "trade" → 30 seconds; any other reason keeps 5 minutes', async () => {
    await POST(req({ reason: 'trade' }));
    await POST(req({ reason: 'anything', walletAddress: '0xevil' }));
    expect(reconcile.mock.calls.map((c) => c[4])).toEqual([30_000, 300_000]);
    expect(reconcile.mock.calls[1][2]).toEqual({ userId: 'u1', walletAddress: '0xabc' });
  });

  it('a failed check is a 503, not a crash', async () => {
    reconcile.mockRejectedValue(new Error('rpc'));
    expect((await POST(req())).status).toBe(503);
  });
});
