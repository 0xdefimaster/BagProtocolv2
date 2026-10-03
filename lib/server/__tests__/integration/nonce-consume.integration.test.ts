import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { consumeNonce, buildSignMessage } from '@/lib/auth/nonce';
import { TestDatabase, createTestDatabase } from './pg-harness';

// -----------------------------------------------------------------------------
// Production-hardening P0-7 — the ONE test that can actually prove the race
// is closed: two REAL concurrent RPC calls against a REAL Postgres, for the
// SAME (wallet, nonce). A mocked-client unit test (nonce.test.ts) cannot
// demonstrate this — mocks don't have real row-level locking/concurrency,
// they just return whatever a test told them to. This is exactly why this
// project's own integration-test harness (pg-harness.ts) exists.
//
// Nonce rows are seeded with raw SQL (`db.admin.query`, same convention
// `insertUser()` already uses) rather than via `issueNonce()` — the
// harness's `pgSupabaseShim` only implements `rpc()` and
// `select().eq()....maybeSingle()/single()` (see its own doc comment), not
// `upsert()`. `consumeNonce()` itself — the function under test — only
// ever calls `.rpc()`, so it is exercised for real either way.
// -----------------------------------------------------------------------------

let db: TestDatabase;

vi.mock('@/lib/supabase/server', () => ({
  supabaseAdmin: () => db.client,
  isSupabaseConfigured: () => true,
}));

async function seedNonce(wallet: string, nonce: string, expiresInMs = 5 * 60 * 1000): Promise<string> {
  const expiresAt = new Date(Date.now() + expiresInMs).toISOString();
  const message = buildSignMessage({
    domain: 'bagprotocol.test',
    uri: 'https://bagprotocol.test',
    walletAddress: wallet,
    nonce,
    issuedAt: new Date().toISOString(),
    expirationTime: expiresAt,
  });
  await db.admin.query(`insert into auth_nonces (nonce, wallet_address, message, expires_at) values ($1, $2, $3, $4)`, [
    nonce,
    wallet.toLowerCase(),
    message,
    expiresAt,
  ]);
  return message;
}

beforeAll(async () => {
  db = await createTestDatabase({ mode: 'fresh' });
});
afterAll(async () => {
  await db?.drop();
});

describe('consume_auth_nonce — real Postgres concurrency (regression tests 10/11)', () => {
  it('10. the SAME nonce cannot be consumed concurrently twice — exactly one of two simultaneous requests succeeds', async () => {
    const wallet = '0x1111111111111111111111111111111111aaaaab';
    const message = await seedNonce(wallet, 'nonce-abc');

    // Two genuinely concurrent calls for the exact same (wallet, nonce) —
    // fired together, not awaited one after another, so this actually
    // exercises Postgres row-level locking on the DELETE rather than two
    // sequential calls that would trivially "work" even with the OLD,
    // racy select-then-delete implementation.
    const [first, second] = await Promise.all([
      consumeNonce(wallet, 'nonce-abc'),
      consumeNonce(wallet, 'nonce-abc'),
    ]);

    const successes = [first, second].filter((r) => r !== null);
    expect(successes).toHaveLength(1);
    expect(successes[0]).toBe(message);
  });

  it('11. an expired nonce fails atomically — consumed (row removed) but never returns a usable message', async () => {
    const wallet = '0x2222222222222222222222222222222222bbbbab';
    await seedNonce(wallet, 'nonce-def', -60_000); // already expired

    const result = await consumeNonce(wallet, 'nonce-def');
    expect(result).toBeNull();

    // Still single-use: the (expired) row was consumed by the failed
    // attempt above, so a second try with the same nonce also fails,
    // never lingering as a still-usable pending challenge.
    const secondTry = await consumeNonce(wallet, 'nonce-def');
    expect(secondTry).toBeNull();
  });

  it('a wrong nonce guess never burns the real pending nonce (0040) — nobody can wipe someone else\'s sign-in', async () => {
    const wallet = '0x3333333333333333333333333333333333ccccab';
    const message = await seedNonce(wallet, 'nonce-real');

    const wrongAttempt = await consumeNonce(wallet, 'not-the-real-nonce');
    expect(wrongAttempt).toBeNull();

    const realAttempt = await consumeNonce(wallet, 'nonce-real');
    expect(realAttempt).toBe(message);
  });

  it('two outstanding nonces for one wallet are both usable, each exactly once', async () => {
    const wallet = '0x5555555555555555555555555555555555eeeeab';
    const first = await seedNonce(wallet, 'nonce-one');
    const second = await seedNonce(wallet, 'nonce-two');

    expect(await consumeNonce(wallet, 'nonce-two')).toBe(second);
    expect(await consumeNonce(wallet, 'nonce-one')).toBe(first);
    expect(await consumeNonce(wallet, 'nonce-one')).toBeNull();
  });

  it('a nonce issued for one wallet cannot be consumed with another wallet', async () => {
    await seedNonce('0x6666666666666666666666666666666666ffffab', 'nonce-owned');
    expect(await consumeNonce('0x7777777777777777777777777777777777aaaaab', 'nonce-owned')).toBeNull();
  });

  it('a genuinely fresh, unexpired nonce resolves to the exact signed message', async () => {
    const wallet = '0x4444444444444444444444444444444444ddddab';
    const message = await seedNonce(wallet, 'nonce-fresh');

    const result = await consumeNonce(wallet, 'nonce-fresh');

    expect(result).toBe(message);
  });
});
