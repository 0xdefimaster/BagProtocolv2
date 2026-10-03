import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// -----------------------------------------------------------------------------
// Phase 1 / item 16.F — endpoint-level tests for
// `POST /api/bags/:id/purchase-options`: authenticated access, rate
// limiting, and (the one item this route's OWN code is responsible for,
// as opposed to `getPurchaseOptionsForUser()`'s own service-level tests in
// purchase-execution.test.ts) that this route NEVER creates a
// `PurchaseIntent` row — item 10's "Do NOT persist 2-3 candidate intents"
// checked at the actual HTTP boundary, not just by reading the service
// function's source. Same mocking convention as
// purchase-intent-step-report-route.test.ts: no real I/O, session +
// service function + rate limiter are all mocked.
// -----------------------------------------------------------------------------

const getPurchaseOptionsForUserMock = vi.fn();
const createPurchaseIntentMock = vi.fn(); // the underlying repo insert — asserted NEVER called
const checkRateLimitMock = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  isSupabaseConfigured: () => true,
  supabaseAdmin: () => ({}) as never,
}));
vi.mock('@/lib/auth/require-session', () => ({
  requireSession: async () => ({ ok: true, session: { userId: 'user_1', walletAddress: '0xREALWALLET1' } }),
}));
vi.mock('@/lib/server/rate-limit', () => ({
  checkRateLimit: (...args: unknown[]) => checkRateLimitMock(...args),
  rateLimitedResponseBody: (retryAfterSeconds: number) => ({ error: 'Too many requests. Please try again shortly.', retryAfterSeconds }),
}));
vi.mock('@/lib/server/purchase-intent-repo', () => ({
  createPurchaseIntent: (...args: unknown[]) => createPurchaseIntentMock(...args),
}));
vi.mock('@/lib/server/purchase-execution', async (importOriginal: () => Promise<typeof import('../purchase-execution')>) => {
  const actual = await importOriginal();
  return { ...actual, getPurchaseOptionsForUser: (...args: unknown[]) => getPurchaseOptionsForUserMock(...args) };
});

const { POST } = await import('../../../app/api/bags/[id]/purchase-options/route');

function request(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/bags/bag_1/purchase-options', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

const okOptions = {
  ok: true,
  value: {
    candidates: [{ id: 'lifi-composer', providerId: 'lifi-composer', compile: { status: 'COMPILED' } }],
    failed: [],
    winners: [{ category: 'bestQuotedOutput', candidateId: 'lifi-composer', providerId: 'lifi-composer' }],
    executionPlanHash: 'hash_1',
    compiledAt: Date.now(),
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  checkRateLimitMock.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
  getPurchaseOptionsForUserMock.mockResolvedValue(okOptions);
});

describe('POST /api/bags/:id/purchase-options', () => {
  it('rejects malformed JSON with 400, before calling the service', async () => {
    const bad = new NextRequest('http://localhost/api/bags/bag_1/purchase-options', {
      method: 'POST',
      body: '{not json',
      headers: { 'content-type': 'application/json' },
    });
    const response = await POST(bad, { params: Promise.resolve({ id: 'bag_1' }) });
    expect(response.status).toBe(400);
    expect(getPurchaseOptionsForUserMock).not.toHaveBeenCalled();
  });

  it('rejects a body missing inputAssetId/amount with 400', async () => {
    const response = await POST(request({ amount: '100' }), { params: Promise.resolve({ id: 'bag_1' }) });
    expect(response.status).toBe(400);
    expect(getPurchaseOptionsForUserMock).not.toHaveBeenCalled();
  });

  it('is rate limited per authenticated user — 429 with retryAfterSeconds, service never called', async () => {
    checkRateLimitMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 37 });

    const response = await POST(request({ inputAssetId: 'asset_usdc', amount: '100' }), {
      params: Promise.resolve({ id: 'bag_1' }),
    });

    expect(response.status).toBe(429);
    const body = await response.json();
    expect(body.retryAfterSeconds).toBe(37);
    expect(getPurchaseOptionsForUserMock).not.toHaveBeenCalled();
    expect(checkRateLimitMock).toHaveBeenCalledWith(expect.anything(), 'purchase-options:user_1', expect.objectContaining({ maxRequests: expect.any(Number) }));
  });

  it('authenticated + within limits: calls the service with the SESSION wallet/user, the URL bagId, and the body fields — never a client-supplied wallet/user', async () => {
    const response = await POST(request({ inputAssetId: 'asset_usdc', amount: '250' }), {
      params: Promise.resolve({ id: 'bag_42' }),
    });

    expect(response.status).toBe(200);
    expect(getPurchaseOptionsForUserMock).toHaveBeenCalledTimes(1);
    const call = getPurchaseOptionsForUserMock.mock.calls[0][0];
    expect(call.bagId).toBe('bag_42');
    expect(call.inputAssetId).toBe('asset_usdc');
    expect(call.amount).toBe('250');
    expect(call.session).toEqual({ userId: 'user_1', walletAddress: '0xREALWALLET1' });
  });

  it('returns the service\'s candidate set verbatim under { options } and NEVER creates a PurchaseIntent row (item 10)', async () => {
    const response = await POST(request({ inputAssetId: 'asset_usdc', amount: '100' }), {
      params: Promise.resolve({ id: 'bag_1' }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.options).toEqual(okOptions.value);
    expect(createPurchaseIntentMock).not.toHaveBeenCalled();
  });

  it('maps a PROVIDER_SELECTION_UNAVAILABLE outcome (compiler flag off) to the same HTTP shape purchase-intent-http.ts defines, not a raw 500', async () => {
    getPurchaseOptionsForUserMock.mockResolvedValue({ ok: false, error: { kind: 'PROVIDER_SELECTION_UNAVAILABLE' } });

    const response = await POST(request({ inputAssetId: 'asset_usdc', amount: '100' }), {
      params: Promise.resolve({ id: 'bag_1' }),
    });

    expect(response.status).toBe(409);
  });

  it('propagates BAG_NOT_FOUND / other prepareBagPurchaseContext errors through the same error mapper the purchase-intent route uses', async () => {
    getPurchaseOptionsForUserMock.mockResolvedValue({ ok: false, error: { kind: 'BAG_NOT_FOUND' } });

    const response = await POST(request({ inputAssetId: 'asset_usdc', amount: '100' }), {
      params: Promise.resolve({ id: 'bag_1' }),
    });

    expect(response.status).toBe(404);
  });
});
