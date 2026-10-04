import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createBag } from '@/lib/server/bag-repo';
import { computePositionPnl, PnlEvent } from '@/lib/domain/basket-protocol/accounting/position-pnl';
import { effectiveQuantityRaw } from '@/lib/domain/basket-protocol/accounting/position-value';
import { calculateRedeemAllocation, sharesToBurnForFraction } from '@/lib/domain/basket-protocol/redeem/allocation';
import { summarizeSale } from '@/lib/domain/basket-protocol/redeem/proceeds';
import { TestDatabase, createTestDatabase, validRecipeInput } from './pg-harness';
import { ASSET, insertPurchaseIntent, insertRedeemIntent, newWallet } from './economics-harness';

// -----------------------------------------------------------------------------
// Accounting V2 / A4 acceptance, on a real Postgres through the production SQL:
//   1. a partial exit leaves the position open
//   2. drift: a wallet holding 60 of a tracked 100 never sells more than 60
//   3. a failed leg is a partial sale, never a full one
//   4. realized P&L comes only from receipt proceeds
//   5. applying the same sale twice books it once
// The allocation is computed by the same pure code the sell path uses
// (effective quantity → fraction), then accounted by the real RPCs.
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

const OTHER = { chain: 'robinhood', address: '0x00000000000000000000000000000000000000b2', decimals: 18 };
const USDG = { chain: 'robinhood' as const, address: '0x00000000000000000000000000000000000000c0' };
type Asset = typeof ASSET;
type User = { userId: string; wallet: string };

let n = 0;
let block = 50_000;
async function bag() {
  const creator = await newWallet(db);
  const r = await createBag(db.client, { slug: `a4-${Date.now()}-${n++}`, creatorId: creator.userId, mutability: 'MUTABLE', recipe: validRecipeInput({ performanceFeeBps: 0 }), reason: 't' });
  if (!r.ok) throw new Error(JSON.stringify(r));
  return { creatorId: creator.userId, bagId: r.bag.id };
}
async function buy(u: User, bagId: string, legs: { asset: Asset; delta: string; cost: string }[], shares: string, cost: string) {
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
const tracked = async (u: User, bagId: string, asset: Asset = ASSET) =>
  ((await db.admin.query('select quantity_raw from bag_investor_holdings where user_id = $1 and bag_id = $2 and address = $3', [u.userId, bagId, asset.address])).rows[0]
    ?.quantity_raw ?? '0') as string;
const shares = async (u: User, bagId: string) =>
  (await db.admin.query('select shares_raw from bag_investor_positions where user_id = $1 and bag_id = $2', [u.userId, bagId])).rows[0].shares_raw as string;
const observe = async (u: User, observedRaw: string, asset: Asset = ASSET) =>
  (await db.service.query('select apply_wallet_observation($1, $2, $3, $4, $5) as r', [u.userId, asset.chain, asset.address, ++block, observedRaw])).rows[0].r;
const events = async (u: User, bagId: string) =>
  (await db.admin.query('select seq::text as seq, kind, legs, quote from ledger_events where user_id = $1 and bag_id = $2 order by seq', [u.userId, bagId])).rows as PnlEvent[];

/** The sell path's allocation: `fractionBps` of each asset's effective quantity (tracked limited by the wallet). */
async function allocate(u: User, bagId: string, fractionBps: number, observed: Record<string, string>, assets: Asset[] = [ASSET]) {
  const holdings = await Promise.all(
    assets.map(async (a) => {
      const t = await tracked(u, bagId, a);
      return { chain: 'robinhood' as const, address: a.address, decimals: a.decimals, quantityRaw: t, sellableRaw: effectiveQuantityRaw(BigInt(t), BigInt(t), BigInt(observed[a.address])).toString() };
    })
  );
  return calculateRedeemAllocation({ bagId, fractionBps, outputAsset: USDG, outputDecimals: 6, holdings });
}

async function applySale(u: User, b: { bagId: string; creatorId: string }, legs: { address: string; qty: string; proceeds?: string }[], burn: string, value: string, intentId?: string) {
  const id = intentId ?? (await insertRedeemIntent(db, { ...u, bagId: b.bagId, sharesRaw: burn === '0' ? '1' : burn, redeemValueQuote: value }));
  const r = await db.service.query('select apply_redeem_execution($1, $2, $3::jsonb, $4, 18, $5, $6, 0, $7) as r', [
    id,
    b.bagId,
    JSON.stringify(legs.map((l) => ({ chain: 'robinhood', address: l.address, quantity_raw: l.qty, ...(l.proceeds ? { proceeds_quote: l.proceeds } : {}) }))),
    burn,
    u.userId,
    value,
    b.creatorId,
  ]);
  return { intentId: id, result: r.rows[0].r };
}

describe('A4 acceptance', () => {
  it('1. partial exit: half is sold, the position stays open with the other half', async () => {
    const b = await bag();
    const u = await newWallet(db);
    await buy(u, b.bagId, [{ asset: ASSET, delta: '100', cost: '100' }], '100', '100');

    const [leg] = await allocate(u, b.bagId, 5000, { [ASSET.address]: '100' });
    expect(leg.sellQuantityRaw).toBe('50');
    await applySale(u, b, [{ address: ASSET.address, qty: leg.sellQuantityRaw, proceeds: '60' }], sharesToBurnForFraction(await shares(u, b.bagId), 5000), '60');

    expect(await tracked(u, b.bagId)).toBe('50');
    expect(await shares(u, b.bagId)).toBe('50');
    const p = computePositionPnl(await events(u, b.bagId));
    expect(p.assets).toEqual([expect.objectContaining({ quantityRaw: '50', costBasisQuote: '50' })]);
    expect(p.realizedPnlQuote).toBe('10');
  });

  it('2. drift: wallet 60 vs tracked 100 — a full exit sells 60, never the missing 40', async () => {
    const b = await bag();
    const u = await newWallet(db);
    await buy(u, b.bagId, [{ asset: ASSET, delta: '100', cost: '100' }], '100', '100');
    expect((await observe(u, '60')).status).toBe('DRIFT');

    const [leg] = await allocate(u, b.bagId, 10_000, { [ASSET.address]: '60' });
    expect(leg.sellQuantityRaw).toBe('60');
    await applySale(u, b, [{ address: ASSET.address, qty: '60', proceeds: '66' }], sharesToBurnForFraction(await shares(u, b.bagId), 10_000), '66');

    // The 40 that left the wallet is still tracked: the reconciler books it as an external outflow, not a sale.
    expect(await tracked(u, b.bagId)).toBe('40');
    await db.admin.query(`update reconciliation_records set created_at = now() - interval '3 minutes' where user_id = $1 and status = 'DRIFT'`, [u.userId]);
    expect((await observe(u, '0')).status).toBe('CONFIRMED_OUTFLOW');
    expect(await tracked(u, b.bagId)).toBe('0');

    const p = computePositionPnl(await events(u, b.bagId));
    // Realized only on the 60 sold (66 − 60); the 40 that walked out is basis exited externally, not a loss.
    expect(p.realizedPnlQuote).toBe('6');
    expect(p.basisExitedExternallyQuote).toBe('40');
  });

  it('2b. holdings that outlived their shares can still be sold (zero legacy share burn, 0051)', async () => {
    const b = await bag();
    const u = await newWallet(db);
    await buy(u, b.bagId, [{ asset: ASSET, delta: '100', cost: '100' }], '100', '100');
    await applySale(u, b, [{ address: ASSET.address, qty: '60', proceeds: '60' }], '100', '60');
    expect(await shares(u, b.bagId)).toBe('0');
    expect(sharesToBurnForFraction('0', 10_000)).toBe('0');

    await applySale(u, b, [{ address: ASSET.address, qty: '40', proceeds: '40' }], '0', '40');
    expect(await tracked(u, b.bagId)).toBe('0');
    await expect(applySale(u, b, [], '0', '0')).rejects.toThrow(/nothing sold and nothing burned/);
    await expect(applySale(u, b, [{ address: ASSET.address, qty: '1' }], '-1', '0')).rejects.toThrow(/INVALID_ACCOUNTING_DELTA/);
  });

  it('3. failed leg: one asset sells, one fails — partial, the unsold asset and the shares stay', async () => {
    const b = await bag();
    const u = await newWallet(db);
    await buy(u, b.bagId, [{ asset: ASSET, delta: '100', cost: '100' }, { asset: OTHER, delta: '200', cost: '100' }], '200', '200');

    const legs = await allocate(u, b.bagId, 10_000, { [ASSET.address]: '100', [OTHER.address]: '200' }, [ASSET, OTHER]);
    expect(legs.map((l) => l.sellQuantityRaw)).toEqual(['100', '200']);
    const steps = [
      { action: 'SWAP' as const, status: 'COMPLETED', inputAmountRaw: '100', outputAmountRaw: '110000000' },
      { action: 'SWAP' as const, status: 'FAILED', inputAmountRaw: '200', outputAmountRaw: null },
    ];
    expect(summarizeSale(steps).outcome).toBe('PARTIAL');

    const intentId = await insertRedeemIntent(db, { ...u, bagId: b.bagId, sharesRaw: '200', redeemValueQuote: '0' });
    await db.service.query('select apply_partial_redeem_execution($1, $2, $3::jsonb, $4)', [
      intentId,
      b.bagId,
      JSON.stringify([{ chain: 'robinhood', address: ASSET.address, quantity_raw: '100', proceeds_quote: '110' }]),
      u.userId,
    ]);

    expect(await tracked(u, b.bagId, ASSET)).toBe('0');
    expect(await tracked(u, b.bagId, OTHER)).toBe('200');
    expect(await shares(u, b.bagId)).toBe('200');
    const p = computePositionPnl(await events(u, b.bagId));
    expect(p.assets).toEqual([expect.objectContaining({ address: OTHER.address, quantityRaw: '200', costBasisQuote: '100' })]);
    expect(p.realizedPnlQuote).toBe('10');
  });

  it('4. realized P&L comes only from receipt proceeds, never from the quoted value', async () => {
    const b = await bag();
    const u = await newWallet(db);
    await buy(u, b.bagId, [{ asset: ASSET, delta: '100', cost: '100' }], '100', '100');
    // The quoted / NAV value says 999; the receipt says 55.
    await applySale(u, b, [{ address: ASSET.address, qty: '50', proceeds: '55' }], '50', '999');
    expect(computePositionPnl(await events(u, b.bagId)).realizedPnlQuote).toBe('5');

    // A sale with no verified proceeds leaves realized unknown, not estimated.
    await applySale(u, b, [{ address: ASSET.address, qty: '10' }], '10', '999');
    expect(computePositionPnl(await events(u, b.bagId)).realizedPnlQuote).toBeNull();
  });

  it('5. idempotency: the same sale applied twice is booked once', async () => {
    const b = await bag();
    const u = await newWallet(db);
    await buy(u, b.bagId, [{ asset: ASSET, delta: '100', cost: '100' }], '100', '100');
    const first = await applySale(u, b, [{ address: ASSET.address, qty: '30', proceeds: '33' }], '30', '33');
    const again = await applySale(u, b, [{ address: ASSET.address, qty: '30', proceeds: '33' }], '30', '33', first.intentId);

    expect(again.result.alreadyApplied).toBe(true);
    expect(await tracked(u, b.bagId)).toBe('70');
    expect(await shares(u, b.bagId)).toBe('70');
    expect((await events(u, b.bagId)).filter((e) => e.kind === 'REDEEM_FILL')).toHaveLength(1);

    // The same fraction of the same holdings always allocates the same legs.
    const a1 = await allocate(u, b.bagId, 2500, { [ASSET.address]: '70' });
    const a2 = await allocate(u, b.bagId, 2500, { [ASSET.address]: '70' });
    expect(a1).toEqual(a2);
  });
});
