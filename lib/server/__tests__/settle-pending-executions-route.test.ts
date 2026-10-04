import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const reconcile = vi.fn();
vi.mock('@/lib/supabase/server', () => ({ isSupabaseConfigured: () => true, supabaseAdmin: () => ({}) }));
vi.mock('@/lib/server/execution-reconciler', () => ({ reconcilePendingExecutions: (...a: unknown[]) => reconcile(...a) }));

import { POST } from '@/app/api/cron/settle-pending-executions/route';

const req = (auth?: string) => new NextRequest('http://x/api/cron/settle-pending-executions', { method: 'POST', headers: auth ? { authorization: auth } : {} });

beforeEach(() => {
  reconcile.mockReset().mockResolvedValue({ purchases: { checked: 0, settled: 0, failed: 0 }, redeems: { checked: 0, settled: 0, failed: 0 } });
  process.env.CRON_SECRET = 'test-secret-value-long-enough';
});
afterEach(() => {
  delete process.env.CRON_SECRET;
});

describe('POST /api/cron/settle-pending-executions', () => {
  it('rejects calls without the cron secret and never runs the reconciler', async () => {
    expect((await POST(req())).status).toBe(401);
    expect((await POST(req('Bearer wrong'))).status).toBe(401);
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('fails closed when CRON_SECRET is unset', async () => {
    delete process.env.CRON_SECRET;
    expect((await POST(req('Bearer anything'))).status).toBe(503);
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('runs with the secret and returns the summary', async () => {
    const res = await POST(req('Bearer test-secret-value-long-enough'));
    expect(res.status).toBe(200);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });
});
