import { afterAll, beforeAll, describe, it } from 'vitest';
import { TestDatabase, createTestDatabase } from './pg-harness';

// The execution history reads existing tables only; this proves every column
// and filter it uses exists in both a fresh and an upgraded install.

let fresh: TestDatabase;
let upgraded: TestDatabase;
beforeAll(async () => {
  [fresh, upgraded] = await Promise.all([createTestDatabase({ mode: 'fresh' }), createTestDatabase({ mode: 'upgrade' })]);
});
afterAll(async () => {
  await Promise.all([fresh?.drop(), upgraded?.drop()]);
});

describe('Execution receipt column contract', () => {
  it('purchase/redeem intent, tx claim and version columns used by the receipts exist', async () => {
    for (const db of [fresh, upgraded]) {
      const statuses = ['SUBMITTED', 'CONFIRMING', 'COMPLETED', 'PARTIAL_SUCCESS', 'RECONCILIATION_REQUIRED', 'FAILED'];
      await db.admin.query(
        `select id, user_id, bag_id, wallet_address, input_asset_chain, input_asset_address, input_amount_raw, shares_raw, share_decimals,
                recipe_version, composition_hash, steps, composer_transaction, bag_router_transaction, provider_id, execution_plan_hash,
                fallback, status, created_at, executed_at
           from purchase_intents where user_id = gen_random_uuid() and bag_id = gen_random_uuid() and status = any($1) order by created_at desc limit 1`,
        [statuses]
      );
      await db.admin.query(
        `select id, user_id, bag_id, wallet_address, shares_raw, share_decimals, output_asset_chain, output_asset_address, output_decimals, steps, status, created_at, executed_at
           from redeem_intents where user_id = gen_random_uuid() and bag_id = gen_random_uuid() and status = any($1) order by created_at desc limit 1`,
        [statuses]
      );
      await db.admin.query(`select chain, tx_hash, intent_kind, intent_id from intent_tx_claims where tx_hash = any($1)`, [['0x' + 'ab'.repeat(32)]]);
      await db.admin.query(`select version, composition_hash from bag_versions where bag_id = gen_random_uuid()`);
    }
  });
});
