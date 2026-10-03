import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// -----------------------------------------------------------------------------
// Phase 18 — spec 18.3's "malicious/fake client-reported success" test
// case. `recordStepEvent()` (lib/server/purchase-execution.ts) already
// can't accept a `COMPLETED` event at the type level, but that's a
// compile-time guarantee only — this proves the actual HTTP boundary
// (`parseEvent()` in the route below) independently rejects a raw JSON
// body that tries to claim one, so a client bypassing the TS types
// entirely (curl, a modified frontend build, a compromised extension)
// still can't get anywhere near marking a step done. No real I/O: session
// + recordStepEvent are mocked, same convention as
// purchase-preview-route.test.ts.
// -----------------------------------------------------------------------------

const recordStepEventMock = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  isSupabaseConfigured: () => true,
  supabaseAdmin: () => ({}) as never,
}));
vi.mock('@/lib/auth/require-session', () => ({
  requireSession: async () => ({ ok: true, session: { userId: 'user_1', walletAddress: '0xabc' } }),
}));
vi.mock('@/lib/server/purchase-execution', async (importOriginal: () => Promise<typeof import('../purchase-execution')>) => {
  const actual = await importOriginal();
  return { ...actual, recordStepEvent: (...args: unknown[]) => recordStepEventMock(...args) };
});

const { POST } = await import('../../../app/api/purchase-intent/[intentId]/step/[stepIndex]/report/route');

function request(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/purchase-intent/intent_1/step/0/report', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

describe('POST /api/purchase-intent/:intentId/step/:stepIndex/report', () => {
  it('rejects a fabricated COMPLETED event at the HTTP boundary — 400, recordStepEvent never called', async () => {
    const res = await POST(request({ type: 'COMPLETED' }), {
      params: Promise.resolve({ intentId: 'intent_1', stepIndex: '0' }),
    });

    expect(res.status).toBe(400);
    expect(recordStepEventMock).not.toHaveBeenCalled();
  });

  it('rejects an unrecognized event type entirely — no silent pass-through', async () => {
    const res = await POST(request({ type: 'DEFINITELY_NOT_A_REAL_EVENT' }), {
      params: Promise.resolve({ intentId: 'intent_1', stepIndex: '0' }),
    });

    expect(res.status).toBe(400);
    expect(recordStepEventMock).not.toHaveBeenCalled();
  });

  it('accepts a genuinely valid event type and forwards it', async () => {
    recordStepEventMock.mockResolvedValue({ ok: true, value: { id: 'intent_1' } });

    const res = await POST(request({ type: 'REJECTED' }), {
      params: Promise.resolve({ intentId: 'intent_1', stepIndex: '0' }),
    });

    expect(res.status).toBe(200);
    expect(recordStepEventMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'intent_1',
      0,
      expect.objectContaining({ type: 'REJECTED' })
    );
  });
});
