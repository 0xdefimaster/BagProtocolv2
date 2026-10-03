import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBag } from '@/lib/server/bag-repo';
import { TestDatabase, createTestDatabase, insertUser, validRecipeInput } from './pg-harness';
import { ASSET, insertPurchaseIntent, newWallet, sumPositionShares, totalShares } from './economics-harness';

// Load behaviour of the REAL accounting RPC on a real PostgreSQL: many purchases
// of the same Bag at the same moment (truly concurrent transactions on a pooled
// connection set) must not lose an update, and the same purchase applied
// concurrently must be counted exactly once.

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db?.drop();
});

const apply = (intentId: string, bagId: string, userId: string, sharesRaw: string, costBasis: string, holdingRaw: string) =>
  db.service.query('select apply_purchase_execution($1, $2, $3::jsonb, $4, 18, $5, $6) as r', [
    intentId,
    bagId,
    JSON.stringify([{ ...ASSET, delta_raw: holdingRaw }]),
    sharesRaw,
    userId,
    costBasis,
  ]);

async function newBag() {
  const creatorId = await insertUser(db, `0x${Math.random().toString(16).slice(2).padEnd(40, '0').slice(0, 40)}`);
  const r = await createBag(db.client, { slug: `cc-${Date.now()}-${Math.random()}`, creatorId, mutability: 'MUTABLE', recipe: validRecipeInput(), reason: 't' });
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r.bag.id;
}
const holding = async (bagId: string) =>
  BigInt((await db.admin.query('select quantity_raw from bag_holdings where bag_id = $1 and address = $2', [bagId, ASSET.address])).rows[0].quantity_raw);

describe('accounting under concurrent load (real Postgres)', () => {
  it('50 simultaneous purchases of one Bag by 25 buyers: every share, holding and cost basis is counted, none lost', async () => {
    const bagId = await newBag();
    const buyers = await Promise.all(Array.from({ length: 25 }, () => newWallet(db)));
    const jobs = Array.from({ length: 50 }, (_, i) => ({ buyer: buyers[i % 25], shares: BigInt(i + 1) * BigInt(1e18), holding: BigInt(i + 1) * BigInt(1e17) }));
    const intents = await Promise.all(jobs.map((j) => insertPurchaseIntent(db, { ...j.buyer, bagId, sharesRaw: j.shares.toString() })));

    await Promise.all(jobs.map((j, i) => apply(intents[i], bagId, j.buyer.userId, j.shares.toString(), String(i + 1), j.holding.toString())));

    const expectedShares = jobs.reduce((s, j) => s + j.shares, BigInt(0));
    const expectedHolding = jobs.reduce((s, j) => s + j.holding, BigInt(0));
    expect(BigInt(await totalShares(db, bagId))).toBe(expectedShares);
    expect(BigInt(await sumPositionShares(db, bagId))).toBe(expectedShares);
    expect(await holding(bagId)).toBe(expectedHolding);
    const cost = (await db.admin.query('select coalesce(sum(cost_basis_quote::numeric), 0)::text as c from bag_investor_positions where bag_id = $1', [bagId])).rows[0].c;
    expect(Number(cost)).toBe((50 * 51) / 2);
    const applied = (await db.admin.query('select count(*)::int as n from purchase_intents where bag_id = $1 and accounting_applied_at is not null', [bagId])).rows[0].n;
    expect(applied).toBe(50);
  });

  it('the same purchase applied 8 times at once (double click, retry, reconciler + browser) is counted exactly once', async () => {
    const bagId = await newBag();
    const buyer = await newWallet(db);
    const shares = (BigInt(7) * BigInt(1e18)).toString();
    const intentId = await insertPurchaseIntent(db, { ...buyer, bagId, sharesRaw: shares });

    const results = await Promise.allSettled(Array.from({ length: 8 }, () => apply(intentId, bagId, buyer.userId, shares, '7', '700000000000000000')));
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    const appliedNow = results.filter((r) => r.status === 'fulfilled' && r.value.rows[0].r?.alreadyApplied === false).length;
    expect(appliedNow).toBe(1);
    expect(await totalShares(db, bagId)).toBe(shares);
    expect(await holding(bagId)).toBe(BigInt('700000000000000000'));
    const activities = (await db.admin.query(`select count(*)::int as n from activities where action like 'PURCHASE_EXECUTED:' || $1 || '%'`, [intentId])).rows[0].n;
    expect(activities).toBe(1);
  });
});
