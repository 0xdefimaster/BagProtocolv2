import { beforeAll, describe, expect, it, vi } from 'vitest';
import { SignJWT } from 'jose';

vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined, set: () => {} }) }));

const SECRET = 'x'.repeat(48);
beforeAll(() => {
  vi.stubEnv('SESSION_SECRET', SECRET);
});

const { createSessionToken, verifySessionToken } = await import('../session');
const payload = { userId: 'user-1', walletAddress: '0xabc' };

describe('session tokens', () => {
  it('round-trips a token it issued', async () => {
    const token = await createSessionToken(payload);
    expect(await verifySessionToken(token)).toEqual(payload);
  });

  it('rejects a token signed with the same secret but without the session issuer/audience', async () => {
    const foreign = await new SignJWT(payload)
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(SECRET));
    expect(await verifySessionToken(foreign)).toBeNull();
  });

  it('expires within 7 days', async () => {
    const token = await createSessionToken(payload);
    const exp = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).exp as number;
    expect(exp - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(7 * 24 * 3600);
  });
});
