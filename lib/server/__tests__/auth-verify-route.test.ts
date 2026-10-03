import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// -----------------------------------------------------------------------------
// Production-hardening P1-9 — route-level tests proving `POST /api/auth/verify`
// now calls the atomic `get_or_create_wallet_user` RPC instead of the old
// select-then-insert-user-then-insert-portfolio sequence, and surfaces its
// result correctly. Genuine concurrent-race proof against a real Postgres
// lives in lib/server/__tests__/integration/get-or-create-wallet-user.integration.test.ts —
// a mocked RPC here cannot demonstrate real row-level locking.
// -----------------------------------------------------------------------------

const consumeNonceMock = vi.fn();
const verifyMessageMock = vi.fn();
const rpcMock = vi.fn();
const createSessionTokenMock = vi.fn();
const setSessionCookieMock = vi.fn();

vi.mock('@/lib/auth/nonce', () => ({
  consumeNonce: (...args: unknown[]) => consumeNonceMock(...args),
}));

vi.mock('viem', () => ({
  verifyMessage: (...args: unknown[]) => verifyMessageMock(...args),
}));

vi.mock('@/lib/auth/session', () => ({
  createSessionToken: (...args: unknown[]) => createSessionTokenMock(...args),
  setSessionCookie: (...args: unknown[]) => setSessionCookieMock(...args),
}));

vi.mock('@/lib/server/rate-limit', () => ({
  checkRateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
  getClientIp: () => '127.0.0.1',
  rateLimitedResponseBody: (retryAfterSeconds: number) => ({ error: 'Too many requests.', retryAfterSeconds }),
}));

vi.mock('@/lib/supabase/server', () => ({
  isSupabaseConfigured: () => true,
  supabaseAdmin: () => ({ rpc: rpcMock }),
}));

const { POST } = await import('@/app/api/auth/verify/route');

function postRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/auth/verify', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

const WALLET = '0xAbCdEf000000000000000000000000000000AbCd';
const SIGNATURE = '0xdeadbeef';
const NONCE = 'nonce-1';

beforeEach(() => {
  vi.clearAllMocks();
  consumeNonceMock.mockResolvedValue('sign this message');
  verifyMessageMock.mockResolvedValue(true);
  createSessionTokenMock.mockResolvedValue('token');
  rpcMock.mockResolvedValue({
    data: [{ id: 'user_1', wallet_address: WALLET.toLowerCase(), display_name: null, was_created: true }],
    error: null,
  });
});

describe('POST /api/auth/verify', () => {
  it('calls the atomic get_or_create_wallet_user RPC with the normalized (lowercased) wallet address, never the two-step select/insert path', async () => {
    const res = await POST(postRequest({ walletAddress: WALLET, signature: SIGNATURE, nonce: NONCE }));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(rpcMock).toHaveBeenCalledWith('get_or_create_wallet_user', expect.objectContaining({
      p_wallet_address: WALLET.toLowerCase(),
    }));
    expect(data.user).toEqual({ id: 'user_1', walletAddress: WALLET.toLowerCase(), displayName: null });
    expect(createSessionTokenMock).toHaveBeenCalledWith({ userId: 'user_1', walletAddress: WALLET.toLowerCase() });
  });

  it('a losing-the-race caller (was_created: false) still gets the same user back and a session — never a raw unique-violation 500', async () => {
    rpcMock.mockResolvedValue({
      data: [{ id: 'user_1', wallet_address: WALLET.toLowerCase(), display_name: 'Existing', was_created: false }],
      error: null,
    });

    const res = await POST(postRequest({ walletAddress: WALLET, signature: SIGNATURE, nonce: NONCE }));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.user).toEqual({ id: 'user_1', walletAddress: WALLET.toLowerCase(), displayName: 'Existing' });
  });

  it('a raw RPC error is surfaced as a clean 500, never an unhandled exception', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: 'connection lost' } });

    const res = await POST(postRequest({ walletAddress: WALLET, signature: SIGNATURE, nonce: NONCE }));

    expect(res.status).toBe(500);
  });

  it('a nonce storage error comes back as a readable 500, not "expired"', async () => {
    consumeNonceMock.mockRejectedValue(new Error('Sign-in storage error: function consume_auth_nonce does not exist'));

    const res = await POST(postRequest({ walletAddress: WALLET, signature: SIGNATURE, nonce: NONCE }));

    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/consume_auth_nonce does not exist/);
  });

  it('a session-creation failure (e.g. short SESSION_SECRET) comes back as a readable JSON 500', async () => {
    createSessionTokenMock.mockRejectedValue(new Error('SESSION_SECRET is not set (or shorter than 32 characters).'));

    const res = await POST(postRequest({ walletAddress: WALLET, signature: SIGNATURE, nonce: NONCE }));

    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/SESSION_SECRET/);
  });

  it('never calls the RPC at all when the nonce is invalid/expired', async () => {
    consumeNonceMock.mockResolvedValue(null);

    const res = await POST(postRequest({ walletAddress: WALLET, signature: SIGNATURE, nonce: NONCE }));

    expect(res.status).toBe(401);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('never calls the RPC at all when the signature does not verify', async () => {
    verifyMessageMock.mockResolvedValue(false);

    const res = await POST(postRequest({ walletAddress: WALLET, signature: SIGNATURE, nonce: NONCE }));

    expect(res.status).toBe(401);
    expect(rpcMock).not.toHaveBeenCalled();
  });
});
