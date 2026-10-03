import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// -----------------------------------------------------------------------------
// UNIT tests for the three deployment routes. The orchestrator is mocked: this
// checks the HTTP layer only — authentication, that the ONLY client value that
// ever reaches the server logic is `txHash`, and the error → status mapping.
// -----------------------------------------------------------------------------

const requireSessionMock = vi.fn();
const prepareMock = vi.fn();
const confirmMock = vi.fn();
const stateMock = vi.fn();
const checkRateLimitMock = vi.fn();

vi.mock('@/lib/supabase/server', () => ({ isSupabaseConfigured: () => true, supabaseAdmin: () => ({ marker: 'admin' }) as never }));
vi.mock('@/lib/auth/require-session', () => ({ requireSession: (...a: unknown[]) => requireSessionMock(...a) }));
vi.mock('@/lib/server/rate-limit', () => ({
  checkRateLimit: (...a: unknown[]) => checkRateLimitMock(...a),
  rateLimitedResponseBody: (retryAfterSeconds: number) => ({ error: 'Too many requests.', retryAfterSeconds }),
}));
vi.mock('@/lib/server/deploy-bag', () => ({
  prepareBagDeployment: (...a: unknown[]) => prepareMock(...a),
  confirmBagDeployment: (...a: unknown[]) => confirmMock(...a),
  getBagDeploymentState: (...a: unknown[]) => stateMock(...a),
}));

import { POST as PREPARE } from '@/app/api/bags/[id]/deploy/prepare/route';
import { POST as CONFIRM } from '@/app/api/bags/[id]/deploy/confirm/route';
import { GET as STATE } from '@/app/api/bags/[id]/deploy/route';
import * as deployRoute from '@/app/api/bags/[id]/deploy/route';

const SESSION = { userId: 'user-1', walletAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' };
const params = { params: Promise.resolve({ id: 'bag-1' }) };
const TX = `0x${'ab'.repeat(32)}`;
const post = (body: unknown) =>
  new NextRequest('http://localhost/api/bags/bag-1/deploy/x', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  vi.clearAllMocks();
  requireSessionMock.mockResolvedValue({ ok: true, session: SESSION });
  checkRateLimitMock.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
});

const unauthenticated = () =>
  requireSessionMock.mockResolvedValue({ ok: false, response: new Response(JSON.stringify({ error: 'Not signed in.' }), { status: 401 }) });

describe('there is exactly one production deployment path', () => {
  it('the legacy single-step POST /deploy (server sends the tx) no longer exists — the path only serves GET state', () => {
    expect((deployRoute as Record<string, unknown>).POST).toBeUndefined();
    expect(typeof deployRoute.GET).toBe('function');
  });
});

describe('POST /deploy/prepare', () => {
  it('401 when not signed in — nothing is called', async () => {
    unauthenticated();
    expect((await PREPARE(post({}), params)).status).toBe(401);
    expect(prepareMock).not.toHaveBeenCalled();
  });

  // Production-hardening P1-10.
  it('is rate limited per user + bag — 429, prepareBagDeployment never called', async () => {
    checkRateLimitMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 22 });

    const res = await PREPARE(post({}), params);
    const body = await res.json();

    expect(res.status).toBe(429);
    expect(body.retryAfterSeconds).toBe(22);
    expect(prepareMock).not.toHaveBeenCalled();
    expect(checkRateLimitMock).toHaveBeenCalledWith(expect.anything(), 'deploy-prepare:user-1:bag-1', expect.objectContaining({ maxRequests: expect.any(Number) }));
  });

  it('the request body is IGNORED: a client-supplied wallet/chain/anything never reaches the server logic; identity comes from the session', async () => {
    prepareMock.mockResolvedValue({ ok: true, transaction: { to: '0xf', data: '0x', chainId: 4663 }, wallet: SESSION.walletAddress.toLowerCase(), chain: 'robinhood', factoryAddress: '0xf', offChainRef: '0x1', compositionHash: '0x2' });
    const res = await PREPARE(post({ walletAddress: '0xattacker', chain: 'ethereum', creatorId: 'evil', factoryAddress: '0xevil' }), params);
    expect(res.status).toBe(200);
    expect(prepareMock).toHaveBeenCalledTimes(1);
    const [, sessionArg, bagId, ...rest] = prepareMock.mock.calls[0];
    expect(sessionArg).toEqual({ userId: SESSION.userId, walletAddress: SESSION.walletAddress });
    expect(bagId).toBe('bag-1');
    expect(rest).toEqual([]); // nothing else — no chain, no wallet, no deps
    expect(JSON.stringify(prepareMock.mock.calls[0])).not.toMatch(/attacker|evil|ethereum/);
  });

  it.each([
    ['NO_WALLET_ON_SESSION', 401],
    ['BAG_NOT_FOUND', 404],
    ['FORBIDDEN', 403],
    ['BAG_ARCHIVED', 409],
    ['NO_VERSION', 409],
    ['ALREADY_DEPLOYED', 409],
    ['ALREADY_CREATED_ON_CHAIN', 409],
    ['CHAIN_UNAVAILABLE', 503],
  ])('%s → %i', async (error, status) => {
    prepareMock.mockResolvedValue({ ok: false, error, message: 'm', deployment: {} });
    const res = await PREPARE(post({}), params);
    expect(res.status).toBe(status);
    expect((await res.json()).code).toBe(error);
  });
});

describe('POST /deploy/confirm', () => {
  it('401 when not signed in — nothing is called', async () => {
    unauthenticated();
    expect((await CONFIRM(post({ txHash: TX }), params)).status).toBe(401);
    expect(confirmMock).not.toHaveBeenCalled();
  });

  // Production-hardening P1-10.
  it('is rate limited per user + bag — 429, confirmBagDeployment never called', async () => {
    checkRateLimitMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 9 });

    const res = await CONFIRM(post({ txHash: TX }), params);

    expect(res.status).toBe(429);
    expect(confirmMock).not.toHaveBeenCalled();
    expect(checkRateLimitMock).toHaveBeenCalledWith(expect.anything(), 'deploy-confirm:user-1:bag-1', expect.objectContaining({ maxRequests: expect.any(Number) }));
  });

  it('passes ONLY txHash from the body; wallet, user and chain-related fields in the body are ignored', async () => {
    confirmMock.mockResolvedValue({ ok: true, deployment: { id: 'd' }, bag: { status: 'ACTIVE' }, alreadyConfirmed: false });
    const res = await CONFIRM(post({ txHash: TX, walletAddress: '0xattacker', chain: 'ethereum', onChainBagId: '0xevil', status: 'ACTIVE', contractAddress: '0xevil', blockNumber: 1 }), params);
    expect(res.status).toBe(200);
    expect(confirmMock).toHaveBeenCalledWith({ marker: 'admin' }, { userId: SESSION.userId, walletAddress: SESSION.walletAddress }, 'bag-1', TX);
    expect(JSON.stringify(confirmMock.mock.calls[0])).not.toMatch(/attacker|evil|ethereum/);
  });

  it('a missing / non-string txHash is passed as an empty string and rejected by the orchestrator as INVALID_TX_HASH (400)', async () => {
    confirmMock.mockResolvedValue({ ok: false, error: 'INVALID_TX_HASH' });
    for (const body of [{}, { txHash: 42 }, { txHash: null }, 'garbage']) {
      const res = await CONFIRM(post(body), params);
      expect(res.status).toBe(400);
    }
    expect(confirmMock.mock.calls.every((c) => c[3] === '')).toBe(true);
  });

  it('PENDING → 202 (a retry-safe, non-error answer)', async () => {
    confirmMock.mockResolvedValue({ ok: false, error: 'PENDING', message: 'not mined' });
    const res = await CONFIRM(post({ txHash: TX }), params);
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ status: 'PENDING', code: 'PENDING' });
  });

  it.each([
    ['NO_WALLET_ON_SESSION', 401],
    ['INVALID_TX_HASH', 400],
    ['BAG_NOT_FOUND', 404],
    ['FORBIDDEN', 403],
    ['NO_VERSION', 409],
    ['VERIFICATION_FAILED', 422],
    ['CONFLICTING_DEPLOYMENT', 409],
    ['STALE_VERSION', 409],
    ['IDENTITY_TAKEN', 409],
    ['CHAIN_UNAVAILABLE', 503],
    ['CHAIN_ERROR', 502],
  ])('%s → %i', async (error, status) => {
    confirmMock.mockResolvedValue({ ok: false, error, message: 'm', deployment: { txHash: TX } });
    const res = await CONFIRM(post({ txHash: TX }), params);
    expect(res.status).toBe(status);
    expect((await res.json()).code).toBe(error);
  });

  it('success returns the deployment + Bag finalization and whether it was an idempotent replay', async () => {
    confirmMock.mockResolvedValue({ ok: true, deployment: { id: 'd', status: 'DEPLOYED' }, bag: { status: 'ACTIVE' }, alreadyConfirmed: true });
    const body = await (await CONFIRM(post({ txHash: TX }), params)).json();
    expect(body).toEqual({ deployment: { id: 'd', status: 'DEPLOYED' }, bag: { status: 'ACTIVE' }, alreadyConfirmed: true });
  });
});

describe('GET /deploy (state)', () => {
  it('401 unauthenticated; 200 for the owner; 403/404 otherwise', async () => {
    unauthenticated();
    expect((await STATE(new Request('http://x'), params)).status).toBe(401);
    requireSessionMock.mockResolvedValue({ ok: true, session: SESSION });
    stateMock.mockResolvedValue({ ok: true, bagStatus: 'ACTIVE', chain: 'robinhood', deployment: null });
    expect((await STATE(new Request('http://x'), params)).status).toBe(200);
    stateMock.mockResolvedValue({ ok: false, error: 'FORBIDDEN' });
    expect((await STATE(new Request('http://x'), params)).status).toBe(403);
    stateMock.mockResolvedValue({ ok: false, error: 'BAG_NOT_FOUND' });
    expect((await STATE(new Request('http://x'), params)).status).toBe(404);
  });
});
