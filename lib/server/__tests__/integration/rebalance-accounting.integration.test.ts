import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDraftBag, createTestDatabase, type TestDatabase } from './pg-harness';
import { insertPurchaseIntent, newWallet } from './economics-harness';

// -----------------------------------------------------------------------------
// R3 against a real PostgreSQL (migration 0056): apply_rebalance_execution moves
// holdings (sold legs out, bought legs in), writes one REBALANCE_FILL that keeps
// the ledger projection exact, is idempotent, refuses to sell what is not tracked,
// and wallet reconciliation waits while a rebalance is in flight.
// -----------------------------------------------------------------------------

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase({ mode: 'fresh' });
});
afterAll(async () => {
  await db?.drop();
});

const A = '0x00000000000000000000000000000000000000a1';
const B = '0x00000000000000000000000000000000000000b2';
const C = '0x00000000000000000000000000000000000000c3';
const leg = (address: string, raw: string, extra: Record<string, unknown> = {}) => ({ chain: 'robinhood', address, decimals: 18, ...extra, quantity_raw: raw });

async function holderOfA(amount: string, cost: string) {
  const user = await newWallet(db);
  const { bag } = await createDraftBag(db, user.userId);
  const intentId = await insertPurchaseIntent(db, { ...user, bagId: bag.id, sharesRaw: amount });
  await db.service.query('select apply_purchase_execution($1, $2, $3::jsonb, $4, 18, $5, $6)', [
    intentId,
    bag.id,
    JSON.stringify([{ chain: 'robinhood', address: A, decimals: 18, delta_raw: amount, cost_quote: cost }]),
    amount,
    user.userId,
    cost,
  ]);
  return { ...user, bagId: bag.id };
}

async function rebalanceIntent(o: { userId: string; wallet: string; bagId: string }, status = 'SUBMITTED', expiresIn = '1 hour') {
  const r = await db.admin.query(
    `insert into rebalance_intents (user_id, wallet_address, bag_id, target_version, status, sells, buys, composer_transaction, expires_at)
     values ($1, $2, $3, 2, $4, '[]', '[]', '{}', now() + $5::interval) returning id`,
    [o.userId, o.wallet, o.bagId, status, expiresIn]
  );
  return r.rows[0].id as string;
}

const apply = (id: string, o: { userId: string; bagId: string }, sold: unknown[], bought: unknown[]) =>
  db.service.query('select apply_rebalance_execution($1, $2, $3, $4::jsonb, $5::jsonb) as r', [id, o.userId, o.bagId, JSON.stringify(sold), JSON.stringify(bought)]);

const holdings = async (userId: string, bagId: string) =>
  Object.fromEntries(
    (await db.admin.query('select address, quantity_raw from bag_investor_holdings where user_id = $1 and bag_id = $2', [userId, bagId])).rows.map((r) => [r.address, r.quantity_raw])
  );

describe('apply_rebalance_execution', () => {
  it('moves holdings, writes one REBALANCE_FILL, keeps the ledger projection exact, and books once', async () => {
    const u = await holderOfA('100', '50');
    const id = await rebalanceIntent(u);
    const r = await apply(id, u, [leg(A, '40')], [leg(B, '7', { weight_bps: 6000 }), leg(C, '3', { weight_bps: 4000 })]);
    expect(r.rows[0].r).toEqual({ alreadyApplied: false });

    expect(await holdings(u.userId, u.bagId)).toEqual({ [A]: '60', [B]: '7', [C]: '3' });
    const bagAgg = (await db.admin.query('select address, quantity_raw from bag_holdings where bag_id = $1 order by address', [u.bagId])).rows;
    expect(bagAgg).toEqual([
      { address: A, quantity_raw: '60' },
      { address: B, quantity_raw: '7' },
      { address: C, quantity_raw: '3' },
    ]);

    const ev = (await db.admin.query("select legs, quote from ledger_events where bag_id = $1 and kind = 'REBALANCE_FILL'", [u.bagId])).rows;
    expect(ev).toHaveLength(1);
    expect(ev[0].legs).toEqual([
      { chain: 'robinhood', address: A, decimals: 18, deltaRaw: '-40' },
      { chain: 'robinhood', address: B, decimals: 18, deltaRaw: '7', weightBps: 6000 },
      { chain: 'robinhood', address: C, decimals: 18, deltaRaw: '3', weightBps: 4000 },
    ]);
    expect(ev[0].quote).toMatchObject({ sharesDeltaRaw: '0', costBasisDeltaQuote: '0', targetVersion: 2 });

    const mismatches = (await db.admin.query('select * from ledger_projection_mismatches() where bag_id = $1', [u.bagId])).rows;
    expect(mismatches).toEqual([]);
    expect((await db.admin.query('select status, accounting_applied_at from rebalance_intents where id = $1', [id])).rows[0].status).toBe('SUCCEEDED');

    // Shares and the legacy cost basis do not move.
    expect((await db.admin.query('select shares_raw, cost_basis_quote from bag_investor_positions where user_id = $1 and bag_id = $2', [u.userId, u.bagId])).rows[0]).toEqual({
      shares_raw: '100',
      cost_basis_quote: '50',
    });

    // Idempotent: a second verification books nothing.
    expect((await apply(id, u, [leg(A, '40')], [leg(B, '7', { weight_bps: 10000 })])).rows[0].r).toEqual({ alreadyApplied: true });
    expect(await holdings(u.userId, u.bagId)).toEqual({ [A]: '60', [B]: '7', [C]: '3' });
  });

  it('refuses to sell more than BAG tracks, and only a SUBMITTED intent of this user and Bag', async () => {
    const u = await holderOfA('10', '5');
    const id = await rebalanceIntent(u);
    await expect(apply(id, u, [leg(A, '11')], [leg(B, '1', { weight_bps: 10000 })])).rejects.toThrow(/INVESTOR_HOLDINGS_UNDERFLOW/);
    expect(await holdings(u.userId, u.bagId)).toEqual({ [A]: '10' }); // nothing moved

    const other = await holderOfA('10', '5');
    await expect(apply(id, other, [leg(A, '1')], [leg(B, '1', { weight_bps: 10000 })])).rejects.toThrow(/INTENT_MISMATCH/);

    const ready = await rebalanceIntent(u, 'READY');
    await expect(apply(ready, u, [leg(A, '1')], [leg(B, '1', { weight_bps: 10000 })])).rejects.toThrow(/INTENT_NOT_EXECUTABLE/);
    await expect(apply(id, u, [], [leg(B, '1', { weight_bps: 10000 })])).rejects.toThrow(/INVALID_ACCOUNTING_DELTA/);
  });

  it('wallet reconciliation waits while a rebalance is in flight', async () => {
    const u = await holderOfA('10', '5');
    await rebalanceIntent(u, 'READY', '2 minutes');
    const r = await db.service.query("select apply_wallet_observation($1, 'robinhood', $2, 100, '0') as r", [u.userId, A]);
    expect(r.rows[0].r).toMatchObject({ status: 'SKIPPED', reason: 'REBALANCE_IN_FLIGHT' });
  });

  it('is callable by service_role only', async () => {
    const anon = await db.asRole('anon', (c) =>
      c.query("select apply_rebalance_execution(gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), '[]', '[]')").then(() => 'ok', () => 'denied')
    );
    expect(anon).toBe('denied');
  });
});
