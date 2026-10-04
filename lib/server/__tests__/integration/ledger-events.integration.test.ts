import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createBag } from '@/lib/server/bag-repo';
import { TestDatabase, createTestDatabase, validRecipeInput } from './pg-harness';
import { ASSET, insertPurchaseIntent, insertRedeemIntent, newWallet, purchase, redeem } from './economics-harness';

// -----------------------------------------------------------------------------
// Accounting V2 / A1 (0048): every accounting RPC appends one immutable ledger
// event in the same transaction, and the investor tables can be rebuilt from
// the events alone. After EVERY test, ledger_projection_mismatches() must be
// empty for the whole database.
// -----------------------------------------------------------------------------

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase({ mode: 'fresh' });
});
afterAll(async () => {
  await db?.drop();
});
afterEach(async () => {
  expect(await mismatches()).toEqual([]);
});

const E18 = BigInt(10) ** BigInt(18);
const units = (n: number) => (BigInt(n) * E18).toString();
const OTHER = { chain: 'robinhood', address: '0x00000000000000000000000000000000000000b2', decimals: 6 };
let n = 0;

async function mismatches() {
  return (await db.service.query('select * from ledger_projection_mismatches()')).rows;
}
async function events(userId: string, bagId: string) {
  return (
    await db.admin.query(
      'select kind, legs, quote, source, idempotency_key, strategy_version from ledger_events where user_id = $1 and bag_id = $2 order by seq',
      [userId, bagId]
    )
  ).rows as { kind: string; legs: { chain: string; address: string; decimals: number | null; deltaRaw: string }[]; quote: Record<string, unknown>; source: Record<string, unknown>; idempotency_key: string; strategy_version: number | null }[];
}
async function bag(feeBps = 1000) {
  const creator = await newWallet(db);
  const r = await createBag(db.client, { slug: `ledger-${Date.now()}-${n++}`, creatorId: creator.userId, mutability: 'MUTABLE', recipe: validRecipeInput({ performanceFeeBps: feeBps }), reason: 't' });
  if (!r.ok) throw new Error(JSON.stringify(r));
  return { creator, bagId: r.bag.id };
}

describe('purchase', () => {
  it('appends one PURCHASE_FILL carrying exactly what the RPC credited', async () => {
    const b = await bag();
    const inv = await newWallet(db);
    const { intentId } = await purchase(db, { ...inv, bagId: b.bagId, sharesRaw: units(10), costBasis: '10.00', holdingRaw: units(7) });

    const ev = await events(inv.userId, b.bagId);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({
      kind: 'PURCHASE_FILL',
      idempotency_key: `PURCHASE_FILL:${intentId}`,
      source: { intentKind: 'PURCHASE', intentId },
      strategy_version: 1,
      quote: { sharesDeltaRaw: units(10), costBasisDeltaQuote: '10.00', shareDecimals: 18 },
    });
    expect(ev[0].legs).toEqual([{ chain: ASSET.chain, address: ASSET.address, decimals: 18, deltaRaw: units(7) }]);
  });

  it('applying the same intent again adds nothing (RPC idempotency and the unique key agree)', async () => {
    const b = await bag();
    const inv = await newWallet(db);
    const intentId = await insertPurchaseIntent(db, { ...inv, bagId: b.bagId, sharesRaw: units(1) });
    await purchase(db, { ...inv, bagId: b.bagId, sharesRaw: units(1), costBasis: '1', intentId });
    const again = await purchase(db, { ...inv, bagId: b.bagId, sharesRaw: units(1), costBasis: '1', intentId });
    expect(again.result.alreadyApplied).toBe(true);
    expect(await events(inv.userId, b.bagId)).toHaveLength(1);
  });

  it('a fork purchase also records the royalty, on the root creator', async () => {
    const root = await bag(0);
    const forker = await newWallet(db);
    const inv = await newWallet(db);
    const intentId = await insertPurchaseIntent(db, { ...inv, bagId: root.bagId, sharesRaw: units(1) });
    await db.service.query('select apply_purchase_execution($1, $2, $3::jsonb, $4, 18, $5, $6, $7, $8) as r', [
      intentId,
      root.bagId,
      JSON.stringify([{ ...ASSET, delta_raw: units(1) }]),
      units(1),
      inv.userId,
      '100',
      150,
      forker.userId,
    ]);
    const royalty = await events(forker.userId, root.bagId);
    expect(royalty).toHaveLength(1);
    expect(royalty[0]).toMatchObject({ kind: 'ROYALTY_ACCRUED', legs: [], quote: { amountQuote: '1.50', baseQuote: '100', bps: 150, payerUserId: inv.userId } });
  });

  it('partial purchase: the assets that arrived, and shares/cost basis only when shares were minted', async () => {
    const b = await bag();
    const inv = await newWallet(db);
    const run = async (shares: string, cost: string) => {
      const intentId = await insertPurchaseIntent(db, { ...inv, bagId: b.bagId, sharesRaw: units(5), status: 'PARTIAL_SUCCESS' });
      await db.service.query('select apply_partial_purchase_execution($1, $2, $3::jsonb, $4, $5, 18, $6)', [
        intentId,
        b.bagId,
        JSON.stringify([{ ...OTHER, delta_raw: '1000' }]),
        inv.userId,
        shares,
        cost,
      ]);
      return intentId;
    };
    await run(units(2), '2');
    await run('0', '3'); // no shares: cost basis must not move either
    const ev = await events(inv.userId, b.bagId);
    expect(ev.map((e) => [e.kind, e.quote.sharesDeltaRaw, e.quote.costBasisDeltaQuote, e.quote.partial])).toEqual([
      ['PURCHASE_FILL', units(2), '2', true],
      ['PURCHASE_FILL', '0', '0', true],
    ]);
  });
});

describe('redeem', () => {
  it('appends REDEEM_FILL (negative legs, burned shares, consumed basis) and FEE_CHARGED on profit', async () => {
    const b = await bag(1000);
    const inv = await newWallet(db);
    await purchase(db, { ...inv, bagId: b.bagId, sharesRaw: units(10), costBasis: '10', holdingRaw: units(10) });
    const { intentId } = await redeem(db, { ...inv, bagId: b.bagId, creatorId: b.creator.userId, sharesRaw: units(4), redeemValueQuote: '6', holdingRaw: units(4), feeBps: 1000 });

    const ev = await events(inv.userId, b.bagId);
    expect(ev.map((e) => e.kind)).toEqual(['PURCHASE_FILL', 'REDEEM_FILL', 'FEE_CHARGED']);
    const fill = ev[1];
    expect(fill.legs).toEqual([{ chain: ASSET.chain, address: ASSET.address, decimals: 18, deltaRaw: `-${units(4)}` }]);
    expect(fill.quote).toMatchObject({ sharesDeltaRaw: `-${units(4)}`, redeemValueQuote: '6' });
    expect(Number(fill.quote.costBasisDeltaQuote)).toBe(-4);
    expect(Number(fill.quote.profitQuote)).toBe(2);
    expect(ev[2]).toMatchObject({ idempotency_key: `FEE_CHARGED:${intentId}`, legs: [], quote: { amountQuote: '0.20', bps: 1000, creatorId: b.creator.userId, settledOnchain: false } });
  });

  it('no profit, no fee event', async () => {
    const b = await bag(1000);
    const inv = await newWallet(db);
    await purchase(db, { ...inv, bagId: b.bagId, sharesRaw: units(10), costBasis: '10', holdingRaw: units(10) });
    await redeem(db, { ...inv, bagId: b.bagId, creatorId: b.creator.userId, sharesRaw: units(10), redeemValueQuote: '9', holdingRaw: units(10), feeBps: 1000 });
    expect((await events(inv.userId, b.bagId)).map((e) => e.kind)).toEqual(['PURCHASE_FILL', 'REDEEM_FILL']);
  });

  it('partial redeem removes only what sold; shares and cost basis do not move', async () => {
    const b = await bag(0);
    const inv = await newWallet(db);
    await purchase(db, { ...inv, bagId: b.bagId, sharesRaw: units(10), costBasis: '10', holdingRaw: units(10) });
    const intentId = await insertRedeemIntent(db, { ...inv, bagId: b.bagId, sharesRaw: units(5), redeemValueQuote: '5' });
    await db.admin.query(`update redeem_intents set status = 'PARTIAL_SUCCESS' where id = $1`, [intentId]);
    await db.service.query('select apply_partial_redeem_execution($1, $2, $3::jsonb, $4)', [
      intentId,
      b.bagId,
      JSON.stringify([{ chain: ASSET.chain, address: ASSET.address, quantity_raw: units(3) }]),
      inv.userId,
    ]);
    const last = (await events(inv.userId, b.bagId)).at(-1)!;
    expect(last).toMatchObject({ kind: 'REDEEM_FILL', idempotency_key: `REDEEM_PARTIAL_FILL:${intentId}`, quote: { sharesDeltaRaw: '0', costBasisDeltaQuote: '0', partial: true } });
    expect(last.legs[0].deltaRaw).toBe(`-${units(3)}`);
  });

  it('router-settled redeem records the fill and the fee that was settled on-chain', async () => {
    const b = await bag(1000);
    const inv = await newWallet(db);
    await purchase(db, { ...inv, bagId: b.bagId, sharesRaw: units(3), costBasis: '33.333333', holdingRaw: units(3) });
    const intentId = await insertRedeemIntent(db, { ...inv, bagId: b.bagId, sharesRaw: units(3), redeemValueQuote: '40' });
    const tx = `0x${'ab'.repeat(32)}`;
    await db.service.query(`select apply_redeem_execution_router_settled($1, $2, $3::jsonb, $4, 18, $5, $6, $7, $8, '0.66', '660000', $9, $10)`, [
      intentId,
      b.bagId,
      JSON.stringify([{ chain: ASSET.chain, address: ASSET.address, quantity_raw: units(3) }]),
      units(3),
      inv.userId,
      '40',
      b.creator.userId,
      b.creator.wallet,
      tx,
      `0x${'cd'.repeat(32)}`,
    ]);
    const ev = await events(inv.userId, b.bagId);
    expect(ev.map((e) => e.kind)).toEqual(['PURCHASE_FILL', 'REDEEM_FILL', 'FEE_CHARGED']);
    expect(ev[1]).toMatchObject({ source: { intentKind: 'REDEEM', intentId, txHash: tx }, quote: { router: true } });
    expect(ev[2]).toMatchObject({ quote: { amountQuote: '0.66', amountTokenRaw: '660000', settledOnchain: true } });
  });
});

describe('immutability', () => {
  it('events cannot be updated, deleted or truncated, not even by service_role or the owner', async () => {
    const b = await bag();
    const inv = await newWallet(db);
    await purchase(db, { ...inv, bagId: b.bagId, sharesRaw: units(1), costBasis: '1' });
    await expect(db.service.query(`update ledger_events set kind = 'PURCHASE_FILL' where user_id = $1`, [inv.userId])).rejects.toThrow(/permission denied|LEDGER_IMMUTABLE/);
    await expect(db.service.query('delete from ledger_events where user_id = $1', [inv.userId])).rejects.toThrow(/permission denied|LEDGER_IMMUTABLE/);
    await expect(db.admin.query(`update ledger_events set kind = 'PURCHASE_FILL' where user_id = $1`, [inv.userId])).rejects.toThrow(/LEDGER_IMMUTABLE/);
    await expect(db.admin.query('delete from ledger_events where user_id = $1', [inv.userId])).rejects.toThrow(/LEDGER_IMMUTABLE/);
    await expect(db.admin.query('truncate ledger_events')).rejects.toThrow(/LEDGER_IMMUTABLE/);
  });

  it('anon and authenticated cannot read or write the ledger', async () => {
    for (const role of ['anon', 'authenticated'] as const) {
      await expect(db.asRole(role, (c) => c.query('select count(*) from ledger_events'))).rejects.toThrow(/permission denied/);
    }
  });
});

describe('rebuild check', () => {
  it('a change made outside the RPCs (no event) is reported, per scope', async () => {
    const b = await bag();
    const inv = await newWallet(db);
    await purchase(db, { ...inv, bagId: b.bagId, sharesRaw: units(2), costBasis: '2', holdingRaw: units(2) });
    await db.admin.query(`update bag_investor_holdings set quantity_raw = $3 where user_id = $1 and bag_id = $2`, [inv.userId, b.bagId, units(5)]);
    await db.admin.query(`update bag_investor_positions set cost_basis_quote = '9' where user_id = $1 and bag_id = $2`, [inv.userId, b.bagId]);
    const found = (await mismatches()).map((m) => [m.scope, m.user_id, String(m.ledger_value), String(m.stored_value)]);
    expect(found).toEqual(
      expect.arrayContaining([
        ['HOLDING', inv.userId, units(2), units(5)],
        ['COST_BASIS', inv.userId, '2', '9'],
      ])
    );
    // Put it back so the global after-check holds.
    await db.admin.query(`update bag_investor_holdings set quantity_raw = $3 where user_id = $1 and bag_id = $2`, [inv.userId, b.bagId, units(2)]);
    await db.admin.query(`update bag_investor_positions set cost_basis_quote = '2' where user_id = $1 and bag_id = $2`, [inv.userId, b.bagId]);
  });

  it('many fills and partial redemptions still rebuild exactly (divisions that do not terminate included)', async () => {
    const b = await bag(1000);
    const inv = await newWallet(db);
    await purchase(db, { ...inv, bagId: b.bagId, sharesRaw: units(3), costBasis: '10', holdingRaw: units(3) });
    await purchase(db, { ...inv, bagId: b.bagId, sharesRaw: units(7), costBasis: '13.37', holdingRaw: units(7) });
    for (const s of [1, 2, 3]) {
      await redeem(db, { ...inv, bagId: b.bagId, creatorId: b.creator.userId, sharesRaw: units(s), redeemValueQuote: String(s * 3), holdingRaw: units(s), feeBps: 1000 });
    }
    expect(await mismatches()).toEqual([]);
  });
});

describe('opening balances (state that predates the ledger)', () => {
  it('backfills stored state minus existing events, once, and is a no-op when re-run', async () => {
    const b = await bag(0);
    const legacy = await newWallet(db);
    // Legacy rows written directly, as before 0048.
    await db.admin.query(`insert into bag_investor_holdings (user_id, bag_id, chain, address, quantity_raw, decimals) values ($1, $2, $3, $4, $5, 18)`, [
      legacy.userId,
      b.bagId,
      ASSET.chain,
      ASSET.address,
      units(4),
    ]);
    await db.admin.query(`insert into bag_investor_positions (user_id, bag_id, shares_raw, share_decimals, cost_basis_quote) values ($1, $2, $3, 18, '4.5')`, [
      legacy.userId,
      b.bagId,
      units(4),
    ]);
    // A fill that landed after the function swap but before the backfill: the opening must not double count it.
    await purchase(db, { ...legacy, bagId: b.bagId, sharesRaw: units(1), costBasis: '1', holdingRaw: units(1) });

    expect((await db.service.query('select ledger_backfill_opening_balances() as n')).rows[0].n).toBe(1);
    const opening = (await events(legacy.userId, b.bagId)).find((e) => e.kind === 'OPENING_BALANCE')!;
    expect(opening).toMatchObject({ idempotency_key: `OPENING_BALANCE:${legacy.userId}:${b.bagId}`, source: { migration: '0048_ledger_events' } });
    expect(opening.legs).toEqual([{ chain: ASSET.chain, address: ASSET.address, decimals: 18, deltaRaw: units(4) }]);
    expect(opening.quote).toMatchObject({ sharesDeltaRaw: units(4), costBasisDeltaQuote: '4.5' });

    expect((await db.service.query('select ledger_backfill_opening_balances() as n')).rows[0].n).toBe(0);
  });

  it('runs on the upgrade path too: 0048 applied over an existing database leaves no mismatch', async () => {
    const up = await createTestDatabase({ mode: 'upgrade' });
    try {
      const rows = (await up.service.query('select * from ledger_projection_mismatches()')).rows;
      expect(rows).toEqual([]);
      const { rows: t } = await up.admin.query(`select to_regclass('public.ledger_events') as t`);
      expect(t[0].t).toBe('ledger_events');
    } finally {
      await up.drop();
    }
  });
});

describe('concurrency', () => {
  it('30 concurrent purchases → 30 events; 8 concurrent applies of one intent → 1 event', async () => {
    const b = await bag(0);
    const buyers = await Promise.all(Array.from({ length: 10 }, () => newWallet(db)));
    const jobs = Array.from({ length: 30 }, (_, i) => ({ who: buyers[i % 10], shares: units(i + 1) }));
    const intents = await Promise.all(jobs.map((j) => insertPurchaseIntent(db, { ...j.who, bagId: b.bagId, sharesRaw: j.shares })));
    await Promise.all(jobs.map((j, i) => purchase(db, { ...j.who, bagId: b.bagId, sharesRaw: j.shares, costBasis: String(i + 1), intentId: intents[i] })));
    const { rows } = await db.admin.query(`select count(*)::int as n from ledger_events where bag_id = $1 and kind = 'PURCHASE_FILL'`, [b.bagId]);
    expect(rows[0].n).toBe(30);

    const one = await newWallet(db);
    const intentId = await insertPurchaseIntent(db, { ...one, bagId: b.bagId, sharesRaw: units(7) });
    await Promise.allSettled(Array.from({ length: 8 }, () => purchase(db, { ...one, bagId: b.bagId, sharesRaw: units(7), costBasis: '7', intentId })));
    expect(await events(one.userId, b.bagId)).toHaveLength(1);
  });
});
