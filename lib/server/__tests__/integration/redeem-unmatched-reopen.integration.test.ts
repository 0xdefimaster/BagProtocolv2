import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listUnmatchedComposerRedeems, reopenUnmatchedComposerRedeem } from '@/lib/server/redeem-intent-repo';
import { TestDatabase, createDraftBag, createTestDatabase } from './pg-harness';
import { newWallet } from './economics-harness';

// -----------------------------------------------------------------------------
// The one way out of FAILED: a Composer sale refused only because its transaction did not match the built call
// (wallet batches, before they were recognised), with nothing booked. The guards live in the UPDATE itself, so a
// sale that reverted, had accounting applied, or is not a Composer sale is never reopened. Real PostgreSQL.
// -----------------------------------------------------------------------------

let db: TestDatabase;
let bagId: string;

beforeAll(async () => {
  db = await createTestDatabase({ mode: 'fresh' });
  const creator = await newWallet(db);
  bagId = (await createDraftBag(db, creator.userId)).bag.id;
});
afterAll(async () => {
  await db?.drop();
});

const COMPOSER_TX = JSON.stringify({ to: '0x' + '4'.repeat(40), data: '0xdeadbeef', value: '0', chainId: 4663, approvals: [] });

async function insertRedeem(userId: string, wallet: string, o: { status?: string; failureCode?: string | null; composer?: boolean; accounted?: boolean } = {}) {
  return (
    await db.admin.query(
      `insert into redeem_intents (user_id, wallet_address, bag_id, shares_raw, share_decimals, output_asset_chain, output_asset_address, output_decimals,
         route_fingerprint, share_price_at_quote, redeem_value_quote, status, failure_code, expires_at, composer_transaction, accounting_applied_at)
       values ($1, $2, $3, '0', 18, 'robinhood', '0x00000000000000000000000000000000000000c0', 6, 'fp', '0', '0', $4, $5, now() + interval '2 minutes', $6::jsonb, $7)
       returning id`,
      [userId, wallet, bagId, o.status ?? 'FAILED', o.failureCode === undefined ? 'VERIFICATION_FAILED' : o.failureCode, o.composer === false ? null : COMPOSER_TX, o.accounted ? new Date().toISOString() : null]
    )
  ).rows[0].id as string;
}

const status = async (id: string) => (await db.admin.query('select status, failure_code from redeem_intents where id = $1', [id])).rows[0];

describe('reopening an unmatched Composer sale (real PostgreSQL)', () => {
  it('reopens only FAILED + VERIFICATION_FAILED Composer sales with nothing booked, and only once', async () => {
    const { userId, wallet } = await newWallet(db);
    const ok = await insertRedeem(userId, wallet);
    const reverted = await insertRedeem(userId, wallet, { failureCode: 'TRANSACTION_REVERTED' });
    const accounted = await insertRedeem(userId, wallet, { accounted: true });
    const notComposer = await insertRedeem(userId, wallet, { composer: false });
    const open = await insertRedeem(userId, wallet, { status: 'CONFIRMING', failureCode: null });

    expect((await listUnmatchedComposerRedeems(db.client, userId, bagId, new Date(Date.now() - 60_000))).map((i) => i.id)).toEqual([ok]);

    const reopened = await reopenUnmatchedComposerRedeem(db.client, ok, []);
    expect(reopened).toMatchObject({ id: ok, status: 'CONFIRMING', failureCode: null });
    expect(await reopenUnmatchedComposerRedeem(db.client, ok, [])).toBeNull();

    for (const id of [reverted, accounted, notComposer, open]) {
      expect(await reopenUnmatchedComposerRedeem(db.client, id, [])).toBeNull();
    }
    expect(await status(reverted)).toEqual({ status: 'FAILED', failure_code: 'TRANSACTION_REVERTED' });
    expect(await status(accounted)).toEqual({ status: 'FAILED', failure_code: 'VERIFICATION_FAILED' });
    expect(await status(open)).toEqual({ status: 'CONFIRMING', failure_code: null });
  });

  it('lists only this user’s sales of this Bag since the given time', async () => {
    const a = await newWallet(db);
    const b = await newWallet(db);
    await insertRedeem(b.userId, b.wallet);
    expect(await listUnmatchedComposerRedeems(db.client, a.userId, bagId, new Date(Date.now() - 60_000))).toEqual([]);
    expect(await listUnmatchedComposerRedeems(db.client, b.userId, bagId, new Date(Date.now() + 60_000))).toEqual([]);
  });
});
