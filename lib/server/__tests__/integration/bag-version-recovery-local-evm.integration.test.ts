import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { network } from 'hardhat';
import type { Hex, PublicClient } from 'viem';
import { createEvmBagDeploymentAdapter } from '@/lib/blockchain/evm/adapter';
import { createEvmBagVersionAdapter, type BagVersionAdapter } from '@/lib/blockchain/evm/version-adapter';
import type { EvmChainConfig } from '@/lib/blockchain/evm/config';
import { computeOnChainBagId, computeOnChainCompositionHash } from '@/lib/domain/basket-protocol/onchain';
import { computeCompositionHash } from '@/lib/domain/basket-protocol/version';
import { confirmBagDeployment, prepareBagDeployment } from '@/lib/server/deploy-bag';
import { confirmBagVersionUpdate, prepareBagVersionUpdate, sameBody, versionMetadataURI, type VersionChange } from '@/lib/server/bag-versioning';
import { getBagVersionStatus, recoverBagVersions } from '@/lib/server/bag-version-recovery';
import { createBag } from '@/lib/server/bag-repo';
import { TestDatabase, createTestDatabase, insertUser, validRecipeInput } from './pg-harness';

// -----------------------------------------------------------------------------
// Chain/database consistency for creator version updates (migration 0059): real PostgreSQL + real BagFactory/Bag on
// Hardhat's in-process EVM + the real adapters and server code. A version the chain accepted is recorded from the
// server's pending proposal, from any session, only after its transaction is located and verified on chain.
// NOT a real-network test.
// -----------------------------------------------------------------------------

let db: TestDatabase;
let upgraded: TestDatabase;
let viem: Awaited<ReturnType<typeof network.connect>>['viem'];
let publicClient: PublicClient;

beforeAll(async () => {
  [db, upgraded] = await Promise.all([createTestDatabase({ mode: 'fresh' }), createTestDatabase({ mode: 'upgrade' })]);
  viem = (await network.connect()).viem;
  publicClient = (await viem.getPublicClient()) as unknown as PublicClient;
});
afterAll(async () => {
  await Promise.all([db?.drop(), upgraded?.drop()]);
});

const rpc = (method: string, params: unknown[] = []) => (publicClient as unknown as { request: (a: { method: string; params: unknown[] }) => Promise<unknown> }).request({ method, params });

function configFor(factoryAddress: Hex): EvmChainConfig {
  return {
    chain: 'robinhood',
    viemChain: { id: 31337, name: 'Hardhat (local)', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [] } } } as unknown as EvmChainConfig['viemChain'],
    rpcUrl: 'in-process',
    factoryAddress,
    confirmations: 1,
    receiptTimeoutMs: 1200,
  };
}

/** A version change: weights `a`/`b` (bps) on the Bag's two assets (everything else comes from the current version). */
function weights(a: number, b: number): VersionChange {
  const r = validRecipeInput();
  return { assets: [{ ...r.assets[0], weightBps: a }, { ...r.assets[1], weightBps: b }] };
}

let cursor = 0;
async function deployedBag() {
  const wallets = await viem.getWalletClients();
  const user = wallets[cursor++ % wallets.length];
  const factory = await viem.deployContract('BagFactory', [user.account.address, user.account.address, BigInt(0), BigInt(0)]);
  const config = configFor(factory.address);
  const deployAdapter = createEvmBagDeploymentAdapter(config, publicClient);
  const adapter = createEvmBagVersionAdapter(config, publicClient);
  const wallet = user.account.address.toLowerCase();
  const userId = (await db.admin.query('insert into users (wallet_address) values ($1) on conflict (wallet_address) do update set wallet_address = excluded.wallet_address returning id', [wallet])).rows[0].id as string;
  const created = await createBag(db.client, { slug: `rec-${Date.now()}-${cursor}`, creatorId: userId, mutability: 'MUTABLE', recipe: { ...validRecipeInput(), assets: weights(6000, 4000).assets }, reason: 't' });
  if (!created.ok) throw new Error(JSON.stringify(created));
  const bag = created.bag;
  const session = { userId, walletAddress: wallet };
  const prepared = await prepareBagDeployment(db.client, session, bag.id, { resolveAdapter: () => deployAdapter });
  if (!prepared.ok) throw new Error(JSON.stringify(prepared));
  const deployTx = await user.sendTransaction({ to: prepared.transaction.to as Hex, data: prepared.transaction.data });
  const confirmed = await confirmBagDeployment(db.client, session, bag.id, deployTx, { resolveAdapter: () => deployAdapter });
  if (!confirmed.ok) throw new Error(JSON.stringify(confirmed));
  const deps = { resolveAdapter: () => adapter };
  const prepareAndSend = async (recipe = weights(4000, 6000), reason = 'edit') => {
    const p = await prepareBagVersionUpdate(db.client, session, bag.id, recipe, deps, reason);
    if (!p.ok) throw new Error(`prepare failed: ${JSON.stringify(p)}`);
    return { prepared: p, txHash: await user.sendTransaction({ to: p.transaction.to, data: p.transaction.data }) };
  };
  return { user, factory, bag, session, userId, adapter, deps, deployTx, deployment: confirmed.deployment, prepareAndSend };
}

const state = async (bagId: string) => {
  const b = (await db.admin.query('select current_version from bags where id = $1', [bagId])).rows[0];
  const d = (await db.admin.query(`select on_chain_version from bag_deployments where bag_id = $1 and status = 'DEPLOYED'`, [bagId])).rows[0];
  const n = (await db.admin.query('select count(*)::int as n from bag_versions where bag_id = $1', [bagId])).rows[0].n;
  return { currentVersion: b.current_version as number, onChainVersion: d.on_chain_version as number, versions: n as number };
};
const proposals = async (bagId: string) =>
  (await db.admin.query('select id, status, tx_hash, expected_onchain_version, onchain_composition_hash, prepared_block, recipe, reason from bag_version_proposals where bag_id = $1 order by created_at', [bagId])).rows;

describe('prepare stores the proposal before any signature', () => {
  it('canonical recipe, versions, hashes (recomputed server-side), chain id, Bag address and owner', async () => {
    const s = await deployedBag();
    const head = await publicClient.getBlockNumber();
    const p = await prepareBagVersionUpdate(db.client, s.session, s.bag.id, weights(4000, 6000), s.deps, 'why');
    if (!p.ok) throw new Error(JSON.stringify(p));
    const row = (await db.admin.query('select * from bag_version_proposals where id = $1', [p.proposalId])).rows[0];
    expect(row).toMatchObject({
      bag_id: s.bag.id,
      creator_id: s.userId,
      wallet: s.session.walletAddress,
      chain: 'robinhood',
      chain_id: 31337,
      factory_address: s.factory.address.toLowerCase(),
      contract_address: s.deployment.contractAddress!.toLowerCase(),
      on_chain_bag_id: s.deployment.onChainBagId!.toLowerCase(),
      expected_onchain_version: 1,
      new_onchain_version: 2,
      composition_hash: computeCompositionHash(weights(4000, 6000).assets),
      onchain_composition_hash: computeOnChainCompositionHash(weights(4000, 6000).assets).toLowerCase(),
      metadata_uri: versionMetadataURI(s.bag.id, 2),
      reason: 'why',
      status: 'PENDING',
      tx_hash: null,
    });
    expect(BigInt(row.prepared_block)).toBe(head);
    expect(row.recipe.assets.map((a: { weightBps: number }) => a.weightBps)).toEqual([4000, 6000]);
    // The transaction hands out exactly what was stored.
    expect(p.onChainCompositionHash.toLowerCase()).toBe(row.onchain_composition_hash);

    // Preparing the same change again reuses the proposal unchanged (first reason and block kept).
    await rpc('evm_mine');
    const again = await prepareBagVersionUpdate(db.client, s.session, s.bag.id, weights(4000, 6000), s.deps, 'why 2');
    if (!again.ok) throw new Error(JSON.stringify(again));
    expect(again.proposalId).toBe(p.proposalId);
    const after = (await proposals(s.bag.id))[0];
    expect(BigInt(after.prepared_block)).toBe(head);
    expect(after.reason).toBe('why');
    // A different change is a separate, concurrent proposal.
    const other = await prepareBagVersionUpdate(db.client, s.session, s.bag.id, weights(5000, 5000), s.deps);
    if (!other.ok) throw new Error(JSON.stringify(other));
    expect(other.proposalId).not.toBe(p.proposalId);
  });

  it('no proposal stored → no calldata handed out', async () => {
    const s = await deployedBag();
    await db.admin.query('alter table bag_version_proposals add constraint t_block check (prepared_block < 0) not valid');
    try {
      const p = await prepareBagVersionUpdate(db.client, s.session, s.bag.id, weights(4000, 6000), s.deps);
      expect(p).toMatchObject({ ok: false, error: 'PROPOSAL_NOT_SAVED' });
      expect(p).not.toHaveProperty('transaction');
    } finally {
      await db.admin.query('alter table bag_version_proposals drop constraint t_block');
    }
  });
});

describe('recovery when the browser forgot the transaction', () => {
  it('localStorage cleared / another session: status shows the chain ahead; recover records it with no hash from the client', async () => {
    const s = await deployedBag();
    const { txHash } = await s.prepareAndSend(weights(4000, 6000), 'swap weights');
    // No confirm: as if the tab was closed and storage cleared.
    expect(await state(s.bag.id)).toEqual({ currentVersion: 1, onChainVersion: 1, versions: 1 });
    // Prepare is now refused: the chain is ahead.
    expect(await prepareBagVersionUpdate(db.client, s.session, s.bag.id, weights(3000, 7000), s.deps)).toMatchObject({ ok: false, error: 'OUT_OF_SYNC' });

    // A different session (another browser, signed in again; the session wallet string plays no part).
    const otherSession = { userId: s.userId, walletAddress: '0x' + '9'.repeat(40) };
    expect(await getBagVersionStatus(db.client, otherSession, s.bag.id, s.deps)).toEqual({ ok: true, recordedVersion: 1, chainVersion: 2, inSync: false, pendingProposals: 1 });
    const r = await recoverBagVersions(db.client, otherSession, s.bag.id, {}, s.deps);
    if (!r.ok) throw new Error(JSON.stringify(r));
    expect(r).toMatchObject({ recordedVersion: 2, chainVersion: 2, inSync: true });
    expect(r.recovered.map((v) => v.version)).toEqual([2]);
    expect(await state(s.bag.id)).toEqual({ currentVersion: 2, onChainVersion: 2, versions: 2 });

    const v = (await db.admin.query('select onchain_tx_hash, reason, recipe from bag_versions where bag_id = $1 and version = 2', [s.bag.id])).rows[0];
    expect(v.onchain_tx_hash).toBe(txHash.toLowerCase());
    expect(v.reason).toBe('swap weights');
    expect(v.recipe.assets.map((a: { weightBps: number }) => a.weightBps)).toEqual([4000, 6000]);
    expect((await proposals(s.bag.id))[0]).toMatchObject({ status: 'RECORDED', tx_hash: txHash.toLowerCase() });

    // Retry is a no-op: no second version, no second history row.
    const again = await recoverBagVersions(db.client, s.session, s.bag.id, {}, s.deps);
    expect(again).toMatchObject({ ok: true, recovered: [], inSync: true });
    // So is the old confirm with the same transaction.
    expect(await confirmBagVersionUpdate(db.client, s.session, s.bag.id, weights(4000, 6000), txHash, 'late', s.deps)).toMatchObject({ ok: true, alreadyConfirmed: true });
    expect(await state(s.bag.id)).toEqual({ currentVersion: 2, onChainVersion: 2, versions: 2 });
    // And editing works again.
    expect((await prepareBagVersionUpdate(db.client, s.session, s.bag.id, weights(3000, 7000), s.deps)).ok).toBe(true);
  });

  it('the database write fails after the chain accepted it: the proposal stays pending and a later recovery succeeds', async () => {
    const s = await deployedBag();
    const { txHash } = await s.prepareAndSend();
    await db.admin.query(`create or replace function t_fail() returns trigger language plpgsql as $$ begin raise exception 'simulated outage'; end $$`);
    await db.admin.query('create trigger t_fail before insert on bag_versions for each row execute function t_fail()');
    try {
      expect(await confirmBagVersionUpdate(db.client, s.session, s.bag.id, weights(4000, 6000), txHash, 'edit', s.deps)).toMatchObject({ ok: false, error: 'CHAIN_ERROR' });
      expect(await recoverBagVersions(db.client, s.session, s.bag.id, {}, s.deps)).toMatchObject({ ok: false, error: 'CHAIN_ERROR' });
      expect((await proposals(s.bag.id))[0]).toMatchObject({ status: 'PENDING', tx_hash: null });
      expect(await state(s.bag.id)).toEqual({ currentVersion: 1, onChainVersion: 1, versions: 1 });
    } finally {
      await db.admin.query('drop trigger t_fail on bag_versions');
    }
    const r = await recoverBagVersions(db.client, s.session, s.bag.id, {}, s.deps);
    expect(r).toMatchObject({ ok: true, inSync: true, recordedVersion: 2 });
    expect(await state(s.bag.id)).toEqual({ currentVersion: 2, onChainVersion: 2, versions: 2 });
  });

  it('8 concurrent recoveries → one version row', async () => {
    const s = await deployedBag();
    await s.prepareAndSend();
    const results = await Promise.all(Array.from({ length: 8 }, () => recoverBagVersions(db.client, s.session, s.bag.id, {}, s.deps)));
    expect(results.filter((r) => !r.ok)).toEqual([]);
    expect(await state(s.bag.id)).toEqual({ currentVersion: 2, onChainVersion: 2, versions: 2 });
  });

  it('a supplied transaction hash is verified, never trusted', async () => {
    const s = await deployedBag();
    const { txHash } = await s.prepareAndSend();
    // The deployment transaction has no BagVersionRecorded: refused, nothing written.
    expect(await recoverBagVersions(db.client, s.session, s.bag.id, { txHash: s.deployTx }, s.deps)).toMatchObject({ ok: false, error: 'VERIFICATION_FAILED' });
    expect(await recoverBagVersions(db.client, s.session, s.bag.id, { txHash: 'nope' }, s.deps)).toMatchObject({ ok: false, error: 'VERIFICATION_FAILED' });
    expect(await state(s.bag.id)).toEqual({ currentVersion: 1, onChainVersion: 1, versions: 1 });
    // The right one works.
    expect(await recoverBagVersions(db.client, s.session, s.bag.id, { txHash }, s.deps)).toMatchObject({ ok: true, inSync: true, recordedVersion: 2 });
  });

  it('a hash that is not on chain yet is reported as pending', async () => {
    const s = await deployedBag();
    await prepareBagVersionUpdate(db.client, s.session, s.bag.id, weights(4000, 6000), s.deps);
    expect(await recoverBagVersions(db.client, s.session, s.bag.id, { txHash: `0x${'ab'.repeat(32)}` }, s.deps)).toMatchObject({ ok: false, error: 'PENDING' });
  });
});

describe('nothing is recorded that the server did not propose', () => {
  it('a version sent straight to the factory (no proposal): NO_PROPOSAL with the transaction found, nothing written', async () => {
    const s = await deployedBag();
    const assets = weights(2500, 7500).assets;
    const tx = s.adapter.prepareRecordVersion({ offChainRef: computeOnChainBagId(s.bag.id), expectedCurrentVersion: 1, compositionHash: computeOnChainCompositionHash(assets), metadataURI: versionMetadataURI(s.bag.id, 2) });
    const txHash = await s.user.sendTransaction({ to: tx.to, data: tx.data });
    const r = await recoverBagVersions(db.client, s.session, s.bag.id, {}, s.deps);
    expect(r).toMatchObject({ ok: false, error: 'NO_PROPOSAL', version: 2, txHash: txHash.toLowerCase() });
    expect(await state(s.bag.id)).toEqual({ currentVersion: 1, onChainVersion: 1, versions: 1 });
    // The pre-0059 repair path: confirm with the exact composition and that hash (checked on chain).
    expect(await confirmBagVersionUpdate(db.client, s.session, s.bag.id, weights(3000, 7000), txHash, 'repair', s.deps)).toMatchObject({ ok: false, error: 'VERIFICATION_FAILED' });
    const repaired = await confirmBagVersionUpdate(db.client, s.session, s.bag.id, weights(2500, 7500), txHash, 'repair', s.deps);
    expect(repaired).toMatchObject({ ok: true });
    expect(await state(s.bag.id)).toEqual({ currentVersion: 2, onChainVersion: 2, versions: 2 });
  });

  it('a proposal for other content, or one altered after prepare, is never used', async () => {
    const s = await deployedBag();
    // Two proposals on v1; the chain gets the second.
    const pA = await prepareBagVersionUpdate(db.client, s.session, s.bag.id, weights(5000, 5000), s.deps);
    if (!pA.ok) throw new Error('prepare');
    const { prepared: pB } = await s.prepareAndSend(weights(4000, 6000));
    // Tamper with B's stored recipe: it no longer hashes to what the chain recorded.
    await db.admin.query(`update bag_version_proposals set recipe = jsonb_set(recipe, '{assets,0,weightBps}', '4100') where id = $1`, [pB.proposalId]);
    const r = await recoverBagVersions(db.client, s.session, s.bag.id, {}, s.deps);
    expect(r).toMatchObject({ ok: false, error: 'NO_PROPOSAL', version: 2 });
    expect(await state(s.bag.id)).toEqual({ currentVersion: 1, onChainVersion: 1, versions: 1 });
    // Restored, it is recorded — and A, built on the same version, is superseded.
    await db.admin.query(`update bag_version_proposals set recipe = jsonb_set(recipe, '{assets,0,weightBps}', '4000') where id = $1`, [pB.proposalId]);
    expect(await recoverBagVersions(db.client, s.session, s.bag.id, {}, s.deps)).toMatchObject({ ok: true, inSync: true });
    const rows = await db.admin.query('select id, status from bag_version_proposals where bag_id = $1', [s.bag.id]);
    expect(Object.fromEntries(rows.rows.map((x: { id: string; status: string }) => [x.id, x.status]))).toEqual({ [pA.proposalId]: 'SUPERSEDED', [pB.proposalId]: 'RECORDED' });
  });

  it('concurrent proposals on one version: the one that lost on chain (StaleVersion) can never be recorded', async () => {
    const s = await deployedBag();
    const p1 = await prepareBagVersionUpdate(db.client, s.session, s.bag.id, weights(4000, 6000), s.deps);
    const p2 = await prepareBagVersionUpdate(db.client, s.session, s.bag.id, weights(5000, 5000), s.deps);
    if (!p1.ok || !p2.ok) throw new Error('prepare');
    await rpc('evm_setAutomine', [false]);
    let tx2: Hex;
    try {
      await s.user.sendTransaction({ to: p1.transaction.to, data: p1.transaction.data, gas: BigInt(500_000) });
      tx2 = await s.user.sendTransaction({ to: p2.transaction.to, data: p2.transaction.data, gas: BigInt(500_000) });
      await rpc('evm_mine');
    } finally {
      await rpc('evm_setAutomine', [true]);
    }
    expect((await publicClient.getTransactionReceipt({ hash: tx2 })).status).toBe('reverted');
    expect(await recoverBagVersions(db.client, s.session, s.bag.id, { txHash: tx2 }, s.deps)).toMatchObject({ ok: false, error: 'VERIFICATION_FAILED' });
    expect(await recoverBagVersions(db.client, s.session, s.bag.id, {}, s.deps)).toMatchObject({ ok: true, inSync: true });
    const v = (await db.admin.query('select recipe from bag_versions where bag_id = $1 and version = 2', [s.bag.id])).rows[0];
    expect(v.recipe.assets.map((a: { weightBps: number }) => a.weightBps)).toEqual([4000, 6000]);
    const st = await db.admin.query('select id, status from bag_version_proposals where bag_id = $1', [s.bag.id]);
    expect(Object.fromEntries(st.rows.map((x: { id: string; status: string }) => [x.id, x.status]))).toEqual({ [p1.proposalId]: 'RECORDED', [p2.proposalId]: 'SUPERSEDED' });
  });
});

describe('failures never write and never guess', () => {
  const broken = (base: BagVersionAdapter, over: Partial<BagVersionAdapter>): BagVersionAdapter => ({ ...base, ...over });

  it('RPC down: status and recovery report CHAIN_UNAVAILABLE', async () => {
    const s = await deployedBag();
    await s.prepareAndSend();
    const down = { resolveAdapter: () => broken(s.adapter, { readBagVersion: async () => Promise.reject(new Error('rpc down')) }) };
    expect(await getBagVersionStatus(db.client, s.session, s.bag.id, down)).toMatchObject({ ok: false, error: 'CHAIN_UNAVAILABLE' });
    expect(await recoverBagVersions(db.client, s.session, s.bag.id, {}, down)).toMatchObject({ ok: false, error: 'CHAIN_UNAVAILABLE' });
    const noLogs = { resolveAdapter: () => broken(s.adapter, { findVersionTransaction: async () => Promise.reject(new Error('logs down')) }) };
    expect(await recoverBagVersions(db.client, s.session, s.bag.id, {}, noLogs)).toMatchObject({ ok: false, error: 'CHAIN_UNAVAILABLE' });
    // Chain ahead but its log not found (e.g. an RPC that drops it): nothing written.
    const missing = { resolveAdapter: () => broken(s.adapter, { findVersionTransaction: async () => null }) };
    expect(await recoverBagVersions(db.client, s.session, s.bag.id, {}, missing)).toMatchObject({ ok: false, error: 'NOT_FOUND_ON_CHAIN', version: 2 });
    expect(await state(s.bag.id)).toEqual({ currentVersion: 1, onChainVersion: 1, versions: 1 });
  });

  it('a located log whose receipt does not verify is refused', async () => {
    const s = await deployedBag();
    await s.prepareAndSend();
    // Point the locator at the deployment transaction while claiming the proposal's hash/URI.
    const p = (await proposals(s.bag.id))[0];
    const lying = { resolveAdapter: () => broken(s.adapter, { findVersionTransaction: async () => ({ txHash: s.deployTx, compositionHash: p.onchain_composition_hash, metadataURI: versionMetadataURI(s.bag.id, 2) }) }) };
    expect(await recoverBagVersions(db.client, s.session, s.bag.id, {}, lying)).toMatchObject({ ok: false, error: 'VERIFICATION_FAILED' });
    expect(await state(s.bag.id)).toEqual({ currentVersion: 1, onChainVersion: 1, versions: 1 });
  });

  it('only the creator can check or recover', async () => {
    const s = await deployedBag();
    await s.prepareAndSend();
    const stranger = await insertUser(db, `0x${'7'.repeat(39)}${cursor}`);
    const sess = { userId: stranger, walletAddress: s.session.walletAddress };
    expect(await getBagVersionStatus(db.client, sess, s.bag.id, s.deps)).toEqual({ ok: false, error: 'FORBIDDEN' });
    expect(await recoverBagVersions(db.client, sess, s.bag.id, {}, s.deps)).toEqual({ ok: false, error: 'FORBIDDEN' });
    expect(await state(s.bag.id)).toEqual({ currentVersion: 1, onChainVersion: 1, versions: 1 });
  });

  it('the log search falls back to windows when the RPC refuses the whole range', async () => {
    const s = await deployedBag();
    const { txHash } = await s.prepareAndSend();
    let calls = 0;
    const picky = new Proxy(publicClient, {
      get(target, prop, recv) {
        if (prop === 'getLogs') {
          return async (args: unknown) => {
            calls++;
            if (calls === 1) throw new Error('query returned more than 10000 results / block range too large');
            return (target.getLogs as (a: unknown) => Promise<unknown>)(args);
          };
        }
        return Reflect.get(target, prop, recv);
      },
    }) as PublicClient;
    const adapter = createEvmBagVersionAdapter(configFor(s.factory.address), picky);
    const found = await adapter.findVersionTransaction(s.deployment.contractAddress as Hex, 2, BigInt(0));
    expect(found?.txHash.toLowerCase()).toBe(txHash.toLowerCase());
    expect(calls).toBeGreaterThan(1);
    expect(await adapter.findVersionTransaction(s.deployment.contractAddress as Hex, 3, BigInt(0))).toBeNull();
  });
});

describe('migration 0059 on an upgraded database', () => {
  it('proposals are saved, deduplicated and settled by the version insert', async () => {
    const u = await insertUser(upgraded, `0x${'5'.repeat(40)}`);
    const created = await createBag(upgraded.client, { slug: `up-${Date.now()}`, creatorId: u, mutability: 'MUTABLE', recipe: validRecipeInput(), reason: 't' });
    if (!created.ok) throw new Error(JSON.stringify(created));
    const bagId = created.bag.id;
    const save = (hash: string, block: number) =>
      upgraded.service.query(
        `select save_bag_version_proposal($1, $2, $3, 'robinhood', 31337, $4, $5, $6, 1, 'c', $7, $8, '{"assets":[]}'::jsonb, 'r', $9) as id`,
        [bagId, u, `0x${'5'.repeat(40)}`, `0x${'f'.repeat(40)}`, `0x${'b'.repeat(40)}`, `0x${'d'.repeat(64)}`, hash, versionMetadataURI(bagId, 2), block]
      );
    const h1 = `0x${'01'.repeat(32)}`;
    const h2 = `0x${'02'.repeat(32)}`;
    const a = (await save(h1, 10)).rows[0].id;
    expect((await save(h1, 5)).rows[0].id).toBe(a);
    const b = (await save(h2, 7)).rows[0].id;
    expect((await upgraded.admin.query('select prepared_block from bag_version_proposals where id = $1', [a])).rows[0].prepared_block).toBe(10);
    // Same key, different body: refused, the stored proposal untouched.
    await expect(
      upgraded.service.query(
        `select save_bag_version_proposal($1, $2, $3, 'robinhood', 31337, $4, $5, $6, 1, 'c', $7, $8, '{"assets":[],"performanceFeeBps":1}'::jsonb, 'r', 1)`,
        [bagId, u, `0x${'5'.repeat(40)}`, `0x${'f'.repeat(40)}`, `0x${'b'.repeat(40)}`, `0x${'d'.repeat(64)}`, h1, versionMetadataURI(bagId, 2)]
      )
    ).rejects.toThrow(/BAG_VERSION_PROPOSAL_CONFLICT/);
    expect((await upgraded.admin.query('select recipe from bag_version_proposals where id = $1', [a])).rows[0].recipe).toEqual({ assets: [] });

    const tx = `0x${'0a'.repeat(32)}`;
    await upgraded.admin.query(
      `insert into bag_versions (bag_id, version, composition_hash, recipe, created_by, reason, onchain_tx_hash, onchain_version, onchain_composition_hash, metadata_uri)
       values ($1, 2, 'c', '{}'::jsonb, $2, 'r', $3, 2, $4, $5)`,
      [bagId, u, tx, h1, versionMetadataURI(bagId, 2)]
    );
    const rows = await upgraded.admin.query('select id, status, tx_hash from bag_version_proposals where bag_id = $1', [bagId]);
    expect(Object.fromEntries(rows.rows.map((x: { id: string; status: string }) => [x.id, x.status]))).toEqual({ [a]: 'RECORDED', [b]: 'SUPERSEDED' });
    // A browser role cannot read proposals.
    for (const role of ['anon', 'authenticated']) {
      const exists = (await upgraded.admin.query('select 1 from pg_roles where rolname = $1', [role])).rowCount;
      if (exists) expect((await upgraded.admin.query(`select has_table_privilege($1, 'bag_version_proposals', 'select') as p`, [role])).rows[0].p).toBe(false);
    }
  });
});

describe('one on-chain composition = one recipe (proposal body conflicts)', () => {
  /** Calls save_bag_version_proposal as the service role, with a stored proposal's identity and the given body. */
  const saveRaw = (row: Record<string, unknown>, recipe: unknown, reason = 'x') =>
    db.service.query(
      `select save_bag_version_proposal($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $15) as id`,
      [row.bag_id, row.creator_id, row.wallet, row.chain, row.chain_id, row.factory_address, row.contract_address, row.on_chain_bag_id, row.expected_onchain_version, row.composition_hash, row.onchain_composition_hash, row.metadata_uri, JSON.stringify(recipe), reason, row.prepared_block]
    );
  const fullRow = async (id: string) => (await db.admin.query('select * from bag_version_proposals where id = $1', [id])).rows[0];

  it('same composition, different performance fee: refused by the API and by the database; the proposal is unchanged', async () => {
    const s = await deployedBag();
    const p = await prepareBagVersionUpdate(db.client, s.session, s.bag.id, weights(4000, 6000), s.deps);
    if (!p.ok) throw new Error(JSON.stringify(p));
    const before = await fullRow(p.proposalId);

    expect(await prepareBagVersionUpdate(db.client, s.session, s.bag.id, { ...weights(4000, 6000), performanceFeeBps: 1500 }, s.deps)).toEqual({ ok: false, error: 'IMMUTABLE_FIELD', fields: ['performanceFeeBps'] });
    // Even bypassing the API (a direct service-role call), the database refuses to replace the body.
    await expect(saveRaw(before, { ...before.recipe, performanceFeeBps: 1500 })).rejects.toThrow(/BAG_VERSION_PROPOSAL_CONFLICT/);
    expect(await fullRow(p.proposalId)).toEqual(before);
    expect((await proposals(s.bag.id)).length).toBe(1);
  });

  it('same composition, different rules (or name, or minimum): IMMUTABLE_FIELD from the API, conflict from the database', async () => {
    const s = await deployedBag();
    const p = await prepareBagVersionUpdate(db.client, s.session, s.bag.id, weights(4000, 6000), s.deps);
    if (!p.ok) throw new Error(JSON.stringify(p));
    const before = await fullRow(p.proposalId);
    const rule = { ...before.recipe.rebalanceRule, driftThresholdBps: before.recipe.rebalanceRule.driftThresholdBps + 100 };
    expect(await prepareBagVersionUpdate(db.client, s.session, s.bag.id, { ...weights(4000, 6000), rebalanceRule: rule }, s.deps)).toMatchObject({ ok: false, error: 'IMMUTABLE_FIELD', fields: ['rebalanceRule'] });
    expect(await prepareBagVersionUpdate(db.client, s.session, s.bag.id, { ...weights(4000, 6000), name: 'Renamed', minInvestment: 1 }, s.deps)).toMatchObject({ ok: false, error: 'IMMUTABLE_FIELD', fields: ['minInvestment', 'name'] });
    // Also refused through confirm (the same derivation), so no transaction can record a different body.
    expect(await confirmBagVersionUpdate(db.client, s.session, s.bag.id, { ...weights(4000, 6000), rebalanceRule: rule }, `0x${'ee'.repeat(32)}`, 'x', s.deps)).toMatchObject({ ok: false, error: 'IMMUTABLE_FIELD' });
    await expect(saveRaw(before, { ...before.recipe, rebalanceRule: rule })).rejects.toThrow(/BAG_VERSION_PROPOSAL_CONFLICT/);
    // A different identity field on the same key (another wallet) is a conflict too.
    await expect(saveRaw({ ...before, wallet: `0x${'4'.repeat(40)}` }, before.recipe)).rejects.toThrow(/BAG_VERSION_PROPOSAL_CONFLICT/);
    expect(await fullRow(p.proposalId)).toEqual(before);
  });

  it('a whole legacy recipe equal to the current version (bar the assets) is accepted and yields the same proposal', async () => {
    const s = await deployedBag();
    const current = (await db.admin.query('select recipe from bag_versions where id = (select current_version_id from bags where id = $1)', [s.bag.id])).rows[0].recipe;
    const { id: _i, bagId: _b, version: _v, createdAt: _c, ...legacy } = current;
    void _i;
    void _b;
    void _v;
    void _c;
    const a = await prepareBagVersionUpdate(db.client, s.session, s.bag.id, { ...legacy, assets: weights(4000, 6000).assets }, s.deps);
    const b = await prepareBagVersionUpdate(db.client, s.session, s.bag.id, weights(4000, 6000), s.deps);
    if (!a.ok || !b.ok) throw new Error(JSON.stringify([a, b]));
    expect(a.proposalId).toBe(b.proposalId);
    // Asset order does not matter (the body is canonical), nor do extra client keys on an asset.
    const reversed = { assets: [...weights(4000, 6000).assets].reverse().map((x) => ({ ...x, logo: 'https://evil.example/x.png' })) } as unknown as VersionChange;
    const c = await prepareBagVersionUpdate(db.client, s.session, s.bag.id, reversed, s.deps);
    if (!c.ok) throw new Error(JSON.stringify(c));
    expect(c.proposalId).toBe(a.proposalId);
    expect(JSON.stringify((await fullRow(a.proposalId)).recipe)).not.toContain('evil');
  });

  it('an identical prepare is idempotent: same id, row untouched', async () => {
    const s = await deployedBag();
    const p = await prepareBagVersionUpdate(db.client, s.session, s.bag.id, weights(4000, 6000), s.deps, 'first');
    if (!p.ok) throw new Error(JSON.stringify(p));
    const before = await fullRow(p.proposalId);
    await rpc('evm_mine');
    for (let i = 0; i < 3; i++) {
      const again = await prepareBagVersionUpdate(db.client, s.session, s.bag.id, weights(4000, 6000), s.deps, 'first');
      expect(again).toMatchObject({ ok: true, proposalId: p.proposalId, transaction: p.ok ? p.transaction : undefined });
    }
    expect(await fullRow(p.proposalId)).toEqual(before);
  });

  it('concurrent prepares: identical ones share one row; different bodies for one key → exactly one accepted', async () => {
    const s = await deployedBag();
    const same = await Promise.all(Array.from({ length: 8 }, () => prepareBagVersionUpdate(db.client, s.session, s.bag.id, weights(4000, 6000), s.deps)));
    expect(same.every((r) => r.ok)).toBe(true);
    expect(new Set(same.map((r) => (r.ok ? r.proposalId : '')))).toHaveProperty('size', 1);

    // Different bodies racing on a fresh key, straight at the database (the API cannot even produce them).
    const template = await fullRow(same[0].ok ? same[0].proposalId : '');
    const key = { ...template, onchain_composition_hash: `0x${'c3'.repeat(32)}` };
    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => saveRaw(key, { ...template.recipe, minInvestment: 1000 + i })));
    const accepted = results.filter((r) => r.status === 'fulfilled');
    expect(accepted).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected').every((r) => /BAG_VERSION_PROPOSAL_CONFLICT/.test(String((r as PromiseRejectedResult).reason)))).toBe(true);
    const rows = (await db.admin.query(`select recipe from bag_version_proposals where bag_id = $1 and onchain_composition_hash = $2`, [s.bag.id, key.onchain_composition_hash])).rows;
    expect(rows).toHaveLength(1);
  });

  it('what is recorded (confirm or recovery) is exactly the server-validated body; the replaced version and every other field stay as they were', async () => {
    for (const path of ['confirm', 'recovery'] as const) {
      const s = await deployedBag();
      const v1Before = (await db.admin.query('select * from bag_versions where bag_id = $1 and version = 1', [s.bag.id])).rows[0];
      const { prepared, txHash } = await s.prepareAndSend(weights(4000, 6000));
      const proposal = await fullRow(prepared.proposalId);
      const r =
        path === 'confirm'
          ? await confirmBagVersionUpdate(db.client, s.session, s.bag.id, weights(4000, 6000), txHash, 'edit', s.deps)
          : await recoverBagVersions(db.client, s.session, s.bag.id, {}, s.deps);
      expect(r.ok).toBe(true);
      const v2 = (await db.admin.query('select recipe from bag_versions where bag_id = $1 and version = 2', [s.bag.id])).rows[0].recipe;
      const { id: _i, version: _v, createdAt: _c, ...recorded } = v2;
      void _i;
      void _v;
      void _c;
      expect(sameBody(recorded, proposal.recipe)).toBe(true);
      // Only the assets differ from v1.
      const strip = (x: Record<string, unknown>) => {
        const { id: _a, version: _b, createdAt: _d, assets: _e, ...rest } = x;
        void _a;
        void _b;
        void _d;
        void _e;
        return rest;
      };
      expect(strip(v2)).toEqual(strip(v1Before.recipe));
      expect(v2.assets.map((a: { weightBps: number }) => a.weightBps)).toEqual([4000, 6000]);
      // v1 itself untouched.
      expect((await db.admin.query('select * from bag_versions where bag_id = $1 and version = 1', [s.bag.id])).rows[0]).toEqual(v1Before);
    }
  });

  it('recovery refuses a proposal whose stored body was changed to differ from the derived one, even with matching hashes', async () => {
    const s = await deployedBag();
    const { prepared } = await s.prepareAndSend(weights(4000, 6000));
    // Hashes cover only the assets: altering a non-asset field keeps them valid, but the body no longer derives.
    await db.admin.query(`update bag_version_proposals set recipe = recipe || '{"performanceFeeBps": 1999}'::jsonb where id = $1`, [prepared.proposalId]);
    expect(await recoverBagVersions(db.client, s.session, s.bag.id, {}, s.deps)).toMatchObject({ ok: false, error: 'NO_PROPOSAL' });
    expect(await state(s.bag.id)).toEqual({ currentVersion: 1, onChainVersion: 1, versions: 1 });
  });
});
