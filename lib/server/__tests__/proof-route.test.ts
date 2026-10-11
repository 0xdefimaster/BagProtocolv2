import { beforeEach, describe, expect, it, vi } from 'vitest';

const loadProof = vi.fn();
let configured = true;
vi.mock('@/lib/supabase/server', () => ({ isSupabaseConfigured: () => configured, supabaseAdmin: () => ({}) }));
vi.mock('@/lib/server/protocol-proof', () => ({ loadProtocolProof: (...a: unknown[]) => loadProof(...a) }));

import { GET } from '@/app/api/proof/route';

beforeEach(() => {
  vi.clearAllMocks();
  configured = true;
});

describe('GET /api/proof', () => {
  it('public, cached for a minute at the edge', async () => {
    loadProof.mockResolvedValue({ windowDays: 30 });
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ windowDays: 30 });
    expect(res.headers.get('cache-control')).toBe('public, s-maxage=60, stale-while-revalidate=120');
  });

  it('503 without a database; a failure is reported without its internals', async () => {
    configured = false;
    expect((await GET()).status).toBe(503);
    configured = true;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    loadProof.mockRejectedValue(new Error('relation "secret_table" does not exist'));
    const res = await GET();
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('secret_table');
    expect(res.headers.get('cache-control')).toBeNull();
  });
});
