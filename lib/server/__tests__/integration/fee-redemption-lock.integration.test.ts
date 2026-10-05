import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cancelPurchaseIfFeeSaleOpen, purchaseInFlightFor } from '@/lib/server/fee-redemption-lock';
import { TestDatabase, createDraftBag, createTestDatabase } from './pg-harness';
import { newWallet } from './economics-harness';

// -----------------------------------------------------------------------------
// B0 §5.6 — the purchase / fee-sale lock under real concurrency, on real
// PostgreSQL. The protocol: each side WRITES its own intent, then READS for the
// other side's (the production code paths' own steps):
//
//   fee sale:  redeem intent inserted (create)  →  purchaseInFlightFor()          (signFeeAttestation)
//   purchase:  purchase intent inserted         →  cancelPurchaseIfFeeSaleOpen()  (createPurchaseIntentForUser)
//
// Both start in parallel, on separate connections, with random jitter between
// the write and the read, in both orders. Invariant: never both proceed.
//
// Negative control (run while writing this test, not kept): with the purchase
// side reversed to check-then-write — the first B0 version — 11 of 120 races
// let BOTH proceed. With write-then-check: 0 of 240.
// -----------------------------------------------------------------------------

let db: TestDatabase;
let bagId: string;
let creatorId: string;

beforeAll(async () => {
  db = await createTestDatabase({ mode: 'fresh' });
  const creator = await newWallet(db);
  creatorId = creator.userId;
  bagId = (await createDraftBag(db, creatorId)).bag.id;
});
afterAll(async () => {
  await db?.drop();
});

const jitter = () => new Promise((r) => setTimeout(r, Math.floor(Math.random() * 4)));
const feeBag = () => ({ id: bagId, creatorId, performanceFeeBpsLocked: 150 });

async function insertOpenRedeem(userId: string, wallet: string) {
  return (
    await db.admin.query(
      `insert into redeem_intents (user_id, wallet_address, bag_id, shares_raw, share_decimals, output_asset_chain, output_asset_address, output_decimals,
         route_fingerprint, share_price_at_quote, redeem_value_quote, status, expires_at)
       values ($1, $2, $3, '0', 18, 'robinhood', '0x00000000000000000000000000000000000000c0', 6, 'fp', '0', '0', 'READY', now() + interval '3 minutes')
       returning id`,
      [userId, wallet, bagId]
    )
  ).rows[0].id as string;
}

async function insertOpenPurchase(userId: string, wallet: string) {
  return (
    await db.admin.query(
      `insert into purchase_intents (user_id, wallet_address, bag_id, input_asset_chain, input_asset_address, input_amount_raw, shares_raw,
         route_fingerprint, recipe_version, composition_hash, nav_gross, nav_quote_currency, nav_as_of, steps, status, expires_at)
       values ($1, $2, $3, 'robinhood', '0x00000000000000000000000000000000000000c0', '1', '1', 'fp', 1, 'h', '0', 'USD', now(), '[]'::jsonb, 'READY', now() + interval '3 minutes')
       returning id`,
      [userId, wallet, bagId]
    )
  ).rows[0].id as string;
}

/** The fee sale's two steps. Proceeds = its fee would be attested. */
async function feeSale(userId: string, wallet: string, delayFirst: boolean) {
  if (delayFirst) await jitter();
  await insertOpenRedeem(userId, wallet);
  await jitter();
  return (await purchaseInFlightFor(db.client, userId, bagId)) === null;
}

/** The purchase's two steps. Proceeds = it was not cancelled. */
async function purchase(userId: string, wallet: string, delayFirst: boolean) {
  if (delayFirst) await jitter();
  const id = await insertOpenPurchase(userId, wallet);
  await jitter();
  const blocked = await cancelPurchaseIfFeeSaleOpen(db.client, { id, userId, status: 'READY' }, feeBag(), null);
  return { proceeds: blocked === null, id };
}

describe('B0 purchase / fee-sale lock under concurrency (real PostgreSQL)', () => {
  it.each([
    ['fee sale starts first', true],
    ['purchase starts first', false],
  ])('%s: over many parallel races, never do both proceed; a refused purchase is cancelled', async (_label, purchaseDelayed) => {
    const outcomes = { saleOnly: 0, purchaseOnly: 0, neither: 0 };
    for (let i = 0; i < 120; i++) {
      const { userId, wallet } = await newWallet(db);
      const [saleProceeds, p] = await Promise.all([feeSale(userId, wallet, !purchaseDelayed), purchase(userId, wallet, purchaseDelayed)]);
      expect(saleProceeds && p.proceeds).toBe(false);
      if (!p.proceeds) {
        const status = (await db.admin.query('select status from purchase_intents where id = $1', [p.id])).rows[0].status;
        expect(status).toBe('CANCELLED');
      }
      if (saleProceeds) outcomes.saleOnly++;
      else if (p.proceeds) outcomes.purchaseOnly++;
      else outcomes.neither++;
    }
    // Both refusing at once is allowed (fail-safe); both proceeding never is.
    expect(outcomes.saleOnly + outcomes.purchaseOnly + outcomes.neither).toBe(120);
  });

  it('sequential, sale first: the purchase is refused and cancelled before it can be signed', async () => {
    const { userId, wallet } = await newWallet(db);
    expect(await feeSale(userId, wallet, false)).toBe(true);
    const p = await purchase(userId, wallet, false);
    expect(p.proceeds).toBe(false);
    expect((await db.admin.query('select status from purchase_intents where id = $1', [p.id])).rows[0].status).toBe('CANCELLED');
  });

  it('sequential, purchase first: the fee is not attested', async () => {
    const { userId, wallet } = await newWallet(db);
    expect((await purchase(userId, wallet, false)).proceeds).toBe(true);
    expect(await feeSale(userId, wallet, false)).toBe(false);
  });

  it('the lock covers only fee-paying sales: a fee-free sale never cancels a purchase', async () => {
    const { userId, wallet } = await newWallet(db);
    await insertOpenRedeem(userId, wallet);
    const id = await insertOpenPurchase(userId, wallet);
    expect(await cancelPurchaseIfFeeSaleOpen(db.client, { id, userId, status: 'READY' }, { ...feeBag(), performanceFeeBpsLocked: 0 }, null)).toBeNull();
    expect(await cancelPurchaseIfFeeSaleOpen(db.client, { id, userId: creatorId, status: 'READY' }, feeBag(), null)).toBeNull();
  });

  it('the lock lives until the sale is done: an open sale intent keeps blocking; a completed or expired-unsubmitted one does not', async () => {
    const { userId, wallet } = await newWallet(db);
    const redeemId = await insertOpenRedeem(userId, wallet);
    const p1 = await insertOpenPurchase(userId, wallet);
    expect(await cancelPurchaseIfFeeSaleOpen(db.client, { id: p1, userId, status: 'READY' }, feeBag(), null)).toEqual({ id: redeemId });
    // Submitted on-chain but past the quote's expiry: still in flight, still blocks.
    await db.admin.query(`update redeem_intents set status = 'CONFIRMING', expires_at = now() - interval '1 minute' where id = $1`, [redeemId]);
    const p2 = await insertOpenPurchase(userId, wallet);
    expect(await cancelPurchaseIfFeeSaleOpen(db.client, { id: p2, userId, status: 'READY' }, feeBag(), null)).toEqual({ id: redeemId });
    // Completed: released.
    await db.admin.query(`update redeem_intents set status = 'COMPLETED' where id = $1`, [redeemId]);
    const p3 = await insertOpenPurchase(userId, wallet);
    expect(await cancelPurchaseIfFeeSaleOpen(db.client, { id: p3, userId, status: 'READY' }, feeBag(), null)).toBeNull();
  });
});
