import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestDatabase, createDraftBag, createTestDatabase, insertUser, WALLET_A } from './pg-harness';

// -----------------------------------------------------------------------------
// Migration 0055 against a real PostgreSQL: snapshots without shares are
// accepted, and bag_nav_index_summaries reads returns from the price index
// only (snapshots recorded before it are ignored), TVL from the latest snapshot.
// -----------------------------------------------------------------------------

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase({ mode: 'fresh' });
});
afterAll(async () => {
  await db?.drop();
});

const DAY = 24 * 60 * 60 * 1000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

async function snapshot(bagId: string, capturedAt: string, grossNav: string, priceIndex: string | null, navPerShare: string | null) {
  await db.admin.query(
    `insert into bag_nav_snapshots (bag_id, captured_at, gross_nav, nav_per_share, total_shares_raw, share_decimals, price_index, components)
     values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [bagId, capturedAt, grossNav, navPerShare, navPerShare === null ? null : '1', navPerShare === null ? null : 18, priceIndex, priceIndex === null ? null : '[]']
  );
}

describe('migration 0055: price index snapshots', () => {
  it('reads returns from the index only and TVL from the latest snapshot', async () => {
    const creator = await insertUser(db, WALLET_A);
    const { bag } = await createDraftBag(db, creator);
    await snapshot(bag.id, ago(60 * DAY), '10', null, '5'); // before the index: never a return base
    await snapshot(bag.id, ago(40 * DAY), '10', '100', '1');
    await snapshot(bag.id, ago(10 * DAY), '12', '110', null); // no shares at that time
    await snapshot(bag.id, ago(60 * 60 * 1000), '7.5', '121', '0.3'); // NAV per share fell (outflow), the index did not

    const { rows } = await db.admin.query('select * from bag_nav_index_summaries($1::uuid[])', [[bag.id]]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ bag_id: bag.id, price_index: '121', price_index_7d: '110', price_index_30d: '100' });
    expect(String(rows[0].gross_nav)).toBe('7.5');
  });

  it('a Bag with only pre-index snapshots has TVL and no index', async () => {
    const creator = await insertUser(db, '0x' + '9'.repeat(40));
    const { bag } = await createDraftBag(db, creator);
    await snapshot(bag.id, ago(DAY), '4', null, '2');
    const { rows } = await db.admin.query('select * from bag_nav_index_summaries($1::uuid[])', [[bag.id]]);
    expect(rows[0]).toMatchObject({ price_index: null, price_index_7d: null });
    expect(String(rows[0].gross_nav)).toBe('4');
  });

  it('is callable by service_role only', async () => {
    const anon = await db.asRole('anon', (c) => c.query('select * from bag_nav_index_summaries($1::uuid[])', [[]]).then(() => 'ok', () => 'denied'));
    expect(anon).toBe('denied');
  });
});
