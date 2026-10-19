import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createBag } from '@/lib/server/bag-repo';
import { TestDatabase, createTestDatabase, validRecipeInput } from './pg-harness';
import { ASSET, insertRedeemIntent, newWallet, purchase } from './economics-harness';

// -----------------------------------------------------------------------------
// Accounting V2 / A2 (0049): apply_wallet_observation against a real Postgres.
// Drift is recorded first, booked as EXTERNAL_OUTFLOW only when it persists,
// allocated pro rata with the allocation stored, and the ledger still rebuilds
// the investor tables exactly afterwards.
// -----------------------------------------------------------------------------

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase({ mode: 'fresh' });
});
afterAll(async () => {
  await db?.drop();
});
afterEach(async () => {
  expect((await db.service.query('select * from ledger_projection_mismatches()')).rows).toEqual([]);
});

let n = 0;
let block = 1000;
async function bag() {
  const creator = await newWallet(db);
  const r = await createBag(db.client, { slug: `recon-${Date.now()}-${n++}`, creatorId: creator.userId, mutability: 'MUTABLE', recipe: validRecipeInput({ performanceFeeBps: 0 }), reason: 't' });
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r.bag.id;
}
const observe = async (userId: string, observedRaw: string | number, at = ++block) =>
  (await db.service.query('select apply_wallet_observation($1, $2, $3, $4, $5) as r', [userId, ASSET.chain, ASSET.address, at, String(observedRaw)])).rows[0].r;
const tracked = async (userId: string, bagId: string) =>
  (await db.admin.query('select quantity_raw from bag_investor_holdings where user_id = $1 and bag_id = $2 and address = $3', [userId, bagId, ASSET.address])).rows[0]?.quantity_raw as string;
const records = async (userId: string) =>
  (await db.admin.query('select status, shortfall_raw, allocation, confirms_record_id, id from reconciliation_records where user_id = $1 order by created_at, id', [userId])).rows;
const outflows = async (userId: string) =>
  (await db.admin.query(`select bag_id, legs, quote, source from ledger_events where user_id = $1 and kind = 'EXTERNAL_OUTFLOW' order by seq`, [userId])).rows;
const age = (userId: string) => db.admin.query(`update reconciliation_records set created_at = now() - interval '3 minutes' where user_id = $1 and status = 'DRIFT'`, [userId]);

/** A user holding 60 units through bag A and 40 through bag B. */
async function twoBags() {
  const [a, b] = [await bag(), await bag()];
  const u = await newWallet(db);
  await purchase(db, { ...u, bagId: a, sharesRaw: '60', costBasis: '60', holdingRaw: '60' });
  await purchase(db, { ...u, bagId: b, sharesRaw: '40', costBasis: '40', holdingRaw: '40' });
  return { u, a, b };
}

describe('apply_wallet_observation', () => {
  it('wallet holds at least what BAG tracks: OK, nothing recorded (surplus is not BAG exposure)', async () => {
    const { u } = await twoBags();
    expect((await observe(u.userId, 100)).status).toBe('OK');
    expect((await observe(u.userId, 150)).status).toBe('OK');
    expect(await records(u.userId)).toEqual([]);
  });

  it('first shortfall is DRIFT only: allocation stored pro rata, holdings and ledger untouched', async () => {
    const { u, a, b } = await twoBags();
    const r = await observe(u.userId, 80);
    expect(r).toMatchObject({ status: 'DRIFT', trackedRaw: '100', observedRaw: '80', shortfallRaw: '20' });
    const [rec] = await records(u.userId);
    expect(rec.status).toBe('DRIFT');
    const alloc = Object.fromEntries((rec.allocation as { bagId: string; allocatedRaw: string }[]).map((x) => [x.bagId, x.allocatedRaw]));
    expect(alloc).toEqual({ [a]: '12', [b]: '8' });
    expect(await tracked(u.userId, a)).toBe('60');
    expect(await outflows(u.userId)).toEqual([]);
  });

  it('still short but too soon to confirm: stays one DRIFT record', async () => {
    const { u } = await twoBags();
    await observe(u.userId, 80);
    expect((await observe(u.userId, 80)).status).toBe('DRIFT');
    expect(await records(u.userId)).toHaveLength(1);
  });

  it('still short after the confirmation window: EXTERNAL_OUTFLOW per strategy, tracked follows the chain down', async () => {
    const { u, a, b } = await twoBags();
    await observe(u.userId, 80);
    await age(u.userId);
    const r = await observe(u.userId, 80);
    expect(r.status).toBe('CONFIRMED_OUTFLOW');

    expect(await tracked(u.userId, a)).toBe('48');
    expect(await tracked(u.userId, b)).toBe('32');
    const ev = await outflows(u.userId);
    expect(ev.map((e) => [e.bag_id, e.legs[0].deltaRaw, e.quote.reason])).toEqual(
      expect.arrayContaining([
        [a, '-12', 'UNKNOWN_OUTFLOW'],
        [b, '-8', 'UNKNOWN_OUTFLOW'],
      ])
    );
    const recs = await records(u.userId);
    expect(recs.map((x) => x.status)).toEqual(['RESOLVED', 'CONFIRMED_OUTFLOW']);
    expect(recs[1].confirms_record_id).toBe(recs[0].id);
    expect(ev[0].source.reconciliationRecordId).toBe(recs[1].id);
    // The Bag aggregate followed too.
    const agg = (await db.admin.query('select quantity_raw from bag_holdings where bag_id = $1 and address = $2', [a, ASSET.address])).rows[0].quantity_raw;
    expect(agg).toBe('48');

    // Now consistent: the next observation is OK.
    expect((await observe(u.userId, 80)).status).toBe('OK');
  });

  it('the balance comes back before confirmation: drift RESOLVED, no event', async () => {
    const { u } = await twoBags();
    await observe(u.userId, 80);
    expect((await observe(u.userId, 100)).status).toBe('RESOLVED');
    expect((await records(u.userId)).map((x) => x.status)).toEqual(['RESOLVED']);
    expect(await outflows(u.userId)).toEqual([]);
  });

  it('tokens arriving after a booked outflow are not re-attached, and nothing is deleted', async () => {
    const { u, a } = await twoBags();
    await observe(u.userId, 80);
    await age(u.userId);
    await observe(u.userId, 80);
    expect((await observe(u.userId, 100)).status).toBe('OK');
    expect(await tracked(u.userId, a)).toBe('48');
    expect(await outflows(u.userId)).toHaveLength(2);
  });

  it('never observes while a redemption is in flight (its sale would look like an outflow)', async () => {
    const { u, a } = await twoBags();
    const intentId = await insertRedeemIntent(db, { ...u, bagId: a, sharesRaw: '10', redeemValueQuote: '10' });
    await db.admin.query(`update redeem_intents set status = 'SUBMITTED' where id = $1`, [intentId]);
    expect(await observe(u.userId, 0)).toEqual({ status: 'SKIPPED', reason: 'REDEEM_IN_FLIGHT' });
    expect(await records(u.userId)).toEqual([]);
    // An unsigned intent that has expired no longer blocks.
    await db.admin.query(`update redeem_intents set status = 'AWAITING_SIGNATURE', expires_at = now() - interval '1 minute' where id = $1`, [intentId]);
    expect((await observe(u.userId, 100)).status).toBe('OK');
  });

  it('an observation older than one already recorded is ignored', async () => {
    const { u } = await twoBags();
    await observe(u.userId, 80, 5000);
    expect(await observe(u.userId, 0, 4999)).toEqual({ status: 'SKIPPED', reason: 'STALE_BLOCK' });
  });

  it('rejects malformed input', async () => {
    const { u } = await twoBags();
    await expect(observe(u.userId, '-1')).rejects.toThrow(/INVALID_OBSERVATION/);
    await expect(observe(u.userId, '1.5')).rejects.toThrow(/INVALID_OBSERVATION/);
  });

  it('a single strategy takes the whole shortfall; rounding never over-allocates', async () => {
    const one = await bag();
    const u = await newWallet(db);
    await purchase(db, { ...u, bagId: one, sharesRaw: '7', costBasis: '7', holdingRaw: '7' });
    await observe(u.userId, 0);
    await age(u.userId);
    expect((await observe(u.userId, 0)).status).toBe('CONFIRMED_OUTFLOW');
    expect(await tracked(u.userId, one)).toBe('0');
  });

  it('due list: users holding anything, least recently checked first', async () => {
    const { u } = await twoBags();
    const due = (await db.service.query('select * from wallet_reconciliation_due(500)')).rows;
    const mine = due.find((d) => d.user_id === u.userId);
    expect(mine.assets).toEqual([{ chain: ASSET.chain, address: ASSET.address, decimals: 18 }]);
    await db.service.query('select mark_wallet_reconciled($1, 123)', [u.userId]);
    const after = (await db.service.query('select * from wallet_reconciliation_due(500)')).rows.map((d) => d.user_id);
    expect(after.indexOf(u.userId)).toBe(after.length - 1);
  });
});

describe('mark_wallets_reconciled (0060)', () => {
  const state = async (ids: string[]) =>
    (await db.admin.query('select user_id, last_block_number::text as b from wallet_reconciliation_state where user_id = any($1) order by last_block_number, user_id', [ids])).rows.map((r) => [r.user_id, r.b]);

  it('marks a list at one block in one call; the block never moves back; duplicates count once', async () => {
    const a = await newWallet(db);
    const b = await newWallet(db);
    await db.service.query('select mark_wallet_reconciled($1, 5000)', [a.userId]);
    const n = (await db.service.query('select mark_wallets_reconciled($1::uuid[], 4000) as n', [[a.userId, b.userId, b.userId]])).rows[0].n;
    expect(n).toBe(2);
    // a stays at 5000 (newer than 4000); b is new at 4000.
    expect(await state([a.userId, b.userId])).toEqual(
      [
        [b.userId, '4000'],
        [a.userId, '5000'],
      ]
    );
    await db.service.query('select mark_wallets_reconciled($1::uuid[], 9000)', [[a.userId, b.userId]]);
    expect((await state([a.userId, b.userId])).map((r) => r[1])).toEqual(['9000', '9000']);
  });

  it('only the service role may call it', async () => {
    for (const role of ['anon', 'authenticated'] as const) {
      await expect(db.asRole(role, (c) => c.query('select mark_wallets_reconciled($1::uuid[], 1)', [[]]))).rejects.toThrow(/permission denied/);
    }
  });
});

