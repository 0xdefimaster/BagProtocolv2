import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// R3 verification end to end against a real PostgreSQL: the reported hash is settled from its receipt (the chain read
// is stubbed; the identity check itself is composer-status.ts's own tests), booked through apply_rebalance_execution,
// and an unreported intent is found or expired by the settlement pass.

const track = vi.fn();
vi.mock('@/lib/blockchain/composer-status', () => ({ trackComposerTransaction: (...a: unknown[]) => track(...a) }));

import { createDraftBag, createTestDatabase, type TestDatabase } from './pg-harness';
import { insertPurchaseIntent, newWallet } from './economics-harness';
import { settleOpenRebalances, verifyRebalanceExecution } from '@/lib/server/rebalance-execution';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase({ mode: 'fresh' });
});
afterAll(async () => {
  await db?.drop();
});
beforeEach(() => track.mockReset());

const A = '0x00000000000000000000000000000000000000a1';
const B = '0x00000000000000000000000000000000000000b2';
const TX = '0x' + 'ab'.repeat(32);
const TX2 = '0x' + 'cd'.repeat(32);
const COMPOSER = { to: '0x' + 'c0'.repeat(20), data: '0xdeadbeef', value: '0', chainId: 4663, approvals: [] };

async function holder() {
  const user = await newWallet(db);
  const { bag } = await createDraftBag(db, user.userId);
  const intentId = await insertPurchaseIntent(db, { ...user, bagId: bag.id, sharesRaw: '100' });
  await db.service.query('select apply_purchase_execution($1, $2, $3::jsonb, $4, 18, $5, $6)', [
    intentId,
    bag.id,
    JSON.stringify([{ chain: 'robinhood', address: A, decimals: 18, delta_raw: '100', cost_quote: '50' }]),
    '100',
    user.userId,
    '50',
  ]);
  return { ...user, bagId: bag.id };
}

async function intent(u: { userId: string; wallet: string; bagId: string }, opts: { status?: string; expiresIn?: string; createdAgo?: string } = {}) {
  const r = await db.admin.query(
    `insert into rebalance_intents (user_id, wallet_address, bag_id, target_version, status, sells, buys, composer_transaction, expires_at, created_at)
     values ($1, $2, $3, 2, $4, $5::jsonb, $6::jsonb, $7::jsonb, now() + $8::interval, now() - $9::interval) returning id`,
    [
      u.userId,
      u.wallet,
      u.bagId,
      opts.status ?? 'READY',
      JSON.stringify([{ chain: 'robinhood', address: A, decimals: 18, symbol: 'A', amountRaw: '40' }]),
      JSON.stringify([{ chain: 'robinhood', address: B, decimals: 18, symbol: 'B', weightBps: 10000, expectedOutRaw: '8', minOutRaw: '7' }]),
      JSON.stringify(COMPOSER),
      opts.expiresIn ?? '5 minutes',
      opts.createdAgo ?? '0 seconds',
    ]
  );
  return r.rows[0].id as string;
}

const holdings = async (userId: string, bagId: string) =>
  Object.fromEntries((await db.admin.query('select address, quantity_raw from bag_investor_holdings where user_id = $1 and bag_id = $2', [userId, bagId])).rows.map((r) => [r.address, r.quantity_raw]));
const row = async (id: string) => (await db.admin.query('select status, tx_hash, failure_code, result from rebalance_intents where id = $1', [id])).rows[0];

describe('verifyRebalanceExecution', () => {
  it('books what the receipt shows (net of unspent input returned) and settles once', async () => {
    const u = await holder();
    const id = await intent(u);
    track.mockResolvedValue({ kind: 'DONE', sentAmountsByAddress: { [A]: '40' }, receivedAmountsByAddress: { [A]: '2', [B]: '8' } });

    const r = await verifyRebalanceExecution(db.client, { userId: u.userId }, id, TX);
    expect(r.ok && r.intent.status).toBe('SUCCEEDED');
    expect(track).toHaveBeenCalledWith(expect.objectContaining({ txHash: TX, recipient: u.wallet, expectedTransaction: expect.objectContaining({ to: COMPOSER.to, data: COMPOSER.data }) }));
    expect(await holdings(u.userId, u.bagId)).toEqual({ [A]: '62', [B]: '8' });
    expect(await row(id)).toMatchObject({ status: 'SUCCEEDED', tx_hash: TX, result: { sold: [{ address: A, quantityRaw: '38' }], bought: [{ address: B, quantityRaw: '8' }] } });

    // Polling again changes nothing.
    track.mockClear();
    const again = await verifyRebalanceExecution(db.client, { userId: u.userId }, id);
    expect(again.ok && again.intent.status).toBe('SUCCEEDED');
    expect(track).not.toHaveBeenCalled();
    expect(await holdings(u.userId, u.bagId)).toEqual({ [A]: '62', [B]: '8' });
  });

  it('only the owner; a second, different hash is refused', async () => {
    const u = await holder();
    const id = await intent(u);
    track.mockResolvedValue({ kind: 'PENDING' });
    expect(await verifyRebalanceExecution(db.client, { userId: (await newWallet(db)).userId }, id, TX2)).toMatchObject({ ok: false, status: 404 });
    expect(await verifyRebalanceExecution(db.client, { userId: u.userId }, id, '0x1234')).toMatchObject({ ok: false, status: 400 });
    const pending = await verifyRebalanceExecution(db.client, { userId: u.userId }, id, '0x' + '11'.repeat(32));
    expect(pending.ok && pending.intent.status).toBe('SUBMITTED');
    expect(await verifyRebalanceExecution(db.client, { userId: u.userId }, id, '0x' + '22'.repeat(32))).toMatchObject({ ok: false, status: 409 });
  });

  it('a reverted or foreign transaction fails the intent and books nothing', async () => {
    const u = await holder();
    const id = await intent(u);
    track.mockResolvedValue({ kind: 'FAILED', failureCode: 'VERIFICATION_FAILED', message: 'not this transaction' });
    const r = await verifyRebalanceExecution(db.client, { userId: u.userId }, id, '0x' + '33'.repeat(32));
    expect(r.ok && r.intent.status).toBe('FAILED');
    expect(await holdings(u.userId, u.bagId)).toEqual({ [A]: '100' });
  });

  it('a receipt that does not match the plan (nothing bought, more sold than planned) books nothing', async () => {
    const u = await holder();
    const id = await intent(u);
    track.mockResolvedValue({ kind: 'DONE', sentAmountsByAddress: { [A]: '41' }, receivedAmountsByAddress: { [B]: '8' } });
    const r = await verifyRebalanceExecution(db.client, { userId: u.userId }, id, '0x' + '44'.repeat(32));
    expect(r.ok && r.intent).toMatchObject({ status: 'FAILED', failureCode: 'VERIFICATION_FAILED' });
    expect(await holdings(u.userId, u.bagId)).toEqual({ [A]: '100' });
  });
});

describe('settleOpenRebalances', () => {
  it('an unreported intent past expiry is found in the wallet and booked, or expired when it was never sent', async () => {
    const u = await holder();
    const sent = await intent(u, { expiresIn: '-10 minutes', createdAgo: '15 minutes' });
    const v = await holder();
    const neverSent = await intent(v, { expiresIn: '-10 minutes', createdAgo: '15 minutes' });
    const w = await holder();
    const stillSignable = await intent(w);

    const search = vi.fn(async (input: { wallet: string }) => (input.wallet === u.wallet ? { kind: 'FOUND' as const, txHash: '0x' + '55'.repeat(32) as `0x${string}` } : { kind: 'NOT_FOUND' as const }));
    track.mockResolvedValue({ kind: 'DONE', sentAmountsByAddress: { [A]: '40' }, receivedAmountsByAddress: { [B]: '8' } });

    const summary = await settleOpenRebalances(db.client, { search, limit: 100 });
    expect(await row(sent)).toMatchObject({ status: 'SUCCEEDED' });
    expect(await row(neverSent)).toMatchObject({ status: 'EXPIRED' });
    expect(await row(stillSignable)).toMatchObject({ status: 'READY' });
    expect(summary.expired).toBe(1);
    expect(summary.settled).toBeGreaterThanOrEqual(1); // also settles open intents left by earlier tests in this database
    expect(await holdings(u.userId, u.bagId)).toEqual({ [A]: '60', [B]: '8' });
  });
});
