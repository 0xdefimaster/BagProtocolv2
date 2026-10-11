import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBag } from '@/lib/server/bag-repo';
import { loadProtocolProof } from '@/lib/server/protocol-proof';
import { TestDatabase, createTestDatabase, validRecipeInput } from './pg-harness';
import { insertPurchaseIntent, insertRedeemIntent, newWallet } from './economics-harness';

// The public proof figures against the production schema: executions by outcome from intents with a
// submitted transaction, fees from a settled sale's recorded Settled event, vault credits from confirmed
// settlements, and nothing that names a wallet.

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase({ mode: 'fresh' });
});
afterAll(async () => {
  await db?.drop();
});

const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const step = (txHash: string | null, status = 'COMPLETED') => ({ action: 'SWAP', status, sourceChain: 'robinhood', approvalTxHash: null, txHash });

describe('Protocol proof (real PostgreSQL)', () => {
  it('counts executions, fees and credits; links transactions; never names a wallet', async () => {
    const creator = await newWallet(db);
    const r = await createBag(db.client, { slug: `proof-${Date.now()}`, creatorId: creator.userId, mutability: 'MUTABLE', recipe: validRecipeInput({ performanceFeeBps: 1000 }), reason: 't' });
    if (!r.ok) throw new Error(JSON.stringify(r));
    const bagId = r.bag.id;
    await db.admin.query(`update bags set status = 'ACTIVE' where id = $1`, [bagId]);
    const u = await newWallet(db);

    // Two purchases with a transaction (one succeeded, one failed), one without (not an execution).
    const ok = await insertPurchaseIntent(db, { ...u, bagId, sharesRaw: '1', status: 'COMPLETED' });
    const failed = await insertPurchaseIntent(db, { ...u, bagId, sharesRaw: '1', status: 'FAILED' });
    const unsent = await insertPurchaseIntent(db, { ...u, bagId, sharesRaw: '1', status: 'FAILED' });
    await db.admin.query(`update purchase_intents set steps = $2::jsonb, executed_at = now() where id = $1`, [ok, JSON.stringify([step(hash(1))])]);
    await db.admin.query(`update purchase_intents set steps = $2::jsonb where id = $1`, [failed, JSON.stringify([step(hash(2), 'FAILED')])]);
    await db.admin.query(`update purchase_intents set steps = $2::jsonb where id = $1`, [unsent, JSON.stringify([step(null, 'PENDING')])]);

    // A settled sale: 10 USDG received on a 8 USDG basis, 0.2 USDG fee to the creator.
    const sold = await insertRedeemIntent(db, { ...u, bagId, sharesRaw: '1', redeemValueQuote: '10' });
    const plan = { schema: 1, settlement: '0x' + '11'.repeat(20), consumedBasisRaw: '8000000', feeRateBps: 1000, result: { txHash: hash(3), blockNumber: '1', logIndex: '0', received: '10000000', feeBase: '2000000', fee: '200000', userProceeds: '9800000', creator: creator.wallet, executor: '0x' + '22'.repeat(20) } };
    await db.admin.query(`update redeem_intents set output_asset_address = $2, steps = $3::jsonb, settlement_plan = $4::jsonb, executed_at = now() where id = $1`, [sold, USDG, JSON.stringify([step(hash(3))]), JSON.stringify(plan)]);

    // A vault credit confirmed on-chain, and one not yet settled (not counted).
    const legacy = await insertRedeemIntent(db, { ...u, bagId, sharesRaw: '1', redeemValueQuote: '1' });
    const legacy2 = await insertRedeemIntent(db, { ...u, bagId, sharesRaw: '1', redeemValueQuote: '1' });
    const ins = `insert into creator_reward_settlements (creator_id, creator_wallet, bag_id, reward_type, source_redeem_intent_id, gross_amount_quote, reward_amount_token_raw, reward_token_address, reward_token_decimals, reward_chain_id, status, onchain_tx_hash, settled_at)
       values ($1, $2, $3, 'PERFORMANCE_FEE', $4, '0.5', $5, $6, 6, 4663, $7, $8, now())`;
    await db.admin.query(ins, [creator.userId, creator.wallet, bagId, legacy, '500000', USDG, 'CONFIRMED', hash(4)]);
    await db.admin.query(ins, [creator.userId, creator.wallet, bagId, legacy2, '700000', USDG, 'SUBMITTED', hash(5)]);

    const proof = await loadProtocolProof(db.client);

    // The two redeem intents inserted as COMPLETED without a transaction are not executions.
    expect(proof.executions.purchases).toEqual({ succeeded: 1, partial: 0, failed: 1, pending: 0 });
    expect(proof.executions.redeems).toEqual({ succeeded: 1, partial: 0, failed: 0, pending: 0 });
    expect(proof.executions.successRateBps).toBe(6666);

    expect(proof.money).toHaveLength(1);
    expect(proof.money[0]).toMatchObject({
      token: USDG.toLowerCase(),
      symbol: 'USDG',
      performanceFeesPaidRaw: '200000',
      vaultCreditsRaw: { FORK_ROYALTY: '0', PERFORMANCE_FEE: '500000' },
      exits: { count: 1, grossProceedsRaw: '10000000', costBasisRaw: '8000000', feesRaw: '200000', netRealizedPnlRaw: '1800000' },
    });

    const txs = proof.recent.map((e) => e.tx.txHash);
    expect(txs).toEqual(expect.arrayContaining([hash(1), hash(2), hash(3), hash(4)]));
    expect(txs).not.toContain(hash(5));
    const fee = proof.recent.find((e) => e.type === 'FEE_PAID')!;
    expect(fee.bagName).toBe(r.bag.name);
    expect(fee.tx.url).toMatch(new RegExp(`/tx/${hash(3)}$`));
    expect(proof.truncated).toEqual([]);

    const body = JSON.stringify(proof).toLowerCase();
    expect(body).not.toContain(u.wallet.toLowerCase());
    expect(body).not.toContain(creator.wallet.toLowerCase());
  });
});
