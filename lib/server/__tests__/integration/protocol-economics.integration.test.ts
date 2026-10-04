import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createBag } from '@/lib/server/bag-repo';
import { getDepositQuote, getRedeemQuote, OrphanedNavError, ZeroNavError } from '@/lib/domain/basket-protocol/shares/shares';
import { NAV_VALUE_DECIMALS } from '@/lib/domain/basket-protocol/nav/nav';
import type { NavResult, ShareSupply } from '@/types/basket-protocol';
import { TestDatabase, createTestDatabase, validRecipeInput } from './pg-harness';
import {
  ASSET,
  feeSettlements,
  insertPurchaseIntent,
  insertRedeemIntent,
  newWallet,
  position,
  purchase,
  redeem,
  sumPositionShares,
  totalShares,
} from './economics-harness';

// -----------------------------------------------------------------------------
// SHARE / NAV / COST-BASIS ECONOMIC INVARIANTS (docs/PROTOCOL_ECONOMICS.md §3),
// against a real PostgreSQL and the production accounting RPCs. The quote side
// (how many shares a deposit buys, what a redemption is worth) is the real
// pure TS (`getDepositQuote` / `getRedeemQuote`); the settlement side (mint,
// burn, cost basis, fee) is the real SQL. After EVERY test the global
// invariants are re-checked for every Bag the test touched.
// -----------------------------------------------------------------------------

let db: TestDatabase;
const touched = new Set<string>();
beforeAll(async () => {
  db = await createTestDatabase({ mode: 'fresh' });
});
afterAll(async () => {
  await db?.drop();
});
afterEach(async () => {
  // I1/I2 — Σ positions == total supply, and nothing is ever negative.
  for (const bagId of touched) {
    expect(await sumPositionShares(db, bagId)).toBe(String(BigInt(await totalShares(db, bagId))));
    const neg = (
      await db.admin.query(
        `select (select count(*) from bag_investor_positions where bag_id = $1 and (shares_raw::numeric < 0 or cost_basis_quote::numeric < 0))
              + (select count(*) from bag_holdings where bag_id = $1 and quantity_raw::numeric < 0)
              + (select count(*) from bag_investor_holdings where bag_id = $1 and quantity_raw::numeric < 0)
              + (select count(*) from bag_share_state where bag_id = $1 and total_shares_raw::numeric < 0) as n`,
        [bagId]
      )
    ).rows[0].n;
    expect(Number(neg)).toBe(0);
    // I4 (0048) — the investor tables can be rebuilt exactly from ledger events.
    expect((await db.service.query('select * from ledger_projection_mismatches() where bag_id = $1', [bagId])).rows).toEqual([]);
    // I3 — a zero-share position carries no cost basis.
    const residual = (await db.admin.query(`select count(*)::int as n from bag_investor_positions where bag_id = $1 and shares_raw::numeric = 0 and cost_basis_quote::numeric <> 0`, [bagId])).rows[0].n;
    expect(residual).toBe(0);
  }
  touched.clear();
});

const E18 = BigInt(10) ** BigInt(18);
const SCALE = BigInt(10) ** BigInt(NAV_VALUE_DECIMALS);
const nav = (grossNav: string): NavResult => ({ grossNav, quoteCurrency: 'USD', asOf: new Date().toISOString(), holdings: [] }) as unknown as NavResult;
const supply = (raw: string): ShareSupply => ({ bagId: 'b', totalSharesRaw: raw, shareDecimals: 18, updatedAt: new Date().toISOString() });
let n = 0;

async function bag(feeBps = 1000) {
  const creator = await newWallet(db);
  const r = await createBag(db.client, { slug: `econ-${Date.now()}-${n++}`, creatorId: creator.userId, mutability: 'MUTABLE', recipe: validRecipeInput({ performanceFeeBps: feeBps }), reason: 't' });
  if (!r.ok) throw new Error(JSON.stringify(r));
  touched.add(r.bag.id);
  return { creator, bagId: r.bag.id };
}

/** Deposit `amount` at the Bag's CURRENT NAV (`navUsd`), quoting shares with the real getDepositQuote. */
async function deposit(b: { bagId: string }, who: { userId: string; wallet: string }, amount: string, navUsd: string) {
  const q = getDepositQuote(nav(navUsd), supply(await totalShares(db, b.bagId)), amount);
  await purchase(db, { ...who, bagId: b.bagId, sharesRaw: q.sharesRaw, costBasis: amount });
  return q;
}

/** Redeem `sharesRaw` at NAV `navUsd`, valuing it with the real getRedeemQuote; holdings sold pro rata. */
async function withdraw(b: { bagId: string; creator: { userId: string } }, who: { userId: string; wallet: string }, sharesRaw: string, navUsd: string, feeBps = 1000) {
  const total = await totalShares(db, b.bagId);
  const q = getRedeemQuote(nav(navUsd), supply(total), sharesRaw);
  const holding = (await db.admin.query('select quantity_raw from bag_investor_holdings where user_id = $1 and bag_id = $2', [who.userId, b.bagId])).rows[0].quantity_raw as string;
  const pos = await position(db, who.userId, b.bagId);
  const holdingSold = ((BigInt(holding) * BigInt(sharesRaw)) / BigInt(pos!.shares_raw)).toString();
  const r = await redeem(db, { ...who, bagId: b.bagId, creatorId: b.creator.userId, sharesRaw, redeemValueQuote: q.grossValue, holdingRaw: holdingSold, feeBps });
  return { quote: q, ...r };
}

const num = (s: string | undefined) => Number(s ?? '0');

describe('deposits', () => {
  it('1. FIRST deposit bootstraps at price 1: 1000 USD → 1000 shares; position == supply', async () => {
    const b = await bag();
    const inv = await newWallet(db);
    const q = await deposit(b, inv, '1000', '0');
    expect(q.isBootstrap).toBe(true);
    expect(BigInt(q.sharesRaw)).toBe(BigInt(1000) * E18);
    expect(await position(db, inv.userId, b.bagId)).toMatchObject({ shares_raw: (BigInt(1000) * E18).toString() });
  });

  it('2. SECOND deposit at a DIFFERENT NAV buys proportionally fewer shares (NAV doubled → half the shares per dollar)', async () => {
    const b = await bag();
    const a = await newWallet(db);
    const c = await newWallet(db);
    await deposit(b, a, '1000', '0'); // 1000 shares, NAV 1000
    const q = await deposit(b, c, '1000', '2000'); // NAV doubled → price 2
    expect(BigInt(q.sharesRaw)).toBe(BigInt(500) * E18);
    // The first depositor's claim is not diluted: 1000/1500 of a 3000 NAV = 2000 = their marked value.
    expect(BigInt(await totalShares(db, b.bagId))).toBe(BigInt(1500) * E18);
  });

  it('12. ROUNDING at share decimals never mints free shares: shares × NAV ≤ deposit × supply for awkward numbers', () => {
    const cases: [string, string, string][] = [
      ['1000.000001', '3', '333.333333'],
      ['7', '99999999999999999999', '0.000000000000000001'],
      ['123456789.123456', '777777777777777777777777', '1'],
      ['0.01', '3000000000000000000', '31415.926535'],
    ];
    for (const [navUsd, supplyRaw, amount] of cases) {
      const q = getDepositQuote(nav(navUsd), supply(supplyRaw), amount);
      const navScaled = BigInt(navUsd.replace('.', '').padEnd(0)) * SCALE / BigInt(10) ** BigInt(navUsd.split('.')[1]?.length ?? 0);
      const depScaled = BigInt(amount.replace('.', '')) * SCALE / BigInt(10) ** BigInt(amount.split('.')[1]?.length ?? 0);
      expect(BigInt(q.sharesRaw) * navScaled <= depScaled * BigInt(supplyRaw)).toBe(true);
    }
  });

  it('13/14. ZERO supply + positive NAV (orphaned holdings) and positive supply + ZERO NAV both fail closed', () => {
    expect(() => getDepositQuote(nav('250'), supply('0'), '100')).toThrow(OrphanedNavError);
    expect(() => getDepositQuote(nav('0'), supply(String(E18)), '100')).toThrow(ZeroNavError);
  });
});

describe('redemptions and cost basis', () => {
  it('3/20. PARTIAL redemption consumes cost basis exactly pro rata (30% of shares → 30% of basis)', async () => {
    const b = await bag(0);
    const inv = await newWallet(db);
    await deposit(b, inv, '1000', '0');
    await withdraw(b, inv, (BigInt(300) * E18).toString(), '1000', 0);
    const pos = await position(db, inv.userId, b.bagId);
    expect(pos?.shares_raw).toBe((BigInt(700) * E18).toString());
    expect(num(pos?.cost_basis_quote)).toBe(700);
  });

  it('4. FULL redemption leaves 0 shares and 0 basis', async () => {
    const b = await bag(0);
    const inv = await newWallet(db);
    await deposit(b, inv, '1000', '0');
    await withdraw(b, inv, (BigInt(1000) * E18).toString(), '1000', 0);
    expect(await position(db, inv.userId, b.bagId)).toMatchObject({ shares_raw: '0' });
    expect(num((await position(db, inv.userId, b.bagId))?.cost_basis_quote)).toBe(0);
    expect(await totalShares(db, b.bagId)).toBe('0');
  });

  it('6/20. SEVERAL redemptions by one investor: basis consumed sums back to exactly the original basis', async () => {
    const b = await bag(0);
    const inv = await newWallet(db);
    await deposit(b, inv, '1000', '0');
    let consumed = 0;
    for (const part of [333, 111, 222, 334]) {
      const before = num((await position(db, inv.userId, b.bagId))?.cost_basis_quote);
      await withdraw(b, inv, (BigInt(part) * E18).toString(), '1000', 0);
      consumed += before - num((await position(db, inv.userId, b.bagId))?.cost_basis_quote);
    }
    expect(consumed).toBeCloseTo(1000, 9);
    expect(num((await position(db, inv.userId, b.bagId))?.cost_basis_quote)).toBe(0);
  });

  it('5/19. MULTIPLE investors: Σ positions == total supply through interleaved deposits and redemptions', async () => {
    const b = await bag(0);
    const [x, y, z] = [await newWallet(db), await newWallet(db), await newWallet(db)];
    await deposit(b, x, '1000', '0');
    await deposit(b, y, '500', '1000');
    await withdraw(b, x, (BigInt(250) * E18).toString(), '1500', 0);
    await deposit(b, z, '777.77', '1250');
    await withdraw(b, y, (BigInt(100) * E18).toString(), '2027.77', 0);
    // (checked again by afterEach)
    expect(await sumPositionShares(db, b.bagId)).toBe(String(BigInt(await totalShares(db, b.bagId))));
  });
});

describe('performance fee economics', () => {
  it('7/10/11. PROFITABLE investor redemption after the lock: fee = locked bps × realized profit, recorded once', async () => {
    const b = await bag(1000);
    const inv = await newWallet(db);
    await deposit(b, inv, '1000', '0'); // locks at 10%
    // NAV rose to 1500 → 400 shares worth 600, consumed basis 400 → profit 200 → fee 20.00
    const r = await withdraw(b, inv, (BigInt(400) * E18).toString(), '1500');
    expect(Number(r.result.feeAmount)).toBe(20);
    expect(await feeSettlements(db, b.bagId)).toEqual([{ gross_amount_quote: '20.00', source_redeem_intent_id: r.intentId }]);
  });

  it('8. LOSS redemption: no fee', async () => {
    const b = await bag(3000);
    const inv = await newWallet(db);
    await deposit(b, inv, '1000', '0');
    await withdraw(b, inv, (BigInt(500) * E18).toString(), '600'); // worth 300 vs basis 500
    expect(await feeSettlements(db, b.bagId)).toEqual([]);
  });

  it('9. CREATOR redeeming their own position: no fee even on profit', async () => {
    const b = await bag(3000);
    await deposit(b, b.creator as { userId: string; wallet: string }, '1000', '0');
    await withdraw(b, b.creator as { userId: string; wallet: string }, (BigInt(500) * E18).toString(), '4000');
    expect(await feeSettlements(db, b.bagId)).toEqual([]);
  });

  it('14. ZERO NAV redemption: burns shares, consumes basis as a loss, no fee', async () => {
    const b = await bag(3000);
    const inv = await newWallet(db);
    await deposit(b, inv, '100', '0');
    const r = await withdraw(b, inv, (BigInt(100) * E18).toString(), '0');
    expect(r.quote.grossValue).toMatch(/^0(\.0+)?$/);
    expect(await position(db, inv.userId, b.bagId)).toMatchObject({ shares_raw: '0' });
    expect(await feeSettlements(db, b.bagId)).toEqual([]);
  });
});

describe('execution outcomes never produce wrong accounting', () => {
  const unchanged = async (bagId: string, before: { total: string }) => expect(await totalShares(db, bagId)).toBe(before.total);

  it('17. FAILED purchase never mints; FAILED redemption never burns', async () => {
    const b = await bag(0);
    const inv = await newWallet(db);
    await deposit(b, inv, '100', '0');
    const before = { total: await totalShares(db, b.bagId) };
    const failedBuy = await insertPurchaseIntent(db, { ...inv, bagId: b.bagId, sharesRaw: String(E18), status: 'FAILED' });
    await expect(purchase(db, { ...inv, bagId: b.bagId, sharesRaw: String(E18), costBasis: '1', intentId: failedBuy })).rejects.toThrow(/INTENT_NOT_EXECUTABLE/);
    const failedSell = await insertRedeemIntent(db, { ...inv, bagId: b.bagId, sharesRaw: String(E18), redeemValueQuote: '1' });
    await db.admin.query(`update redeem_intents set status = 'FAILED' where id = $1`, [failedSell]);
    await expect(redeem(db, { ...inv, bagId: b.bagId, creatorId: b.creator.userId, sharesRaw: String(E18), redeemValueQuote: '1', feeBps: 0, intentId: failedSell })).rejects.toThrow(
      /INTENT_NOT_EXECUTABLE/
    );
    await unchanged(b.bagId, before);
  });

  it('15/16. STALE (EXPIRED) purchase / redemption quotes are never accounted; a stale redeem allocation underflows and is refused', async () => {
    const b = await bag(0);
    const inv = await newWallet(db);
    await deposit(b, inv, '100', '0');
    const before = { total: await totalShares(db, b.bagId) };
    const expired = await insertPurchaseIntent(db, { ...inv, bagId: b.bagId, sharesRaw: String(E18), status: 'EXPIRED' });
    await expect(purchase(db, { ...inv, bagId: b.bagId, sharesRaw: String(E18), costBasis: '1', intentId: expired })).rejects.toThrow(/INTENT_NOT_EXECUTABLE/);
    // A redeem quote computed against holdings that no longer exist (stale allocation):
    await expect(
      redeem(db, { ...inv, bagId: b.bagId, creatorId: b.creator.userId, sharesRaw: String(E18), redeemValueQuote: '1', holdingRaw: (BigInt(10) ** BigInt(30)).toString(), feeBps: 0 })
    ).rejects.toThrow(/HOLDINGS_UNDERFLOW/);
    await unchanged(b.bagId, before);
  });

  it('18. REPEATED confirmation of one intent: accounted exactly once (sequential AND 8 concurrent)', async () => {
    const b = await bag(0);
    const inv = await newWallet(db);
    const intentId = await insertPurchaseIntent(db, { ...inv, bagId: b.bagId, sharesRaw: String(E18) });
    const results = await Promise.all(Array.from({ length: 8 }, () => purchase(db, { ...inv, bagId: b.bagId, sharesRaw: String(E18), costBasis: '1', intentId })));
    expect(results.filter((r) => r.result.alreadyApplied === false)).toHaveLength(1);
    const again = await purchase(db, { ...inv, bagId: b.bagId, sharesRaw: String(E18), costBasis: '1', intentId });
    expect(again.result.alreadyApplied).toBe(true);
    expect(await totalShares(db, b.bagId)).toBe(String(E18));
  });

  it('B. an UNKNOWN intent id or an intent of ANOTHER user is never accounted', async () => {
    const b = await bag(0);
    const inv = await newWallet(db);
    const other = await newWallet(db);
    await expect(purchase(db, { ...inv, bagId: b.bagId, sharesRaw: String(E18), costBasis: '1', intentId: '00000000-0000-0000-0000-000000000000' })).rejects.toThrow(/INTENT_NOT_FOUND/);
    const theirs = await insertPurchaseIntent(db, { ...other, bagId: b.bagId, sharesRaw: String(E18) });
    await expect(purchase(db, { ...inv, bagId: b.bagId, sharesRaw: String(E18), costBasis: '1', intentId: theirs })).rejects.toThrow(/INTENT_MISMATCH/);
    expect(await totalShares(db, b.bagId)).toBe('0');
  });

  it('13. redeeming from a ZERO-supply position is refused (no negative shares)', async () => {
    const b = await bag(0);
    const inv = await newWallet(db);
    await expect(redeem(db, { ...inv, bagId: b.bagId, creatorId: b.creator.userId, sharesRaw: '1', redeemValueQuote: '0', feeBps: 0 })).rejects.toThrow(/INSUFFICIENT_SHARES/);
  });
});

describe('router-settled redemption path (apply_redeem_execution_router_settled)', () => {
  const settle = async (o: { intentId: string; bagId: string; userId: string; creatorId: string; creatorWallet: string; sharesRaw: string; value: string; holdingRaw: string }) =>
    db.service.query(
      `select apply_redeem_execution_router_settled($1, $2, $3::jsonb, $4, 18, $5, $6, $7, $8, '0', '0', $9, $10) as r`,
      [o.intentId, o.bagId, JSON.stringify([{ chain: ASSET.chain, address: ASSET.address, quantity_raw: o.holdingRaw }]), o.sharesRaw, o.userId, o.value, o.creatorId, o.creatorWallet, `0x${'ab'.repeat(32)}`, `0x${'cd'.repeat(32)}`]
    );

  it('C. burning MORE shares than held is refused (used to drive shares and holdings negative)', async () => {
    const b = await bag(0);
    const inv = await newWallet(db);
    await deposit(b, inv, '10', '0');
    const intentId = await insertRedeemIntent(db, { ...inv, bagId: b.bagId, sharesRaw: String(BigInt(20) * E18), redeemValueQuote: '20' });
    await expect(settle({ intentId, bagId: b.bagId, userId: inv.userId, creatorId: b.creator.userId, creatorWallet: b.creator.wallet, sharesRaw: String(BigInt(20) * E18), value: '20', holdingRaw: '1' })).rejects.toThrow(
      /INSUFFICIENT_SHARES/
    );
  });

  it('D. a FULL router-settled redemption leaves NO residual cost basis (basis with >2 decimals)', async () => {
    const b = await bag(0);
    const inv = await newWallet(db);
    const shares = String(BigInt(3) * E18);
    await purchase(db, { ...inv, bagId: b.bagId, sharesRaw: shares, costBasis: '33.333333', holdingRaw: shares });
    const intentId = await insertRedeemIntent(db, { ...inv, bagId: b.bagId, sharesRaw: shares, redeemValueQuote: '40' });
    await settle({ intentId, bagId: b.bagId, userId: inv.userId, creatorId: b.creator.userId, creatorWallet: b.creator.wallet, sharesRaw: shares, value: '40', holdingRaw: shares });
    const pos = await position(db, inv.userId, b.bagId);
    expect(pos?.shares_raw).toBe('0');
    expect(num(pos?.cost_basis_quote)).toBe(0);
  });

  it('A. a FAILED intent is refused on the router path too', async () => {
    const b = await bag(0);
    const inv = await newWallet(db);
    await deposit(b, inv, '10', '0');
    const intentId = await insertRedeemIntent(db, { ...inv, bagId: b.bagId, sharesRaw: String(E18), redeemValueQuote: '1' });
    await db.admin.query(`update redeem_intents set status = 'CANCELLED' where id = $1`, [intentId]);
    await expect(settle({ intentId, bagId: b.bagId, userId: inv.userId, creatorId: b.creator.userId, creatorWallet: b.creator.wallet, sharesRaw: String(E18), value: '1', holdingRaw: '1' })).rejects.toThrow(
      /INTENT_NOT_EXECUTABLE/
    );
  });
});

describe('partially executed purchase (apply_partial_purchase_execution)', () => {
  const partialRpc = (args: { intentId: string; bagId: string; userId: string; sharesRaw: string; costBasis: string; holdingRaw: string }) =>
    db.admin.query(
      `select apply_partial_purchase_execution($1::uuid, $2::uuid, $3::jsonb, $4::uuid, $5::text, 18, $6::text) as r`,
      [
        args.intentId,
        args.bagId,
        JSON.stringify([{ chain: ASSET.chain, address: ASSET.address, decimals: ASSET.decimals, delta_raw: args.holdingRaw }]),
        args.userId,
        args.sharesRaw,
        args.costBasis,
      ]
    );

  it('mints the pro-rata shares and cost basis and credits the investor holdings, exactly once', async () => {
    const b = await bag(0);
    const inv = await newWallet(db);
    const intentId = await insertPurchaseIntent(db, { ...inv, bagId: b.bagId, sharesRaw: String(E18), status: 'PARTIAL_SUCCESS' });

    await partialRpc({ intentId, bagId: b.bagId, userId: inv.userId, sharesRaw: String((E18 * BigInt(74)) / BigInt(100)), costBasis: '3.7', holdingRaw: '500' });
    const again = await partialRpc({ intentId, bagId: b.bagId, userId: inv.userId, sharesRaw: String(E18), costBasis: '5', holdingRaw: '999' });

    expect(again.rows[0].r.alreadyApplied).toBe(true);
    expect(await totalShares(db, b.bagId)).toBe(String((E18 * BigInt(74)) / BigInt(100)));
    const pos = await position(db, inv.userId, b.bagId);
    expect(num(pos?.cost_basis_quote)).toBeCloseTo(3.7);
    const holding = (await db.admin.query('select quantity_raw from bag_investor_holdings where user_id = $1 and bag_id = $2', [inv.userId, b.bagId])).rows[0].quantity_raw;
    expect(holding).toBe('500');
  });

  it('refuses an intent that is not PARTIAL_SUCCESS, or belongs to someone else', async () => {
    const b = await bag(0);
    const inv = await newWallet(db);
    const other = await newWallet(db);
    const ready = await insertPurchaseIntent(db, { ...inv, bagId: b.bagId, sharesRaw: String(E18) });
    await expect(partialRpc({ intentId: ready, bagId: b.bagId, userId: inv.userId, sharesRaw: '1', costBasis: '0', holdingRaw: '1' })).rejects.toThrow(/INTENT_NOT_PARTIAL/);
    const partial = await insertPurchaseIntent(db, { ...inv, bagId: b.bagId, sharesRaw: String(E18), status: 'PARTIAL_SUCCESS' });
    await expect(partialRpc({ intentId: partial, bagId: b.bagId, userId: other.userId, sharesRaw: '1', costBasis: '0', holdingRaw: '1' })).rejects.toThrow(/INTENT_MISMATCH/);
    expect(await totalShares(db, b.bagId)).toBe('0');
  });
});
