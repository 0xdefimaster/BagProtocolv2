import { afterEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { localDcaRequestAllowed } from '../dca-trial';
afterEach(() => vi.unstubAllEnvs());
const request = (url = 'http://localhost:3000/api/bags/local-reference/dca-trial', headers: Record<string, string> = { origin: 'http://localhost:3000', 'x-bag-local-trial': '1' }, method = 'POST') => new NextRequest(url, { method, headers });
function enabled() { vi.stubEnv('NODE_ENV', 'development'); vi.stubEnv('NEXT_PUBLIC_DCA_TRIAL', 'true'); vi.stubEnv('BAG_DCA_TRIAL', 'true'); }
it('requires both flags and development mode', () => {
  enabled(); expect(localDcaRequestAllowed(request())).toBe(true);
  vi.stubEnv('BAG_DCA_TRIAL', 'false'); expect(localDcaRequestAllowed(request())).toBe(false);
  enabled(); vi.stubEnv('NODE_ENV', 'production'); expect(localDcaRequestAllowed(request())).toBe(false);
});
it('rejects cross-origin and non-local calls', () => {
  enabled(); expect(localDcaRequestAllowed(request(undefined, { origin: 'https://attacker.test', 'x-bag-local-trial': '1' }))).toBe(false);
  expect(localDcaRequestAllowed(request('https://bag.example/api', { origin: 'https://bag.example', 'x-bag-local-trial': '1' }))).toBe(false);
  expect(localDcaRequestAllowed(request(undefined, { origin: 'http://localhost:3000' } as never))).toBe(false);
});
it('accepts same-origin browser GET polling without an Origin header', () => {
  enabled(); const headers = { 'x-bag-local-trial': '1', 'sec-fetch-site': 'same-origin', referer: 'http://localhost:3000/dashboard/dca' };
  expect(localDcaRequestAllowed(request(undefined, headers as never, 'GET'))).toBe(true);
  expect(localDcaRequestAllowed(request(undefined, { ...headers, referer: 'https://attacker.test/' } as never, 'GET'))).toBe(false);
});
it('handles Next localhost URL normalization without accepting external hosts', () => {
  enabled(); const headers = { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000', 'x-bag-local-trial': '1' };
  expect(localDcaRequestAllowed(request(undefined, headers))).toBe(true);
  expect(localDcaRequestAllowed(request(undefined, { ...headers, host: 'attacker.test', origin: 'http://attacker.test' }))).toBe(false);
});
