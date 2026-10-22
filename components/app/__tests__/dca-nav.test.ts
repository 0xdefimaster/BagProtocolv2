import { afterEach, expect, it, vi } from 'vitest';
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });
it('adds a separate DCA tab only for an enabled development experiment', async () => {
  vi.stubEnv('NODE_ENV', 'development'); vi.stubEnv('NEXT_PUBLIC_DCA_TRIAL', 'true'); vi.resetModules();
  const { APP_NAV, isActiveLink } = await import('../app-nav');
  const link = APP_NAV.find(l => l.label === 'DCA'); expect(link?.href).toBe('/dashboard/dca'); expect(isActiveLink(link!, '/dashboard/dca')).toBe(true);
});
it.each(['production', 'test'])('keeps the DCA tab hidden in %s even if the flag is set', async mode => {
  vi.stubEnv('NODE_ENV', mode); vi.stubEnv('NEXT_PUBLIC_DCA_TRIAL', 'true'); vi.resetModules();
  expect((await import('../app-nav')).APP_NAV.some(l => l.label === 'DCA')).toBe(false);
});
