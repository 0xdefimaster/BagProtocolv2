import crypto from 'node:crypto';
import { TestDatabase } from './pg-harness';

// -----------------------------------------------------------------------------
// Drives the REAL accounting RPCs (apply_purchase_execution /
// apply_redeem_execution) against a real PostgreSQL, with real intent rows so
// the RPCs' own idempotency guards (`accounting_applied_at`) are exercised.
// Only the numbers are chosen by the test — every balance, share, cost-basis
// and fee movement is computed by the production SQL.
// -----------------------------------------------------------------------------

export const ASSET = { chain: 'robinhood', address: '0x00000000000000000000000000000000000000a1', decimals: 18 };

export async function newWallet(db: TestDatabase): Promise<{ userId: string; wallet: string }> {
  const wallet = `0x${crypto.randomBytes(20).toString('hex')}`;
  const userId = (await db.admin.query('insert into users (wallet_address) values ($1) returning id', [wallet])).rows[0].id as string;
  await db.admin.query('insert into portfolios (user_id, cash_balance) values ($1, 0) on conflict do nothing', [userId]);
  return { userId, wallet };
}

export async function insertPurchaseIntent(db: TestDatabase, o: { userId: string; wallet: string; bagId: string; sharesRaw: string; status?: string }) {
  const r = await db.admin.query(
    `insert into purchase_intents (user_id, wallet_address, bag_id, input_asset_chain, input_asset_address, input_amount_raw, shares_raw,
       route_fingerprint, recipe_version, composition_hash, nav_gross, nav_quote_currency, nav_as_of, steps, status, expires_at)
     values ($1, $2, $3, 'robinhood', '0x00000000000000000000000000000000000000c0', '1', $4, 'fp', 1, 'h', '0', 'USD', now(), '[]'::jsonb, $5, now() + interval '1 hour')
     returning id`,
    [o.userId, o.wallet, o.bagId, o.sharesRaw, o.status ?? 'COMPLETED']
  );
  return r.rows[0].id as string;
}

export async function insertRedeemIntent(db: TestDatabase, o: { userId: string; wallet: string; bagId: string; sharesRaw: string; redeemValueQuote: string }) {
  const r = await db.admin.query(
    `insert into redeem_intents (user_id, wallet_address, bag_id, shares_raw, share_decimals, output_asset_chain, output_asset_address, output_decimals,
       route_fingerprint, share_price_at_quote, redeem_value_quote, status, expires_at)
     values ($1, $2, $3, $4, 18, 'robinhood', '0x00000000000000000000000000000000000000c0', 6, 'fp', '0', $5, 'COMPLETED', now() + interval '1 hour')
     returning id`,
    [o.userId, o.wallet, o.bagId, o.sharesRaw, o.redeemValueQuote]
  );
  return r.rows[0].id as string;
}

/** A completed purchase: `sharesRaw` minted, `costBasis` (quote currency) added, `holdingRaw` of ASSET added. Returns the RPC result. */
export async function purchase(
  db: TestDatabase,
  o: { userId: string; wallet: string; bagId: string; sharesRaw: string; costBasis: string; holdingRaw?: string; intentId?: string }
) {
  const intentId = o.intentId ?? (await insertPurchaseIntent(db, o));
  const r = await db.service.query('select apply_purchase_execution($1, $2, $3::jsonb, $4, 18, $5, $6) as r', [
    intentId,
    o.bagId,
    JSON.stringify([{ ...ASSET, delta_raw: o.holdingRaw ?? o.sharesRaw }]),
    o.sharesRaw,
    o.userId,
    o.costBasis,
  ]);
  return { intentId, result: r.rows[0].r };
}

/** A completed redemption through the REAL apply_redeem_execution. `feeBps` is what the application would pass (the RPC may override it with the locked rate). */
export async function redeem(
  db: TestDatabase,
  o: { userId: string; wallet: string; bagId: string; creatorId: string; sharesRaw: string; redeemValueQuote: string; holdingRaw?: string; feeBps: number; intentId?: string }
) {
  const intentId = o.intentId ?? (await insertRedeemIntent(db, o));
  const r = await db.service.query('select apply_redeem_execution($1, $2, $3::jsonb, $4, 18, $5, $6, $7, $8) as r', [
    intentId,
    o.bagId,
    JSON.stringify([{ chain: ASSET.chain, address: ASSET.address, quantity_raw: o.holdingRaw ?? o.sharesRaw }]),
    o.sharesRaw,
    o.userId,
    o.redeemValueQuote,
    o.feeBps,
    o.creatorId,
  ]);
  return { intentId, result: r.rows[0].r };
}

export async function position(db: TestDatabase, userId: string, bagId: string) {
  return (await db.admin.query('select shares_raw, cost_basis_quote from bag_investor_positions where user_id = $1 and bag_id = $2', [userId, bagId])).rows[0] as
    | { shares_raw: string; cost_basis_quote: string }
    | undefined;
}

export async function totalShares(db: TestDatabase, bagId: string): Promise<string> {
  return (await db.admin.query('select total_shares_raw from bag_share_state where bag_id = $1', [bagId])).rows[0]?.total_shares_raw ?? '0';
}

export async function sumPositionShares(db: TestDatabase, bagId: string): Promise<string> {
  return (await db.admin.query('select coalesce(sum(shares_raw::numeric), 0)::text as s from bag_investor_positions where bag_id = $1', [bagId])).rows[0].s;
}

export async function feeSettlements(db: TestDatabase, bagId: string) {
  return (
    await db.admin.query(`select gross_amount_quote, source_redeem_intent_id from creator_reward_settlements where bag_id = $1 and reward_type = 'PERFORMANCE_FEE' order by created_at`, [
      bagId,
    ])
  ).rows as { gross_amount_quote: string; source_redeem_intent_id: string }[];
}

export async function feeLock(db: TestDatabase, bagId: string) {
  return (await db.admin.query('select performance_fee_locked_at, performance_fee_bps_locked from bags where id = $1', [bagId])).rows[0] as {
    performance_fee_locked_at: Date | null;
    performance_fee_bps_locked: number | null;
  };
}
