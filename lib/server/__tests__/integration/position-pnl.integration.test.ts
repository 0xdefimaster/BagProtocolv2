import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createBag } from '@/lib/server/bag-repo';
import { computePositionPnl, PnlEvent } from '@/lib/domain/basket-protocol/accounting/position-pnl';
import { TestDatabase, createTestDatabase, validRecipeInput } from './pg-harness';
import { ASSET, insertPurchaseIntent, insertRedeemIntent, newWallet } from './economics-harness';

// Accounting V2 / A3 (0050): the RPCs record per-leg cost and proceeds on the
// ledger, and the pure P&L engine computes average cost and realized P&L from
// those events alone — on a real Postgres, through the production SQL.

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

const OTHER = { chain: 'robinhood', address: '0x00000000000000000000000000000000000000b2', decimals: 6 };
let n = 0;
async function bag() {
  const creator = await newWallet(db);
  const r = await createBag(db.client, { slug: `pnl-${Date.now()}-${n++}`, creatorId: creator.userId, mutability: 'MUTABLE', recipe: validRecipeInput({ performanceFeeBps: 0 }), reason: 't' });
  if (!r.ok) throw new Error(JSON.stringify(r));
  return { creator, bagId: r.bag.id };
}
async function pnl(userId: string, bagId: string) {
  const { rows } = await db.admin.query('select seq::text as seq, kind, legs, quote from ledger_events where user_id = $1 and bag_id = $2 order by seq', [userId, bagId]);
  return computePositionPnl(rows as PnlEvent[]);
}
async function buy(u: { userId: string; wallet: string }, bagId: string, legs: { asset: typeof OTHER; delta: string; cost: string }[], shares: string, cost: string) {
  const intentId = await insertPurchaseIntent(db, { ...u, bagId, sharesRaw: shares });
  await db.service.query('select apply_purchase_execution($1, $2, $3::jsonb, $4, 18, $5, $6)', [
    intentId,
    bagId,
    JSON.stringify(legs.map((l) => ({ ...l.asset, delta_raw: l.delta, cost_quote: l.cost }))),
    shares,
    u.userId,
    cost,
  ]);
}
async function sell(u: { userId: string; wallet: string }, b: { bagId: string; creator: { userId: string } }, legs: { asset: typeof OTHER; qty: string; proceeds?: string }[], shares: string, value: string) {
  const intentId = await insertRedeemIntent(db, { ...u, bagId: b.bagId, sharesRaw: shares, redeemValueQuote: value });
  await db.service.query('select apply_redeem_execution($1, $2, $3::jsonb, $4, 18, $5, $6, 0, $7)', [
    intentId,
    b.bagId,
    JSON.stringify(legs.map((l) => ({ chain: l.asset.chain, address: l.asset.address, quantity_raw: l.qty, ...(l.proceeds ? { proceeds_quote: l.proceeds } : {}) }))),
    shares,
    u.userId,
    value,
    b.creator.userId,
  ]);
}

describe('A3: per-leg cost and proceeds on the ledger → realized P&L', () => {
  it('legs carry costQuote / proceedsQuote exactly as given', async () => {
    const b = await bag();
    const u = await newWallet(db);
    await buy(u, b.bagId, [{ asset: { ...ASSET }, delta: '10', cost: '100' }], '10', '100');
    await sell(u, b, [{ asset: { ...ASSET }, qty: '4', proceeds: '52.5' }], '4', '40');
    const { rows } = await db.admin.query(`select kind, legs from ledger_events where user_id = $1 order by seq`, [u.userId]);
    expect(rows[0].legs[0]).toMatchObject({ deltaRaw: '10', costQuote: '100' });
    expect(rows[1].legs[0]).toMatchObject({ deltaRaw: '-4', proceedsQuote: '52.5' });
  });

  it('two assets, two buys, a partial and a full exit: average cost and realized P&L from the books alone', async () => {
    const b = await bag();
    const u = await newWallet(db);
    await buy(u, b.bagId, [{ asset: ASSET, delta: '10', cost: '60' }, { asset: OTHER, delta: '1000', cost: '40' }], '100', '100');
    await buy(u, b.bagId, [{ asset: ASSET, delta: '10', cost: '80' }, { asset: OTHER, delta: '1000', cost: '20' }], '100', '100');
    // Sell half: 10 of ASSET (avg 7 → basis 70) for 90, 1000 of OTHER (avg 0.03 → basis 30) for 35.
    await sell(u, b, [{ asset: ASSET, qty: '10', proceeds: '90' }, { asset: OTHER, qty: '1000', proceeds: '35' }], '100', '125');
    let r = await pnl(u.userId, b.bagId);
    expect(r.exits[0]).toMatchObject({ proceedsQuote: '125', costOfSoldQuote: '100', realizedPnlQuote: '25', feeBaseQuote: '25' });
    expect(r.costBasisQuote).toBe('100');
    // Sell the rest at a loss: realized -10, no new fee base (loss carries forward).
    await sell(u, b, [{ asset: ASSET, qty: '10', proceeds: '60' }, { asset: OTHER, qty: '1000', proceeds: '30' }], '100', '90');
    r = await pnl(u.userId, b.bagId);
    expect(r.exits[1]).toMatchObject({ realizedPnlQuote: '-10', feeBaseQuote: '0' });
    expect(r.realizedPnlQuote).toBe('15');
    expect(r.realizedHighWaterMarkQuote).toBe('25');
    expect(r.assets).toEqual([]);
  });

  it('a caller that does not send proceeds (older path) yields unknown realized P&L, not a guess', async () => {
    const b = await bag();
    const u = await newWallet(db);
    await buy(u, b.bagId, [{ asset: ASSET, delta: '10', cost: '100' }], '10', '100');
    await sell(u, b, [{ asset: ASSET, qty: '5' }], '5', '50');
    const r = await pnl(u.userId, b.bagId);
    expect(r.exits[0]).toMatchObject({ proceedsQuote: null, realizedPnlQuote: null });
  });
});
