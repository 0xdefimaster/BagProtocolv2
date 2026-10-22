import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const mocks = vi.hoisted(() => ({ start: vi.fn(), bag: vi.fn(), version: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ isSupabaseConfigured: () => true, supabaseAdmin: () => ({}) }));
vi.mock('@/lib/server/bag-repo', () => ({ getBagById: mocks.bag, getCurrentBagVersion: mocks.version }));
vi.mock('@/lib/server/dca-trial', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/server/dca-trial')>(), startDcaTrial: mocks.start }));
import { POST, GET } from './route';
const params = { params: Promise.resolve({ id: 'local-reference' }) };
const settings = { budget: '25', amount: '10', interval: '1', unit: 'days' };
const request = (body: unknown = settings) => new NextRequest('http://localhost:3000/api/bags/local-reference/dca-trial', { method: 'POST', headers: { origin: 'http://localhost:3000', 'x-bag-local-trial': '1' }, body: JSON.stringify(body) });
beforeEach(() => { vi.stubEnv('NODE_ENV', 'development'); vi.stubEnv('NEXT_PUBLIC_DCA_TRIAL', 'true'); vi.stubEnv('BAG_DCA_TRIAL', 'true'); mocks.start.mockResolvedValue({ id: 'job', state: 'RUNNING' }); });
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
it('returns 404 in production without starting work', async () => {
  vi.stubEnv('NODE_ENV', 'production'); expect((await POST(request(), params)).status).toBe(404); expect(mocks.start).not.toHaveBeenCalled();
});
it('builds the reference from server data and does not require a fake persisted Bag', async () => {
  expect((await POST(request(), params)).status).toBe(202); expect(mocks.bag).not.toHaveBeenCalled();
  expect(mocks.start.mock.calls[0][4]).toMatchObject({ budgetRaw: '25000000', amountRaw: '10000000', remainderRaw: '5000000', purchases: 2, intervalSeconds: 86400 });
  expect(mocks.start.mock.calls[0][1].definition.chain).toBe('robinhood');
});
it('rejects excessive or malformed input before creating a worker', async () => {
  expect((await POST(request({ ...settings, budget: '1001' }), params)).status).toBe(400);
  expect((await POST(request({ ...settings, amount: '1', budget: '21' }), params)).status).toBe(400);
  expect((await POST(request({ x: 'a'.repeat(2200) }), params)).status).toBe(413);
  expect(mocks.start).not.toHaveBeenCalled();
});
it('does not reveal archived Bags and does not run another chain', async () => {
  mocks.bag.mockResolvedValueOnce({ status: 'ARCHIVED' }); const real = { params: Promise.resolve({ id: 'real' }) };
  expect((await POST(request(), real)).status).toBe(404);
  mocks.bag.mockResolvedValueOnce({ id: 'real', status: 'ACTIVE' }); mocks.version.mockResolvedValueOnce({ recipe: { chain: 'ethereum', assets: [] } });
  expect((await POST(request(), real)).status).toBe(422); expect(mocks.start).not.toHaveBeenCalled();
});
it('returns an explicit missing-run response after server restarts', async () => {
  const req = new NextRequest('http://localhost:3000/api/bags/local-reference/dca-trial?trial=00000000-0000-0000-0000-000000000000', { headers: { 'x-bag-local-trial': '1', origin: 'http://localhost:3000' } });
  expect((await GET(req, params)).status).toBe(404);
});
