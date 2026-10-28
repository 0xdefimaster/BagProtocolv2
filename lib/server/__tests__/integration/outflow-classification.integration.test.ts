import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createBag } from '@/lib/server/bag-repo';
import { computePositionPnl, PnlEvent } from '@/lib/domain/basket-protocol/accounting/position-pnl';
import { feeBasisFromPositionPnl } from '@/lib/domain/basket-protocol/redeem/performance-fee-b0';
import { TestDatabase, createTestDatabase, validRecipeInput } from './pg-harness';
import { ASSET, insertPurchaseIntent, insertRedeemIntent, newWallet } from './economics-harness';

// -----------------------------------------------------------------------------
// 0057 against a real Postgres: a sale that wallet reconciliation already took off the position as an unknown outflow
// is booked as the sale it was. classify_outflow_for_redeem gives the outflow's tokens back (OUTFLOW_CLASSIFIED), then
// the REAL apply_redeem_execution books the sale; the tokens leave the books once and the proceeds are realized
// against the basis the outflow had taken off. Every test also checks that the ledger still rebuilds the stored
// holdings, shares and legacy cost basis exactly (afterEach).
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

type User = { userId: string; wallet: string };
let n = 0;
let block = 1000;

async function bag() {
  const creator = await newWallet(db);
  const r = await createBag(db.client, { slug: `ofc-${Date.now()}-${n++}`, creatorId: creator.userId, mutability: 'MUTABLE', recipe: validRecipeInput({ performanceFeeBps: 0 }), reason: 't' });
  if (!r.ok) throw new Error(JSON.stringify(r));
  return { bagId: r.bag.id, creatorId: creator.userId };
}
async function buy(u: User, bagId: string, qty: string, cost: string) {
  const intentId = await insertPurchaseIntent(db, { ...u, bagId, sharesRaw: qty });
  await db.service.query('select apply_purchase_execution($1, $2, $3::jsonb, $4, 18, $5, $6)', [
    intentId,
    bagId,
    JSON.stringify([{ ...ASSET, delta_raw: qty, cost_quote: cost }]),
    qty,
    u.userId,
    cost,
  ]);
}
const saleIntent = (u: User, bagId: string, qty: string, value: string) => insertRedeemIntent(db, { ...u, bagId, sharesRaw: qty, redeemValueQuote: value });
async function bookSale(u: User, b: { bagId: string; creatorId: string }, intentId: string, qty: string, proceeds: string, shares = qty) {
  await db.service.query('select apply_redeem_execution($1, $2, $3::jsonb, $4, 18, $5, $6, 0, $7)', [
    intentId,
    b.bagId,
    JSON.stringify([{ chain: ASSET.chain, address: ASSET.address, quantity_raw: qty, proceeds_quote: proceeds }]),
    shares,
    u.userId,
    proceeds,
    b.creatorId,
  ]);
}
const observe = async (userId: string, observedRaw: string, at: number) =>
  (await db.service.query('select apply_wallet_observation($1, $2, $3, $4, $5) as r', [userId, ASSET.chain, ASSET.address, at, observedRaw])).rows[0].r;
const age = (userId: string) => db.admin.query(`update reconciliation_records set created_at = now() - interval '3 minutes' where user_id = $1 and status = 'DRIFT'`, [userId]);
/** Wallet observed covering everything at `ok`, then short at two later blocks: a confirmed outflow over (ok, confirmAt]. */
async function outflow(userId: string, observedRaw: string, ok: number, driftAt: number, confirmAt: number, coveredRaw: string) {
  expect((await observe(userId, coveredRaw, ok)).status).toBe('OK');
  expect((await observe(userId, observedRaw, driftAt)).status).toBe('DRIFT');
  await age(userId);
  const r = await observe(userId, observedRaw, confirmAt);
  expect(r.status).toBe('CONFIRMED_OUTFLOW');
  return r.recordId as string;
}
const classify = async (intentId: string, soldRaw: string, saleBlock: number, saleTime: string, client = db.service) =>
  (await client.query('select classify_outflow_for_redeem($1, $2, $3, $4, $5, $6) as r', [intentId, ASSET.chain, ASSET.address, soldRaw, saleBlock, saleTime])).rows[0].r as {
    status: string;
    classifiedRaw: string;
    classifications: { recordId: string; bagId: string; quantityRaw: string; approximate: boolean }[];
  };
const tracked = async (userId: string, bagId: string) =>
  (await db.admin.query('select quantity_raw from bag_investor_holdings where user_id = $1 and bag_id = $2 and address = $3', [userId, bagId, ASSET.address])).rows[0]?.quantity_raw as string;
const now = async () => (await db.admin.query('select clock_timestamp() as t')).rows[0].t as string;
async function events(userId: string, bagId: string) {
  const { rows } = await db.admin.query('select seq::text as seq, kind, legs, quote, source from ledger_events where user_id = $1 and bag_id = $2 order by seq', [userId, bagId]);
  return rows as (PnlEvent & { source: Record<string, unknown> })[];
}
const pnl = async (userId: string, bagId: string) => computePositionPnl(await events(userId, bagId));

describe('the incident: a recovered sale behind a confirmed outflow, then a new purchase', () => {
  it('without classification the sale eats the new purchase (the bug this fixes)', async () => {
    const b = await bag();
    const u = await newWallet(db);
    await buy(u, b.bagId, '10', '100');
    const sale = await saleIntent(u, b.bagId, '10', '150');
    await outflow(u.userId, '0', ++block, (block += 5), (block += 5), '10');
    await buy(u, b.bagId, '11', '121');
    await bookSale(u, b, sale, '10', '150');
    expect(await tracked(u.userId, b.bagId)).toBe('1'); // 11 bought, only 1 left on the books
  });

  it('with classification: tokens leave once, the new purchase is intact, proceeds realized against the original basis', async () => {
    const b = await bag();
    const u = await newWallet(db);
    await buy(u, b.bagId, '10', '100');
    const sale = await saleIntent(u, b.bagId, '10', '150');
    const ok = ++block;
    const saleBlock = ok + 1;
    const saleTime = await now();
    const recordId = await outflow(u.userId, '0', ok, (block += 5), (block += 5), '10');
    await buy(u, b.bagId, '11', '121');

    const r = await classify(sale, '10', saleBlock, saleTime);
    expect(r).toMatchObject({ status: 'CLASSIFIED', classifiedRaw: '10' });
    expect(r.classifications).toEqual([{ recordId, bagId: b.bagId, quantityRaw: '10', approximate: false }]);
    expect(await tracked(u.userId, b.bagId)).toBe('21');

    await bookSale(u, b, sale, '10', '150');
    expect(await tracked(u.userId, b.bagId)).toBe('11');

    const p = await pnl(u.userId, b.bagId);
    expect(p.assets).toEqual([{ chain: ASSET.chain, address: ASSET.address, quantityRaw: '11', costBasisQuote: '121', costBasisApproximate: false }]);
    expect(p.realizedPnlQuote).toBe('50');
    expect(p.basisExitedExternallyQuote).toBe('0');
  });
});

describe('maliyet esası / cost basis', () => {
  it('no purchase between sale and outflow: P&L is exactly the same as if the sale had been booked straight away', async () => {
    const direct = await bag();
    const u1 = await newWallet(db);
    await buy(u1, direct.bagId, '10', '100');
    await buy(u1, direct.bagId, '10', '140');
    await bookSale(u1, direct, await saleIntent(u1, direct.bagId, '5', '90'), '5', '90');

    const late = await bag();
    const u2 = await newWallet(db);
    await buy(u2, late.bagId, '10', '100');
    await buy(u2, late.bagId, '10', '140');
    const sale = await saleIntent(u2, late.bagId, '5', '90');
    const ok = ++block;
    const t = await now();
    await outflow(u2.userId, '15', ok, (block += 5), (block += 5), '20');
    await classify(sale, '5', ok + 2, t);
    await bookSale(u2, late, sale, '5', '90');

    const [a, b] = [await pnl(u1.userId, direct.bagId), await pnl(u2.userId, late.bagId)];
    expect(b.realizedPnlQuote).toBe(a.realizedPnlQuote);
    expect(b.realizedPnlQuote).toBe('30');
    expect(b.assets.map((x) => [x.quantityRaw, x.costBasisQuote, x.costBasisApproximate])).toEqual(a.assets.map((x) => [x.quantityRaw, x.costBasisQuote, false]));
  });

  it('a purchase between sale and outflow: APPROXIMATE on the position, a note, and no fee basis', async () => {
    const b = await bag();
    const u = await newWallet(db);
    await buy(u, b.bagId, '10', '100');
    const sale = await saleIntent(u, b.bagId, '10', '150');
    const ok = ++block;
    const saleTime = await now();
    expect((await observe(u.userId, '10', ok)).status).toBe('OK');
    await buy(u, b.bagId, '5', '75'); // after the sale, before reconciliation sees the shortfall
    expect((await observe(u.userId, '5', (block += 5))).status).toBe('DRIFT');
    await age(u.userId);
    expect((await observe(u.userId, '5', (block += 5))).status).toBe('CONFIRMED_OUTFLOW');

    const r = await classify(sale, '10', ok + 1, saleTime);
    expect(r.classifications.every((c) => c.approximate)).toBe(true);
    await bookSale(u, b, sale, '10', '150');

    const p = await pnl(u.userId, b.bagId);
    expect(p.assets[0]).toMatchObject({ quantityRaw: '5', costBasisApproximate: true });
    expect(feeBasisFromPositionPnl(p, [{ chain: ASSET.chain, address: ASSET.address, quantityRaw: '1' }])).toEqual({ ok: false, reason: 'BASIS_APPROXIMATE' });
    const notes = (await events(u.userId, b.bagId)).filter((e) => e.kind === 'RECONCILIATION_NOTE');
    expect(notes).toHaveLength(1);
    expect(notes[0].quote.note).toBe('APPROXIMATE_COST_BASIS');
  });

  it('partial classifications give back exactly the basis the outflow took: $40 then $60', async () => {
    const b = await bag();
    const u = await newWallet(db);
    await buy(u, b.bagId, '10', '100');
    const [s1, s2] = [await saleIntent(u, b.bagId, '4', '60'), await saleIntent(u, b.bagId, '6', '90')];
    const ok = ++block;
    const t = await now();
    await outflow(u.userId, '0', ok, (block += 5), (block += 5), '10');
    await classify(s1, '4', ok + 1, t);
    await bookSale(u, b, s1, '4', '60');
    let p = await pnl(u.userId, b.bagId);
    expect(p.realizedPnlQuote).toBe('20'); // 60 - 40
    await classify(s2, '6', ok + 2, t);
    await bookSale(u, b, s2, '6', '90');
    p = await pnl(u.userId, b.bagId);
    expect(p.realizedPnlQuote).toBe('50'); // + (90 - 60)
    expect(p.basisExitedExternallyQuote).toBe('0');
    expect(p.assets).toEqual([]);
  });

  it('a basis that does not divide evenly ($100 over 3 + 3 + 4) is given back to the last unit', async () => {
    const b = await bag();
    const u = await newWallet(db);
    await buy(u, b.bagId, '10', '100');
    const sales = [await saleIntent(u, b.bagId, '3', '30'), await saleIntent(u, b.bagId, '3', '30'), await saleIntent(u, b.bagId, '4', '40')];
    const ok = ++block;
    const t = await now();
    await outflow(u.userId, '0', ok, (block += 5), (block += 5), '10');
    for (const [i, qty] of ['3', '3', '4'].entries()) {
      await classify(sales[i], qty, ok + 1, t);
      await bookSale(u, b, sales[i], qty, qty === '4' ? '40' : '30');
    }
    const p = await pnl(u.userId, b.bagId);
    expect(p.realizedPnlQuote).toBe('0'); // proceeds 100 against basis 100 exactly
    expect(p.basisExitedExternallyQuote).toBe('0');
  });
});

describe('only what the sale explains, only once', () => {
  it('a sale outside the outflow window is not classified and is booked from what is still tracked', async () => {
    const b = await bag();
    const u = await newWallet(db);
    await buy(u, b.bagId, '20', '200');
    const sale = await saleIntent(u, b.bagId, '5', '75');
    const ok = ++block;
    const t = await now();
    await outflow(u.userId, '15', ok, (block += 5), (block += 5), '20'); // 5 left by another way
    const r = await classify(sale, '5', block + 10, t); // mined after the outflow was observed
    expect(r).toMatchObject({ status: 'NONE', classifiedRaw: '0' });
    await bookSale(u, b, sale, '5', '75');
    expect(await tracked(u.userId, b.bagId)).toBe('10');
  });

  it('two sales into one outflow record: the total classified never exceeds what the record took', async () => {
    const b = await bag();
    const u = await newWallet(db);
    await buy(u, b.bagId, '10', '100');
    const sales = [await saleIntent(u, b.bagId, '4', '1'), await saleIntent(u, b.bagId, '6', '1'), await saleIntent(u, b.bagId, '1', '1')];
    const ok = ++block;
    const t = await now();
    await outflow(u.userId, '0', ok, (block += 5), (block += 5), '10');
    expect((await classify(sales[0], '4', ok + 1, t)).classifiedRaw).toBe('4');
    expect((await classify(sales[1], '6', ok + 1, t)).classifiedRaw).toBe('6');
    expect((await classify(sales[2], '1', ok + 1, t)).classifiedRaw).toBe('0');
  });

  it('concurrent classifications of one record by two sales: the record lock serializes them, 10 in total', async () => {
    const b = await bag();
    const u = await newWallet(db);
    await buy(u, b.bagId, '10', '100');
    const [s1, s2] = [await saleIntent(u, b.bagId, '10', '1'), await saleIntent(u, b.bagId, '10', '1')];
    const ok = ++block;
    const t = await now();
    await outflow(u.userId, '0', ok, (block += 5), (block += 5), '10');
    const [c1, c2] = await Promise.all([db.service.connect(), db.service.connect()]);
    try {
      await c1.query("set role service_role");
      await c2.query("set role service_role");
      const [r1, r2] = await Promise.all([classify(s1, '10', ok + 1, t, c1 as never), classify(s2, '10', ok + 1, t, c2 as never)]);
      expect([r1.classifiedRaw, r2.classifiedRaw].sort()).toEqual(['0', '10']);
    } finally {
      c1.release();
      c2.release();
    }
    expect(await tracked(u.userId, b.bagId)).toBe('10');
  });

  it('a replayed classification writes nothing new (ALREADY_APPLIED), and none once the sale is booked (ALREADY_BOOKED)', async () => {
    const b = await bag();
    const u = await newWallet(db);
    await buy(u, b.bagId, '10', '100');
    const sale = await saleIntent(u, b.bagId, '10', '150');
    const ok = ++block;
    const t = await now();
    await outflow(u.userId, '0', ok, (block += 5), (block += 5), '10');
    await classify(sale, '10', ok + 1, t);
    // Between the two RPCs (classified, sale not booked yet) the tokens are held again, at the basis they left with.
    expect((await pnl(u.userId, b.bagId)).assets).toEqual([{ chain: ASSET.chain, address: ASSET.address, quantityRaw: '10', costBasisQuote: '100', costBasisApproximate: false }]);
    const count = async () => (await events(u.userId, b.bagId)).length;
    const before = await count();
    expect(await classify(sale, '10', ok + 1, t)).toMatchObject({ status: 'ALREADY_APPLIED', classifiedRaw: '10' });
    expect(await count()).toBe(before);
    expect(await tracked(u.userId, b.bagId)).toBe('10');

    await bookSale(u, b, sale, '10', '150');
    await db.admin.query('update redeem_intents set accounting_applied_at = now() where id = $1', [sale]);
    expect((await classify(sale, '10', ok + 1, t)).status).toBe('ALREADY_BOOKED');
  });

  it('OUTFLOW_CLASSIFIED comes before the REDEEM_FILL it explains, and the projection is the same every time', async () => {
    const b = await bag();
    const u = await newWallet(db);
    await buy(u, b.bagId, '10', '100');
    const sale = await saleIntent(u, b.bagId, '10', '150');
    const ok = ++block;
    const t = await now();
    await outflow(u.userId, '0', ok, (block += 5), (block += 5), '10');
    await classify(sale, '10', ok + 1, t);
    await bookSale(u, b, sale, '10', '150');
    const ev = await events(u.userId, b.bagId);
    const classified = ev.filter((e) => e.kind === 'OUTFLOW_CLASSIFIED').map((e) => BigInt(e.seq));
    const fill = BigInt(ev.find((e) => e.kind === 'REDEEM_FILL')!.seq);
    expect(classified.length).toBeGreaterThan(0);
    expect(classified.every((s) => s < fill)).toBe(true);
    const runs = [computePositionPnl(ev), computePositionPnl([...ev].reverse()), computePositionPnl(ev)];
    expect(runs[1]).toEqual(runs[0]);
    expect(runs[2]).toEqual(runs[0]);
    expect(runs[0].realizedPnlQuote).toBe('50');
  });
});

describe('several Bags holding the same token', () => {
  async function twoBags() {
    const [a, b] = [await bag(), await bag()];
    const u = await newWallet(db);
    await buy(u, a.bagId, '60', '60');
    await buy(u, b.bagId, '40', '40');
    return { u, a, b };
  }

  it('a sale from Bag A behind an outflow spread over A and B: B gets its share back, the sale stays in A', async () => {
    const { u, a, b } = await twoBags();
    const sale = await saleIntent(u, a.bagId, '20', '30');
    const ok = ++block;
    const t = await now();
    await outflow(u.userId, '80', ok, (block += 5), (block += 5), '100'); // spread 12 (A) / 8 (B)
    expect(await tracked(u.userId, a.bagId)).toBe('48');
    expect(await tracked(u.userId, b.bagId)).toBe('32');

    const r = await classify(sale, '20', ok + 1, t);
    expect(Object.fromEntries(r.classifications.map((c) => [c.bagId, c.quantityRaw]))).toEqual({ [a.bagId]: '12', [b.bagId]: '8' });
    await bookSale(u, a, sale, '20', '30');

    expect(await tracked(u.userId, a.bagId)).toBe('40');
    expect(await tracked(u.userId, b.bagId)).toBe('40');
    const [pa, pb] = [await pnl(u.userId, a.bagId), await pnl(u.userId, b.bagId)];
    expect(pa.realizedPnlQuote).toBe('10'); // 30 - 20
    expect(pa.assets[0]).toMatchObject({ quantityRaw: '40', costBasisQuote: '40' });
    expect(pb.assets[0]).toMatchObject({ quantityRaw: '40', costBasisQuote: '40' });
    expect(pb.basisExitedExternallyQuote).toBe('0');
  });

  it('integer split: 5 of a 7-unit outflow over two Bags gives whole units, never above a Bag’s allocation, summing to 5', async () => {
    const [a, b] = [await bag(), await bag()];
    const u = await newWallet(db);
    await buy(u, a.bagId, '50', '50');
    await buy(u, b.bagId, '50', '50');
    const sale = await saleIntent(u, a.bagId, '5', '5');
    const ok = ++block;
    const t = await now();
    await outflow(u.userId, '93', ok, (block += 5), (block += 5), '100');
    const alloc = (await db.admin.query(`select allocation from reconciliation_records where user_id = $1 and status = 'CONFIRMED_OUTFLOW'`, [u.userId])).rows[0]
      .allocation as { bagId: string; allocatedRaw: string }[];
    const allocated = Object.fromEntries(alloc.map((x) => [x.bagId, BigInt(x.allocatedRaw)]));

    const r = await classify(sale, '5', ok + 1, t);
    const parts = r.classifications.map((c) => BigInt(c.quantityRaw));
    expect(parts.reduce((x, y) => x + y, BigInt(0))).toBe(BigInt(5));
    for (const c of r.classifications) expect(BigInt(c.quantityRaw) <= allocated[c.bagId]).toBe(true);
  });
});

describe('guarantees the design relies on', () => {
  it('outflows recorded before 0057 (no window) are never classified, and the overlap is reported', async () => {
    const b = await bag();
    const u = await newWallet(db);
    await buy(u, b.bagId, '10', '100');
    const sale = await saleIntent(u, b.bagId, '10', '150');
    const ok = ++block;
    const t = await now();
    await outflow(u.userId, '0', ok, (block += 5), (block += 5), '10');
    await db.admin.query('update reconciliation_records set prev_block_number = null where user_id = $1', [u.userId]);
    expect((await db.service.query('select legacy_outflow_overlaps($1) as r', [sale])).rows[0].r).toBe(true);
    expect((await classify(sale, '10', ok + 1, t)).status).toBe('NONE');
  });

  it('apply_wallet_observation keeps its signature and results, and records the window', async () => {
    const b = await bag();
    const u = await newWallet(db);
    await buy(u, b.bagId, '10', '100');
    const ok = ++block;
    expect((await observe(u.userId, '10', ok)).status).toBe('OK');
    expect((await db.admin.query('select last_ok_block from wallet_observation_marks where user_id = $1', [u.userId])).rows[0].last_ok_block).toBe(ok);
    await observe(u.userId, '4', (block += 5));
    await age(u.userId);
    const confirmAt = (block += 5);
    expect((await observe(u.userId, '4', confirmAt)).status).toBe('CONFIRMED_OUTFLOW');
    const recs = (await db.admin.query('select status, prev_block_number, block_number from reconciliation_records where user_id = $1 order by created_at, id', [u.userId])).rows;
    expect(recs.map((r) => [r.status, r.prev_block_number])).toEqual([
      ['RESOLVED', ok],
      ['CONFIRMED_OUTFLOW', ok],
    ]);
  });

  it('one intent, one fill event: a second REDEEM_FILL for the same intent is refused by the database', async () => {
    const b = await bag();
    const u = await newWallet(db);
    await buy(u, b.bagId, '10', '100');
    const sale = await saleIntent(u, b.bagId, '5', '50');
    await bookSale(u, b, sale, '5', '50');
    await expect(
      db.admin.query(`insert into ledger_events (user_id, bag_id, kind, source, idempotency_key) values ($1, $2, 'REDEEM_FILL', '{}'::jsonb, $3)`, [u.userId, b.bagId, `REDEEM_FILL:${sale}`])
    ).rejects.toThrow(/duplicate key|unique/);
    const appended = (await db.service.query(`select ledger_append($1, $2, 'REDEEM_FILL', '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, $3) as id`, [u.userId, b.bagId, `REDEEM_FILL:${sale}`])).rows[0].id;
    expect(appended).toBeNull();
  });

  it('one transaction, one intent: intent_tx_claims (0040) gives a verified hash to the first intent only', async () => {
    const b = await bag();
    const u = await newWallet(db);
    const [i1, i2] = [await saleIntent(u, b.bagId, '1', '1'), await saleIntent(u, b.bagId, '1', '1')];
    const hash = `0x${'ab'.repeat(32)}`;
    const claim = async (id: string) => (await db.service.query(`select claim_intent_tx_hash('robinhood', $1, 'REDEEM', $2) as r`, [hash, id])).rows[0].r;
    expect(await claim(i1)).toBe(true);
    expect(await claim(i2)).toBe(false);
    expect(await claim(i1)).toBe(true);
  });
});
