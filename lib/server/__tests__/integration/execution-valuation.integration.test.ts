import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBag } from '@/lib/server/bag-repo';
import { executionPricesFromLegs, navAtExecutionPrices } from '@/lib/domain/basket-protocol/shares/execution-valuation';
import { getDepositQuote } from '@/lib/domain/basket-protocol/shares/shares';
import type { AssetHolding, ShareSupply } from '@/types/basket-protocol';
import { TestDatabase, createTestDatabase, insertUser, validRecipeInput } from './pg-harness';
import { insertPurchaseIntent, newWallet, totalShares } from './economics-harness';

// Weekend purchase on a REAL database: the oracle cannot price the holdings,
// so the second buyer's shares are priced from the purchase's own quote,
// minted by the production accounting RPC, and checked against the in-kind
// fairness rule: at the purchase's executable prices, the buyer's claim is at
// most the value they added and the existing holder is never diluted.

const A = { chain: 'robinhood' as const, address: '0x00000000000000000000000000000000000000a1' };
const B = { chain: 'robinhood' as const, address: '0x00000000000000000000000000000000000000b2' };
const USDG = { chain: 'robinhood' as const, address: '0x00000000000000000000000000000000000000c0' };
const e18 = (n: number) => (BigInt(Math.round(n * 1e6)) * BigInt(1e12)).toString();

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db?.drop();
});

async function applyPurchase(bagId: string, who: { userId: string; wallet: string }, sharesRaw: string, costBasis: string, deltas: { asset: typeof A; raw: string }[]) {
  const intentId = await insertPurchaseIntent(db, { ...who, bagId, sharesRaw });
  await db.service.query('select apply_purchase_execution($1, $2, $3::jsonb, $4, 18, $5, $6) as r', [
    intentId,
    bagId,
    JSON.stringify(deltas.map((d) => ({ chain: d.asset.chain, address: d.asset.address, decimals: 18, delta_raw: d.raw }))),
    sharesRaw,
    who.userId,
    costBasis,
  ]);
}
const bagHoldings = async (bagId: string): Promise<AssetHolding[]> =>
  (await db.admin.query('select chain, address, quantity_raw, decimals from bag_holdings where bag_id = $1', [bagId])).rows.map((r) => ({
    asset: { chain: r.chain, address: r.address },
    quantityRaw: r.quantity_raw,
    decimals: r.decimals,
  }));
const sharesOf = async (bagId: string, userId: string) =>
  BigInt((await db.admin.query('select shares_raw from bag_investor_positions where bag_id = $1 and user_id = $2', [bagId, userId])).rows[0].shares_raw);

describe('weekend purchase priced from the executable quote (real accounting RPCs)', () => {
  it('mints the in-kind share of the Bag, never more, and does not dilute the existing holder', async () => {
    const creatorId = await insertUser(db, `0x${'e'.repeat(40)}`);
    const created = await createBag(db.client, { slug: `ev-${Date.now()}`, creatorId, mutability: 'MUTABLE', recipe: validRecipeInput(), reason: 't' });
    if (!created.ok) throw new Error(JSON.stringify(created));
    const bagId = created.bag.id;
    const alice = await newWallet(db);
    const bob = await newWallet(db);

    // Alice bootstraps: 100 shares for 600 A + 300 B (cost 1000).
    await applyPurchase(bagId, alice, e18(100), '1000', [{ asset: A, raw: e18(600) }, { asset: B, raw: e18(300) }]);

    // Weekend: Bob deposits 50 USDG; the quote buys >= 29.7 A for 30 and >= 15 B for 20.
    const legs = [
      { action: 'SWAP' as const, outputAsset: A, inputAmountRaw: String(30e6), minOutputRaw: e18(29.7), outputDecimals: 18 },
      { action: 'SWAP' as const, outputAsset: B, inputAmountRaw: String(20e6), minOutputRaw: e18(15), outputDecimals: 18 },
    ];
    const now = new Date();
    const prices = executionPricesFromLegs(legs, { asset: USDG, decimals: 6 }, now.toISOString());
    const valued = navAtExecutionPrices(await bagHoldings(bagId), prices, new Map(), now);
    if (!valued.ok) throw new Error('unpriced');
    const supply: ShareSupply = { bagId, totalSharesRaw: await totalShares(db, bagId), shareDecimals: 18, updatedAt: now.toISOString() };
    const quote = getDepositQuote(valued.nav, supply, '50');

    await applyPurchase(bagId, bob, quote.sharesRaw, quote.depositAmount, [{ asset: A, raw: e18(29.7) }, { asset: B, raw: e18(15) }]);

    // Fairness = no value transfer at the purchase's executable prices: Bob's claim is at most the value he
    // added, Alice's claim at least the value she held. (An exact per-asset in-kind ratio only exists when the
    // purchase buys in the Bag's exact proportions; here they differ slightly, 1.98:1 vs 2:1.)
    const bobShares = await sharesOf(bagId, bob.userId);
    const aliceShares = await sharesOf(bagId, alice.userId);
    const total = BigInt(await totalShares(db, bagId));
    expect(bobShares + aliceShares).toBe(total);
    const after = navAtExecutionPrices(await bagHoldings(bagId), prices, new Map(), now);
    if (!after.ok) throw new Error('unpriced');
    const totalValue = Number(after.nav.grossNav);
    const bobValue = 29.7 * Number(prices.get(`robinhood:${A.address}`)!.price) + 15 * Number(prices.get(`robinhood:${B.address}`)!.price);
    const bobFraction = Number(bobShares) / Number(total);
    const aliceFraction = Number(aliceShares) / Number(total);
    expect(bobFraction).toBeLessThanOrEqual(bobValue / totalValue + 1e-12);
    expect(aliceFraction).toBeGreaterThanOrEqual(Number(valued.nav.grossNav) / totalValue - 1e-12);
    // Bob's claim lies between his per-asset contributions (4.716% of A, 4.762% of B).
    expect(bobFraction).toBeGreaterThan(29.7 / 629.7);
    expect(bobFraction).toBeLessThan(15 / 315);
    // Sanity: the valuation used real holdings from the database.
    expect(Number(valued.nav.grossNav)).toBeCloseTo(600 * (30 / 29.7) + 300 * (20 / 15), 6);
  });
});
