import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestDatabase, createTestDatabase } from './pg-harness';

// -----------------------------------------------------------------------------
// Production-hardening P1-9 — real-Postgres proof that
// `get_or_create_wallet_user()` closes the first-login race: two genuinely
// concurrent calls for a wallet that has NEVER logged in before must both
// resolve to the SAME user row (never a raw unique-violation), and exactly
// one of them is the true creator (`was_created: true`) — the other
// correctly reports it lost the race, rather than either silently
// double-creating a user or throwing.
// -----------------------------------------------------------------------------

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase({ mode: 'fresh' });
});
afterAll(async () => {
  await db?.drop();
});

async function call(wallet: string, startingBalance = 10_000) {
  return db.client.rpc('get_or_create_wallet_user', {
    p_wallet_address: wallet,
    p_starting_cash_balance: startingBalance,
  });
}

describe('get_or_create_wallet_user — real Postgres concurrency', () => {
  it('two concurrent first-logins for the SAME new wallet both resolve to one user row — exactly one reports was_created: true', async () => {
    const wallet = `0x${crypto.randomBytes(20).toString('hex')}`;

    const [a, b] = await Promise.all([call(wallet), call(wallet)]);

    expect(a.error).toBeNull();
    expect(b.error).toBeNull();

    const rowA = (Array.isArray(a.data) ? a.data[0] : a.data) as { id: string; was_created: boolean };
    const rowB = (Array.isArray(b.data) ? b.data[0] : b.data) as { id: string; was_created: boolean };

    // Same user id either way — never two different rows for one wallet.
    expect(rowA.id).toBe(rowB.id);
    // Exactly one of the two actually created it.
    expect([rowA.was_created, rowB.was_created].filter(Boolean)).toHaveLength(1);

    // Exactly one users row for this wallet — no duplicate ever landed.
    const { rows } = await db.admin.query('select count(*)::int as n from users where wallet_address = $1', [wallet]);
    expect(rows[0].n).toBe(1);

    // Exactly one portfolio row, seeded with the starting balance — never
    // double-seeded, never missing.
    const { rows: portfolioRows } = await db.admin.query(
      'select count(*)::int as n, cash_balance from portfolios where user_id = $1 group by cash_balance',
      [rowA.id]
    );
    expect(portfolioRows).toHaveLength(1);
    expect(portfolioRows[0].n).toBe(1);
    expect(Number(portfolioRows[0].cash_balance)).toBe(10_000);
  });

  it('a repeat login for an already-existing wallet reports was_created: false and never touches its (possibly since-changed) balance', async () => {
    const wallet = `0x${crypto.randomBytes(20).toString('hex')}`;
    await call(wallet, 10_000);

    // Simulate the user having traded since first login.
    await db.admin.query('update portfolios set cash_balance = 5000 where user_id = (select id from users where wallet_address = $1)', [wallet]);

    const { data, error } = await call(wallet, 10_000);
    expect(error).toBeNull();
    const row = (Array.isArray(data) ? data[0] : data) as { was_created: boolean };
    expect(row.was_created).toBe(false);

    const { rows } = await db.admin.query('select cash_balance from portfolios p join users u on u.id = p.user_id where u.wallet_address = $1', [wallet]);
    expect(Number(rows[0].cash_balance)).toBe(5000); // untouched, not reset back to 10,000
  });

  it('ten concurrent first-logins for the same brand-new wallet still resolve to exactly one user row', async () => {
    const wallet = `0x${crypto.randomBytes(20).toString('hex')}`;

    const results = await Promise.all(Array.from({ length: 10 }, () => call(wallet)));
    expect(results.every((r) => r.error === null)).toBe(true);

    const ids = new Set(
      results.map((r) => ((Array.isArray(r.data) ? r.data[0] : r.data) as { id: string }).id)
    );
    expect(ids.size).toBe(1);

    const { rows } = await db.admin.query('select count(*)::int as n from users where wallet_address = $1', [wallet]);
    expect(rows[0].n).toBe(1);
  });
});
