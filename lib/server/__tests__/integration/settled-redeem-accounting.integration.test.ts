import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createBag } from '@/lib/server/bag-repo';
import { recordRedeemSettlementResult } from '@/lib/server/redeem-intent-repo';
import { computePositionPnl, PnlEvent } from '@/lib/domain/basket-protocol/accounting/position-pnl';
import type { RedeemSettlementPlan } from '@/types/redeem-intent';
import { TestDatabase, createTestDatabase, validRecipeInput } from './pg-harness';
import { ASSET, insertPurchaseIntent, insertRedeemIntent, newWallet } from './economics-harness';

// -----------------------------------------------------------------------------
// §9 / 0054 — a fee-paying sale settled through RedeemSettlement paid its fee on-chain, straight to the creator.
// The real apply_redeem_execution must then book NO database fee (no PERFORMANCE_FEE_EARNED activity, no EARNED
// creator_reward_settlements row: either would pay the creator twice), ledger the Settled event's fee as
// FEE_CHARGED { settledOnchain: true }, and refuse to run without that event result. Control: the same sale without
// an attested plan books the database fee as before. Real PostgreSQL.
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

type User = { userId: string; wallet: string };
let n = 0;
const CONTEXT = `0x${'ab'.repeat(32)}`;

/** A Bag with a 20% fee, locked by an external investor who bought 100 units for 10 (quote). */
async function setup() {
  const creator = await newWallet(db);
  const r = await createBag(db.client, { slug: `settled-${Date.now()}-${n++}`, creatorId: creator.userId, mutability: 'MUTABLE', recipe: validRecipeInput({ performanceFeeBps: 2000 }), reason: 't' });
  if (!r.ok) throw new Error(JSON.stringify(r));
  const investor = await newWallet(db);
  const p = await insertPurchaseIntent(db, { ...investor, bagId: r.bag.id, sharesRaw: '100' });
  await db.service.query('select apply_purchase_execution($1, $2, $3::jsonb, $4, 18, $5, $6)', [
    p,
    r.bag.id,
    JSON.stringify([{ ...ASSET, delta_raw: '100', cost_quote: '10' }]),
    '100',
    investor.userId,
    '10',
  ]);
  return { creatorId: creator.userId, bagId: r.bag.id, investor };
}

const plan = (over: Partial<RedeemSettlementPlan> = {}) =>
  ({ schema: 1, contextHash: CONTEXT, feeRateBps: 2000, attestedAt: new Date().toISOString(), deadline: Math.floor(Date.now() / 1000) + 300, ...over }) as unknown as RedeemSettlementPlan;

/** Sells all 100 units for 15 (gross, quote): a gain of 5 → a 20% fee of 1. */
async function sell(b: { bagId: string; creatorId: string; investor: User }, settlementPlan: RedeemSettlementPlan | null) {
  const id = await insertRedeemIntent(db, { ...b.investor, bagId: b.bagId, sharesRaw: '100', redeemValueQuote: '15' });
  if (settlementPlan) await db.admin.query('update redeem_intents set settlement_plan = $2::jsonb where id = $1', [id, JSON.stringify(settlementPlan)]);
  const apply = () =>
    db.service.query('select apply_redeem_execution($1, $2, $3::jsonb, $4, 18, $5, $6, 2000, $7) as r', [
      id,
      b.bagId,
      JSON.stringify([{ chain: ASSET.chain, address: ASSET.address, quantity_raw: '100', proceeds_quote: '15' }]),
      '100',
      b.investor.userId,
      '15',
      b.creatorId,
    ]);
  return { id, apply };
}

const dbFees = async (bagId: string) =>
  (await db.admin.query(`select gross_amount_quote from creator_reward_settlements where bag_id = $1 and reward_type = 'PERFORMANCE_FEE'`, [bagId])).rows;
const feeActivities = async (creatorId: string) =>
  (await db.admin.query(`select action from activities where user_id = $1 and action like 'PERFORMANCE_FEE_EARNED:%'`, [creatorId])).rows;
const events = async (u: User, bagId: string) =>
  (await db.admin.query('select seq::text as seq, kind, legs, quote from ledger_events where user_id = $1 and bag_id = $2 order by seq', [u.userId, bagId])).rows as PnlEvent[];

describe('0054 — accounting a sale settled on-chain (real PostgreSQL)', () => {
  it('control: without an attested plan, the database fee is booked (activity + EARNED row + FEE_CHARGED settledOnchain=false)', async () => {
    const b = await setup();
    const s = await sell(b, null);
    await s.apply();
    expect(await dbFees(b.bagId)).toEqual([{ gross_amount_quote: '1.00' }]);
    expect(await feeActivities(b.creatorId)).toHaveLength(1);
    const fee = (await events(b.investor, b.bagId)).find((e) => e.kind === 'FEE_CHARGED');
    expect(fee?.quote).toMatchObject({ amountQuote: '1.00', settledOnchain: false });
  });

  it('settled on-chain: no database fee at all; the ledger carries the Settled event fee; realized P&L on gross proceeds, fee separate', async () => {
    const b = await setup();
    const s = await sell(b, plan());
    // Verification records the Settled event before accounting: 15 USDG arrived, fee base 5, fee 1, user got 14.
    await recordRedeemSettlementResult(db.client, s.id, plan({
      result: { txHash: `0x${'cd'.repeat(32)}`, blockNumber: '7', logIndex: '3', received: '15000000', feeBase: '5000000', fee: '1000000', userProceeds: '14000000', creator: '0x01', executor: '0x02' },
    }));
    await s.apply();

    expect(await dbFees(b.bagId)).toEqual([]);
    expect(await feeActivities(b.creatorId)).toEqual([]);
    const ev = await events(b.investor, b.bagId);
    const fee = ev.find((e) => e.kind === 'FEE_CHARGED');
    expect(fee?.quote).toMatchObject({ amountQuote: '1.000000', baseQuote: '5.000000', bps: 2000, settledOnchain: true, feeRaw: '1000000', txHash: `0x${'cd'.repeat(32)}` });
    const pnl = computePositionPnl(ev);
    // Locked semantics (§10): realized P&L is BEFORE fees (gross 15 − basis 10 = 5, the fee base); the fee is
    // separate (1); what the user actually realized is 5 − 1 = 4 = net proceeds 14 − basis 10.
    expect(pnl.realizedPnlQuote).toBe('5');
    expect(pnl.feesChargedQuote).toBe('1');
    expect(pnl.netRealizedPnlQuote).toBe('4');
    expect(pnl.realizedHighWaterMarkQuote).toBe('5');
    // Applying again books nothing more.
    const again = (await s.apply()).rows[0].r;
    expect(again.alreadyApplied).toBe(true);
    expect((await events(b.investor, b.bagId)).filter((e) => e.kind === 'FEE_CHARGED')).toHaveLength(1);
  });

  it('settled on-chain but no Settled event result recorded: nothing is applied', async () => {
    const b = await setup();
    const s = await sell(b, plan());
    await expect(s.apply()).rejects.toThrow(/SETTLEMENT_RESULT_MISSING/);
    expect((await events(b.investor, b.bagId)).some((e) => e.kind === 'REDEEM_FILL')).toBe(false);
    expect(await dbFees(b.bagId)).toEqual([]);
  });

  it('recordRedeemSettlementResult writes only onto the plan it was read for (same context hash)', async () => {
    const b = await setup();
    const s = await sell(b, plan());
    await recordRedeemSettlementResult(db.client, s.id, plan({ contextHash: `0x${'ee'.repeat(32)}`, result: { fee: '1' } as never }));
    const row = (await db.admin.query('select settlement_plan from redeem_intents where id = $1', [s.id])).rows[0].settlement_plan;
    expect(row.contextHash).toBe(CONTEXT);
    expect(row.result).toBeUndefined();
  });
});
