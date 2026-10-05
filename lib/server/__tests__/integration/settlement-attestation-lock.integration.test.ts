import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cancelPurchaseIfFeeSaleOpen, liveSettlementAttestationFor } from '@/lib/server/fee-redemption-lock';
import { listLiveSettlementAttestations, listOpenRedeemIntentsForBag } from '@/lib/server/redeem-intent-repo';
import { TestDatabase, createDraftBag, createTestDatabase } from './pg-harness';
import { newWallet } from './economics-harness';

// -----------------------------------------------------------------------------
// §9 — a settlement attestation cannot be revoked. Once phase 2 has handed one out, it stays valid on-chain until
// its signed deadline, whatever happens to its intent in the database (a reverted transaction marks it FAILED, the
// signature still works). The contract does not know whether the attested context is still current, so the position
// must not change while such an attestation is live: no new sale (createRedeemIntentForUser,
// liveSettlementAttestationFor) and no purchase (openFeeRedemptionFor / cancelPurchaseIfFeeSaleOpen). Real PostgreSQL.
// -----------------------------------------------------------------------------

let db: TestDatabase;
let bagId: string;
let creatorId: string;

beforeAll(async () => {
  db = await createTestDatabase({ mode: 'fresh' });
  creatorId = (await newWallet(db)).userId;
  bagId = (await createDraftBag(db, creatorId)).bag.id;
});
afterAll(async () => {
  await db?.drop();
});

const feeBag = () => ({ id: bagId, creatorId, performanceFeeBpsLocked: 150 });
const nowSec = () => Math.floor(Date.now() / 1000);

async function insertRedeem(userId: string, wallet: string, status: string, deadline: number | null) {
  const plan = deadline === null ? null : JSON.stringify({ schema: 1, contextHash: '0x' + 'ab'.repeat(32), deadline });
  return (
    await db.admin.query(
      `insert into redeem_intents (user_id, wallet_address, bag_id, shares_raw, share_decimals, output_asset_chain, output_asset_address, output_decimals,
         route_fingerprint, share_price_at_quote, redeem_value_quote, status, expires_at, settlement_plan)
       values ($1, $2, $3, '0', 18, 'robinhood', '0x00000000000000000000000000000000000000c0', 6, 'fp', '0', '0', $4, now() + interval '3 minutes', $5::jsonb)
       returning id`,
      [userId, wallet, bagId, status, plan]
    )
  ).rows[0].id as string;
}

async function insertPurchase(userId: string, wallet: string) {
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

describe('§9 a live settlement attestation locks the position (real PostgreSQL)', () => {
  it('a FAILED intent whose attestation is still valid on-chain blocks a new sale and a purchase; once its deadline passes, it no longer does', async () => {
    const { userId, wallet } = await newWallet(db);
    // A: attested, then its transaction reverted → FAILED in the database. Its signature is valid for 2 more minutes.
    const a = await insertRedeem(userId, wallet, 'FAILED', nowSec() + 120);

    // Not an open intent any more — the old check alone would let a new sale start:
    expect(await listOpenRedeemIntentsForBag(db.client, userId, bagId)).toHaveLength(0);
    // …but it holds a live attestation, so a new sale is refused (createRedeemIntentForUser's check)…
    expect(await liveSettlementAttestationFor(db.client, userId, bagId)).toEqual({ id: a });
    // …and so is a purchase (which would change the basis the attestation was signed with): cancelled.
    const p = await insertPurchase(userId, wallet);
    expect(await cancelPurchaseIfFeeSaleOpen(db.client, { id: p, userId, status: 'READY' }, feeBag(), null)).toEqual({ id: a });
    expect((await db.admin.query('select status from purchase_intents where id = $1', [p])).rows[0].status).toBe('CANCELLED');

    // A's deadline passes: its signature is dead on-chain; the position is free again.
    await db.admin.query(`update redeem_intents set settlement_plan = jsonb_set(settlement_plan, '{deadline}', to_jsonb($2::bigint)) where id = $1`, [a, nowSec() - 1]);
    expect(await liveSettlementAttestationFor(db.client, userId, bagId)).toBeNull();
    const p2 = await insertPurchase(userId, wallet);
    expect(await cancelPurchaseIfFeeSaleOpen(db.client, { id: p2, userId, status: 'READY' }, feeBag(), null)).toBeNull();
  });

  it('only attestations of this user and this position count; a plan that was quoted but never attested (no deadline) does not', async () => {
    const owner = await newWallet(db);
    const other = await newWallet(db);
    await insertRedeem(other.userId, other.wallet, 'FAILED', nowSec() + 120);
    await insertRedeem(owner.userId, owner.wallet, 'EXPIRED', null);
    expect(await listLiveSettlementAttestations(db.client, owner.userId, bagId)).toHaveLength(0);
    expect(await liveSettlementAttestationFor(db.client, owner.userId, bagId)).toBeNull();
    expect(await liveSettlementAttestationFor(db.client, other.userId, bagId)).not.toBeNull();
  });
});
