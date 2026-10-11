import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createBag } from '@/lib/server/bag-repo';
import { TestDatabase, createTestDatabase, validRecipeInput } from './pg-harness';
import { ASSET, insertPurchaseIntent, newWallet } from './economics-harness';

// -----------------------------------------------------------------------------
// Two wallet-batched sales that were both refused as unmatched, then recovered (real PostgreSQL, production SQL):
// the first (half) is booked late, and the second ("sell all") was sized while the ledger still showed the full
// position. The second still books: it debits only what the ledger tracks after the first, burns only the
// remaining shares, and scales its proceeds and value to the part that was the strategy's. The chain is mocked:
// both transactions verify.
// -----------------------------------------------------------------------------

const trackComposer = vi.hoisted(() => vi.fn());
vi.mock('@/lib/blockchain/composer-status', () => ({ trackComposerTransaction: (...a: unknown[]) => trackComposer(...a) }));
vi.mock('@/lib/server/bag-nav-snapshots', () => ({ recordNavSnapshot: async () => undefined }));

const { recheckUnmatchedComposerSales } = await import('@/lib/server/redeem-execution');

const OTHER = { chain: 'robinhood', address: '0x00000000000000000000000000000000000000b2', decimals: 18 };
const USDG = '0x00000000000000000000000000000000000000c0';
const COMPOSER_TX = { to: '0x' + '4'.repeat(40), data: '0xdeadbeef', value: '0', chainId: 4663, approvals: [] };

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

function leg(i: number, asset: { address: string }, amount: string, out: string, txHash: string) {
  return {
    stepIndex: i,
    action: 'SWAP',
    targetSymbol: 'X',
    inputAsset: { chain: 'robinhood', address: asset.address },
    outputAsset: { chain: 'robinhood', address: USDG },
    sourceChain: 'robinhood',
    destinationChain: 'robinhood',
    inputAmountRaw: amount,
    targetValueRaw: amount,
    outputAmountRaw: out,
    outputDecimals: 6,
    minOutputRaw: null,
    providerEnforcedMinOutputRaw: null,
    route: null,
    lifiStep: null,
    status: 'FAILED',
    approvalTxHash: null,
    txHash,
    providerSubstatus: null,
    failureCode: 'VERIFICATION_FAILED',
  };
}

async function unmatchedSale(u: { userId: string; wallet: string }, bagId: string, o: { burn: string; value: string; legs: ReturnType<typeof leg>[]; status?: string }) {
  return (
    await db.admin.query(
      `insert into redeem_intents (user_id, wallet_address, bag_id, shares_raw, share_decimals, output_asset_chain, output_asset_address, output_decimals,
         route_fingerprint, share_price_at_quote, redeem_value_quote, steps, composer_transaction, status, failure_code, expires_at)
       values ($1, $2, $3, $4, 18, 'robinhood', $5, 6, 'fp', '0', $6, $7::jsonb, $8::jsonb, $9, $10, now() - interval '1 minute')
       returning id`,
      [u.userId, u.wallet, bagId, o.burn, USDG, o.value, JSON.stringify(o.legs), JSON.stringify(COMPOSER_TX), o.status ?? 'FAILED', o.status ? null : 'VERIFICATION_FAILED']
    )
  ).rows[0].id as string;
}

const tracked = async (userId: string, bagId: string, address: string) =>
  ((await db.admin.query('select quantity_raw from bag_investor_holdings where user_id = $1 and bag_id = $2 and address = $3', [userId, bagId, address])).rows[0]?.quantity_raw ??
    '0') as string;

describe('a sale booked after an earlier one was booked late (real PostgreSQL)', () => {
  async function boughtPosition() {
    const creator = await newWallet(db);
    const r = await createBag(db.client, { slug: `late-${Date.now()}`, creatorId: creator.userId, mutability: 'MUTABLE', recipe: validRecipeInput({ performanceFeeBps: 0 }), reason: 't' });
    if (!r.ok) throw new Error(JSON.stringify(r));
    const bagId = r.bag.id;
    const u = creator;

    const purchaseId = await insertPurchaseIntent(db, { ...u, bagId, sharesRaw: '100' });
    await db.service.query('select apply_purchase_execution($1, $2, $3::jsonb, $4, 18, $5, $6)', [
      purchaseId,
      bagId,
      JSON.stringify([
        { ...ASSET, delta_raw: '100', cost_quote: '50' },
        { ...OTHER, delta_raw: '100', cost_quote: '50' },
      ]),
      '100',
      u.userId,
      '100',
    ]);
    return { u, bagId };
  }

  it('books both: the second debits only what is still tracked and burns only the remaining shares', async () => {
    const { u, bagId } = await boughtPosition();
    const TX_A = '0x' + 'a'.repeat(64);
    const TX_B = '0x' + 'b'.repeat(64);
    // A: half the position. B: "sell all" of what the wallet then held, sized while A was still unbooked (burn 100).
    await unmatchedSale(u, bagId, { burn: '50', value: '50', legs: [leg(0, ASSET, '50', '25000000', TX_A), leg(1, OTHER, '50', '25000000', TX_A)] });
    await new Promise((res) => setTimeout(res, 5));
    const b = await unmatchedSale(u, bagId, { burn: '100', value: '50', legs: [leg(0, ASSET, '40', '20000000', TX_B), leg(1, OTHER, '55', '27500000', TX_B)] });

    trackComposer.mockImplementation(async ({ txHash }: { txHash: string }) =>
      txHash === TX_A
        ? { kind: 'DONE', receivedAmountsByAddress: { [USDG]: '50000000' }, sentAmountsByAddress: { [ASSET.address]: '50', [OTHER.address]: '50' } }
        : { kind: 'DONE', receivedAmountsByAddress: { [USDG]: '47500000' }, sentAmountsByAddress: { [ASSET.address]: '40', [OTHER.address]: '55' } }
    );

    const session = { userId: u.userId, walletAddress: u.wallet } as never;
    expect(await recheckUnmatchedComposerSales(db.client, session, bagId)).toEqual({ booked: 2 });

    expect(await tracked(u.userId, bagId, ASSET.address)).toBe('10');
    expect(await tracked(u.userId, bagId, OTHER.address)).toBe('0');
    const pos = (await db.admin.query('select shares_raw from bag_investor_positions where user_id = $1 and bag_id = $2', [u.userId, bagId])).rows[0];
    expect(pos?.shares_raw ?? '0').toBe('0');
    const statuses = (await db.admin.query('select status from redeem_intents where bag_id = $1 order by created_at', [bagId])).rows.map((x) => x.status);
    expect(statuses).toEqual(['COMPLETED', 'COMPLETED']);

    // B's OTHER leg debited 50 of the 55 sold, so it counts 50/55 of what that leg returned; its value shrinks alike.
    const sale = (await db.admin.query(`select legs, quote from ledger_events where kind = 'REDEEM_FILL' and source::text like '%' || $1 || '%'`, [b])).rows[0];
    expect(sale, 'ledger event for B').toBeDefined();
    expect(sale.legs).toEqual([
      expect.objectContaining({ address: ASSET.address, deltaRaw: '-40', proceedsQuote: '20' }),
      expect.objectContaining({ address: OTHER.address, deltaRaw: '-50', proceedsQuote: '25' }),
    ]);
    // Value 50 × (20 + 25) / (20 + 27.5); the shares burned are the 50 left after A, not the 100 quoted.
    expect(sale.quote).toMatchObject({ sharesDeltaRaw: '-50', redeemValueQuote: '47.368421052631578947' });
  });

  it('finishes a sale left CONFIRMING with verified legs after its booking failed, once the earlier sale is booked', async () => {
    const { u, bagId } = await boughtPosition();
    const TX_A = '0x' + 'c'.repeat(64);
    const TX_B = '0x' + 'd'.repeat(64);
    await unmatchedSale(u, bagId, { burn: '50', value: '50', legs: [leg(0, ASSET, '50', '25000000', TX_A), leg(1, OTHER, '50', '25000000', TX_A)] });
    await new Promise((res) => setTimeout(res, 5));
    // What the earlier code left behind: legs verified, intent CONFIRMING, the burn of 100 refused by the ledger.
    const done = [leg(0, ASSET, '40', '20000000', TX_B), leg(1, OTHER, '55', '27500000', TX_B)].map((l) => ({ ...l, status: 'COMPLETED', failureCode: null }));
    await unmatchedSale(u, bagId, { burn: '100', value: '50', legs: done as never, status: 'CONFIRMING' });
    trackComposer.mockResolvedValue({ kind: 'DONE', receivedAmountsByAddress: { [USDG]: '50000000' }, sentAmountsByAddress: { [ASSET.address]: '50', [OTHER.address]: '50' } });

    const session = { userId: u.userId, walletAddress: u.wallet } as never;
    expect(await recheckUnmatchedComposerSales(db.client, session, bagId)).toEqual({ booked: 2 });
    expect(await tracked(u.userId, bagId, ASSET.address)).toBe('10');
    expect(await tracked(u.userId, bagId, OTHER.address)).toBe('0');
  });
});
