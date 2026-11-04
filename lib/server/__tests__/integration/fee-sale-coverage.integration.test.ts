import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBag, createBagVersion } from '@/lib/server/bag-repo';
import { loadFeeSaleInventory, runFeeSaleCoverageGate } from '@/lib/server/fee-sale-coverage-gate';
import { ROBINHOOD_REWARD_TOKEN } from '@/lib/config/robinhood-chain';
import { TestDatabase, createTestDatabase, validRecipeInput } from './pg-harness';
import { ASSET, newWallet, purchase } from './economics-harness';

// -----------------------------------------------------------------------------
// The fee-sale coverage gate's inventory reader against a REAL PostgreSQL with
// the real schema: real column names (performance_fee_bps_locked,
// current_version_id, bag_versions.recipe, bag_investor_holdings, assets), the
// real fee lock (migration 0033) and holdings credited by the real
// apply_purchase_execution RPC. Read-only: the reader only selects.
// -----------------------------------------------------------------------------

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase({ mode: 'fresh' });
});
afterAll(async () => {
  await db?.drop();
});

const E18 = BigInt(10) ** BigInt(18);
const FEED = '0x000000000000000000000000000000000000f00d';

describe('fee-sale coverage gate over the real schema', () => {
  it('reads every table completely; a held earlier-version asset is required; the locked rate and creator split are applied', async () => {
    const creator = await newWallet(db);
    const investor = await newWallet(db);
    const created = await createBag(db.client, { slug: `cov-${Date.now()}`, creatorId: creator.userId, mutability: 'MUTABLE', recipe: validRecipeInput({ performanceFeeBps: 1000 }), reason: 'test' });
    if (!created.ok) throw new Error(JSON.stringify(created));
    const bagId = created.bag.id;

    // Real RPC: credits bag_investor_holdings with ASSET (not in the recipe) and locks the fee at the first external investment.
    await purchase(db, { ...investor, bagId, sharesRaw: (BigInt(10) * E18).toString(), costBasis: '100' });
    await purchase(db, { ...creator, bagId, sharesRaw: (BigInt(5) * E18).toString(), costBasis: '50' });
    // A new version with different weights: ASSET is still not in it — the investor holds it from before.
    const recipe = validRecipeInput();
    const v2 = await createBagVersion(db.client, {
      bagId,
      createdBy: creator.userId,
      reason: 'rebalance',
      recipe: validRecipeInput({ performanceFeeBps: 1000, assets: recipe.assets.map((a) => ({ ...a, weightBps: 5000 })) }),
    });
    expect(v2.ok).toBe(true);

    const [btc, eth] = recipe.assets.map((a) => a.address.toLowerCase());
    for (const [address, type] of [
      [ASSET.address, 'stock'],
      [btc, 'stock'],
      [eth, 'crypto'],
    ] as const) {
      await db.admin.query(`insert into assets (chain, address, symbol, decimals, name, asset_type) values ('robinhood', $1, $2, 18, $2, $3)`, [address, `T${address.slice(-4)}`, type]);
    }

    const inv = await loadFeeSaleInventory(db.client);
    expect(inv.ok).toBe(true);
    if (!inv.ok) return;
    const bag = inv.inventory.bags.find((b) => b.id === bagId)!;
    expect(bag.performanceFeeBpsLocked).toBe(1000);
    expect(bag.currentRecipe?.assets.map((a) => a.address.toLowerCase())).toEqual([btc, eth]);

    const run = await runFeeSaleCoverageGate({
      loadInventory: () => loadFeeSaleInventory(db.client),
      feeds: { [ASSET.address]: FEED, [btc]: FEED },
      settlementTokenAddress: ROBINHOOD_REWARD_TOKEN.address,
    });
    const b = run.report!.bags.find((x) => x.id === bagId)!;
    expect(b).toMatchObject({ feeBps: 1000, feeSource: 'LOCKED', feePositions: 1, creatorPositions: 1, status: 'FEE_SALE_REFUSED' });
    expect(b.legs.map((l) => [l.address.toLowerCase(), l.origin, l.coverage])).toEqual(
      [
        [ASSET.address, 'HELD_FROM_EARLIER_VERSION', 'FEED_CONFIGURED'],
        [btc, 'CURRENT_RECIPE_NOT_HELD', 'FEED_CONFIGURED'],
        [eth, 'CURRENT_RECIPE_NOT_HELD', 'NO_QUALIFIED_SOURCE'],
      ].sort((x, y) => x[0].localeCompare(y[0]))
    );
    expect(run.exitCode).toBe(1); // eth is crypto: no qualified price source for a fee sale
  });
});
