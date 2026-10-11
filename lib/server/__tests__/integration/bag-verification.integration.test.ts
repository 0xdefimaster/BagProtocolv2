import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBag } from '@/lib/server/bag-repo';
import { getBagVerification } from '@/lib/server/bag-verification';
import { scanTrackedWalletTransfers } from '@/lib/server/wallet-transfer-scan';
import { TestDatabase, createTestDatabase, validRecipeInput } from './pg-harness';
import { ASSET, insertPurchaseIntent, newWallet } from './economics-harness';

// On-chain freshness of a Bag against the production schema (0049): the transfer scan marks covered wallets
// verified, an open drift shows as a pending outflow, and a never-checked holder leaves the Bag unverified.
// The chain is a stub: no transfers.

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase({ mode: 'fresh' });
});
afterAll(async () => {
  await db?.drop();
});

async function bagWithHolder() {
  const creator = await newWallet(db);
  const r = await createBag(db.client, { slug: `verify-${Date.now()}-${Math.random()}`, creatorId: creator.userId, mutability: 'MUTABLE', recipe: validRecipeInput({ performanceFeeBps: 0 }), reason: 't' });
  if (!r.ok) throw new Error(JSON.stringify(r));
  const u = await newWallet(db);
  const intent = await insertPurchaseIntent(db, { ...u, bagId: r.bag.id, sharesRaw: '100' });
  await db.service.query('select apply_purchase_execution($1, $2, $3::jsonb, $4, 18, $5, $6)', [intent, r.bag.id, JSON.stringify([{ ...ASSET, delta_raw: '100', cost_quote: '100' }]), '100', u.userId, '100']);
  return { bagId: r.bag.id, u };
}

const stubChain = (latest: bigint) => ({ getBlockNumber: async () => latest, getLogs: async () => [] }) as never;

describe('Bag verification (real PostgreSQL)', () => {
  it('a never-checked holder: unverified; after the scan covers the wallet: verified at the scan; an open drift: pending', async () => {
    const { bagId, u } = await bagWithHolder();
    expect((await getBagVerification(db.client, [bagId])).get(bagId)).toEqual({ checkedAt: null, pendingOutflows: 0 });

    // A first full check at block 100 (what the round-robin pass records), then a scan at 150 with no transfers.
    await db.service.query('select mark_wallet_reconciled($1, $2)', [u.userId, 100]);
    const scan = await scanTrackedWalletTransfers(db.client, stubChain(BigInt(150)));
    expect(scan).toMatchObject({ covered: 1, verified: 1, reconciled: 0 });
    const state = (await db.admin.query('select last_block_number from wallet_reconciliation_state where user_id = $1', [u.userId])).rows[0];
    expect(String(state.last_block_number)).toBe('150');
    const fresh = (await getBagVerification(db.client, [bagId])).get(bagId)!;
    expect(fresh.checkedAt).not.toBeNull();
    expect(fresh.pendingOutflows).toBe(0);

    // The wallet now holds 60 of the tracked 100: a first sighting records a DRIFT naming the Bag.
    const obs = (await db.service.query('select apply_wallet_observation($1, $2, $3, $4, $5) as r', [u.userId, ASSET.chain, ASSET.address, 151, '60'])).rows[0].r;
    expect(obs.status).toBe('DRIFT');
    expect((await getBagVerification(db.client, [bagId])).get(bagId)!.pendingOutflows).toBe(1);
  });
});
