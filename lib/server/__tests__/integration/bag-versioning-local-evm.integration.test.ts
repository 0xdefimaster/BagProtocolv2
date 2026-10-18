import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { network } from 'hardhat';
import { decodeEventLog, type Hex, type PublicClient } from 'viem';
import { createEvmBagDeploymentAdapter } from '@/lib/blockchain/evm/adapter';
import { createEvmBagVersionAdapter } from '@/lib/blockchain/evm/version-adapter';
import type { EvmChainConfig } from '@/lib/blockchain/evm/config';
import { bagFactoryAbi } from '@/lib/blockchain/evm/factory-abi';
import { computeOnChainBagId, computeOnChainCompositionHash } from '@/lib/domain/basket-protocol/onchain';
import { confirmBagDeployment, prepareBagDeployment } from '@/lib/server/deploy-bag';
import { confirmBagVersionUpdate, prepareBagVersionUpdate, versionMetadataURI, type VersionChange } from '@/lib/server/bag-versioning';
import { createBag, createBagVersion } from '@/lib/server/bag-repo';
import { buildEditedRecipe } from '@/lib/server/strategy-edit';
import type { CanonicalAsset } from '@/types/basket-protocol';
import { TestDatabase, createTestDatabase, validRecipeInput } from './pg-harness';
import { newWallet, purchase } from './economics-harness';

// -----------------------------------------------------------------------------
// MUTABLE BAG VERSIONING, END TO END — real PostgreSQL + real BagFactory/Bag on
// Hardhat's in-process EVM + the real read-only adapters + the real server
// orchestration. The creator's own wallet signs every transaction; the server
// only prepares calldata and verifies receipts. NOT a real-network test.
// -----------------------------------------------------------------------------

let db: TestDatabase;
let viem: Awaited<ReturnType<typeof network.connect>>['viem'];
let publicClient: PublicClient;

beforeAll(async () => {
  db = await createTestDatabase({ mode: 'fresh' });
  viem = (await network.connect()).viem;
  publicClient = (await viem.getPublicClient()) as unknown as PublicClient;
});
afterAll(async () => {
  await db?.drop();
});

const rpc = (method: string, params: unknown[] = []) => (publicClient as unknown as { request: (a: { method: string; params: unknown[] }) => Promise<unknown> }).request({ method, params });

function configFor(factoryAddress: Hex, over: Partial<EvmChainConfig> = {}): EvmChainConfig {
  return {
    chain: 'robinhood',
    viemChain: { id: 31337, name: 'Hardhat (local)', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [] } } } as unknown as EvmChainConfig['viemChain'],
    rpcUrl: 'in-process',
    factoryAddress,
    confirmations: 1,
    receiptTimeoutMs: 1200,
    ...over,
  };
}

/** Swapped weights → a different composition (and composition hash) than validRecipeInput(). A whole recipe, for off-chain paths. */
function otherFullRecipe() {
  const r = validRecipeInput();
  const assets = r.assets.map((a) => ({ ...a }));
  [assets[0].weightBps, assets[1].weightBps] = [assets[1].weightBps, assets[0].weightBps];
  return { ...r, assets };
}
/** A version update changes only the assets (everything else comes from the current version). */
function otherRecipe(): VersionChange {
  return { assets: otherFullRecipe().assets };
}
const baseChange = (): VersionChange => ({ assets: validRecipeInput().assets });
const evenChange = (): VersionChange => ({ assets: validRecipeInput().assets.map((a) => ({ ...a, weightBps: 5000 })) });

let cursor = 0;
async function deployedBag(opts: { mutability?: 'MUTABLE' | 'IMMUTABLE' } = {}) {
  const wallets = await viem.getWalletClients();
  const user = wallets[cursor++ % wallets.length];
  const stranger = wallets[cursor++ % wallets.length];
  const factory = await viem.deployContract('BagFactory', [user.account.address, user.account.address, BigInt(0), BigInt(0)]);
  const config = configFor(factory.address);
  const deployAdapter = createEvmBagDeploymentAdapter(config, publicClient);
  const versionAdapter = createEvmBagVersionAdapter(config, publicClient);
  const wallet = user.account.address.toLowerCase();
  const userId = (await db.admin.query('insert into users (wallet_address) values ($1) on conflict (wallet_address) do update set wallet_address = excluded.wallet_address returning id', [wallet])).rows[0].id as string;
  const created = await createBag(db.client, { slug: `ver-${Date.now()}-${cursor}`, creatorId: userId, mutability: opts.mutability ?? 'MUTABLE', recipe: validRecipeInput(), reason: 't' });
  if (!created.ok) throw new Error(JSON.stringify(created));
  const bag = created.bag;
  const session = { userId, walletAddress: wallet };
  const prepared = await prepareBagDeployment(db.client, session, bag.id, { resolveAdapter: () => deployAdapter });
  if (!prepared.ok) throw new Error(JSON.stringify(prepared));
  const deployTx = await user.sendTransaction({ to: prepared.transaction.to as Hex, data: prepared.transaction.data });
  const confirmed = await confirmBagDeployment(db.client, session, bag.id, deployTx, { resolveAdapter: () => deployAdapter });
  if (!confirmed.ok) throw new Error(JSON.stringify(confirmed));
  const bagContract = await viem.getContractAt('Bag', confirmed.deployment.contractAddress as Hex);
  const deps = { resolveAdapter: () => versionAdapter };
  /** prepare → the creator's OWN wallet signs and sends. */
  const prepareAndSend = async (recipe = otherRecipe(), from = user) => {
    const p = await prepareBagVersionUpdate(db.client, session, bag.id, recipe, deps);
    if (!p.ok) throw new Error(`prepare failed: ${JSON.stringify(p)}`);
    return { prepared: p, txHash: await from.sendTransaction({ to: p.transaction.to, data: p.transaction.data }) };
  };
  const confirm = (txHash: string, recipe = otherRecipe()) => confirmBagVersionUpdate(db.client, session, bag.id, recipe, txHash, 'test update', deps);
  return { user, stranger, factory, bag, session, deps, deployTx, deployment: confirmed.deployment, bagContract, prepareAndSend, confirm, userId };
}

const dbState = async (bagId: string) => {
  const b = (await db.admin.query('select current_version, current_version_id from bags where id = $1', [bagId])).rows[0];
  const d = (await db.admin.query(`select on_chain_version from bag_deployments where bag_id = $1 and status = 'DEPLOYED'`, [bagId])).rows[0];
  const n = (await db.admin.query('select count(*)::int as n from bag_versions where bag_id = $1', [bagId])).rows[0].n;
  return { currentVersion: b.current_version as number, currentVersionId: b.current_version_id as string, onChainVersion: d.on_chain_version as number, versions: n as number };
};

describe('creator version update — happy path', () => {
  it('prepare → creator signs → confirm verifies the receipt → DB version, deployment version and chain all advance together', async () => {
    const s = await deployedBag();
    const before = await dbState(s.bag.id);
    expect(before.onChainVersion).toBe(1);

    const { prepared, txHash } = await s.prepareAndSend();
    expect(prepared).toMatchObject({ expectedCurrentOnChainVersion: 1, newOnChainVersion: 2, newDbVersion: 2 });
    expect(await dbState(s.bag.id)).toEqual(before); // signed + mined, not yet confirmed: NOTHING written

    const r = await s.confirm(txHash);
    if (!r.ok) throw new Error(JSON.stringify(r));
    expect(r).toMatchObject({ alreadyConfirmed: false, feeLockedOverride: false });
    expect(await dbState(s.bag.id)).toMatchObject({ currentVersion: 2, onChainVersion: 2, versions: 2 });

    // Chain state: version, composition hash and metadata URI all updated — and equal to what the DB recorded.
    const expectedHash = computeOnChainCompositionHash(otherRecipe().assets);
    expect(await s.bagContract.read.version()).toBe(BigInt(2));
    expect(await s.bagContract.read.compositionHash()).toBe(expectedHash);
    expect(await s.bagContract.read.metadataURI()).toBe(versionMetadataURI(s.bag.id, 2));
    const row = (await db.admin.query('select onchain_tx_hash, onchain_version, onchain_composition_hash, metadata_uri from bag_versions where id = $1', [r.version!.id])).rows[0];
    expect(row).toEqual({ onchain_tx_hash: txHash.toLowerCase(), onchain_version: 2, onchain_composition_hash: expectedHash, metadata_uri: versionMetadataURI(s.bag.id, 2) });

    // Exactly one BagVersionRecorded in the receipt.
    const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
    const events = receipt.logs
      .filter((l) => l.address.toLowerCase() === s.factory.address.toLowerCase())
      .map((l) => decodeEventLog({ abi: bagFactoryAbi, data: l.data, topics: l.topics }))
      .filter((e) => e.eventName === 'BagVersionRecorded');
    expect(events).toHaveLength(1);
  });

  it('versions keep incrementing (1 → 2 → 3), each change needs its own signed transaction', async () => {
    const s = await deployedBag();
    const a = await s.prepareAndSend(otherRecipe());
    expect((await s.confirm(a.txHash, otherRecipe())).ok).toBe(true);
    const b = await s.prepareAndSend(baseChange());
    expect(b.prepared).toMatchObject({ expectedCurrentOnChainVersion: 2, newOnChainVersion: 3, newDbVersion: 3 });
    expect((await s.confirm(b.txHash, baseChange())).ok).toBe(true);
    expect(await dbState(s.bag.id)).toMatchObject({ currentVersion: 3, onChainVersion: 3 });
    expect(await s.bagContract.read.version()).toBe(BigInt(3));
    expect(await s.bagContract.read.compositionHash()).toBe(computeOnChainCompositionHash(validRecipeInput().assets));
  });

  it('a repeated confirm of the same transaction is idempotent — one version row', async () => {
    const s = await deployedBag();
    const { txHash } = await s.prepareAndSend();
    expect((await s.confirm(txHash)).ok).toBe(true);
    expect(await s.confirm(txHash)).toMatchObject({ ok: true, alreadyConfirmed: true });
    expect(await dbState(s.bag.id)).toMatchObject({ currentVersion: 2, versions: 2 });
  });
});

describe('who may update', () => {
  it('NON-CREATOR: another user is FORBIDDEN at prepare and confirm; the chain refuses their wallet too', async () => {
    const s = await deployedBag();
    const other = await newWallet(db);
    const asOther = { userId: other.userId, walletAddress: other.wallet };
    expect(await prepareBagVersionUpdate(db.client, asOther, s.bag.id, otherRecipe(), s.deps)).toEqual({ ok: false, error: 'FORBIDDEN' });

    // The stranger's wallet replays the creator's exact calldata: the factory derives a different bagId from msg.sender → UnknownBag.
    const p = await prepareBagVersionUpdate(db.client, s.session, s.bag.id, otherRecipe(), s.deps);
    if (!p.ok) throw new Error('prepare');
    await expect(s.stranger.sendTransaction({ to: p.transaction.to, data: p.transaction.data })).rejects.toThrow(/UnknownBag/);
    expect(await s.bagContract.read.version()).toBe(BigInt(1));
    expect(await dbState(s.bag.id)).toMatchObject({ currentVersion: 1, onChainVersion: 1 });
  });

  it('IMMUTABLE Bag: prepare refuses, the database refuses, and the contract itself reverts', async () => {
    const s = await deployedBag({ mutability: 'IMMUTABLE' });
    expect(await s.bagContract.read.isMutable()).toBe(false);
    expect(await prepareBagVersionUpdate(db.client, s.session, s.bag.id, otherRecipe(), s.deps)).toEqual({ ok: false, error: 'IMMUTABLE_BAG' });
    const f = await viem.getContractAt('BagFactory', s.factory.address, { client: { wallet: s.user } });
    await expect(f.write.recordBagVersion([computeOnChainBagId(s.bag.id), BigInt(1), computeOnChainCompositionHash(otherRecipe().assets), 'x'])).rejects.toThrow(/ImmutableBag/);
    await expect(db.service.query(`select create_bag_version($1, 'h', $2::jsonb, $3, 'x')`, [s.bag.id, JSON.stringify(otherFullRecipe()), s.userId])).rejects.toThrow(/IMMUTABLE_BAG/);
    expect(await s.bagContract.read.version()).toBe(BigInt(1));
  });

  it('a DEPLOYED Bag can no longer be versioned off-chain only (the database would move ahead of the chain)', async () => {
    const s = await deployedBag();
    expect(await createBagVersion(db.client, { bagId: s.bag.id, createdBy: s.userId, reason: 'x', recipe: otherFullRecipe() })).toEqual({ ok: false, error: 'DEPLOYED_BAG_REQUIRES_ONCHAIN_VERSION' });
  });
});

describe('the database changes ONLY after a matching, successful receipt', () => {
  it('PENDING (un-mined) → nothing written; once mined the same confirm succeeds', async () => {
    const s = await deployedBag();
    await rpc('evm_setAutomine', [false]);
    let txHash: Hex;
    try {
      txHash = (await s.prepareAndSend()).txHash;
      expect(await s.confirm(txHash)).toMatchObject({ ok: false, error: 'PENDING' });
      expect(await dbState(s.bag.id)).toMatchObject({ currentVersion: 1, onChainVersion: 1 });
      await rpc('evm_mine');
    } finally {
      await rpc('evm_setAutomine', [true]);
    }
    expect((await s.confirm(txHash)).ok).toBe(true);
  });

  it('WRONG RECEIPT: the deployment tx (no BagVersionRecorded) is rejected and nothing changes', async () => {
    const s = await deployedBag();
    const r = await s.confirm(s.deployTx);
    expect(r).toMatchObject({ ok: false, error: 'VERIFICATION_FAILED' });
    expect(await dbState(s.bag.id)).toMatchObject({ currentVersion: 1, onChainVersion: 1, versions: 1 });
  });

  it('WRONG RECIPE: confirming with a recipe other than the one signed on-chain fails the composition-hash check', async () => {
    const s = await deployedBag();
    const { txHash } = await s.prepareAndSend(otherRecipe());
    const tampered = otherRecipe();
    tampered.assets = tampered.assets.map((a, i) => ({ ...a, weightBps: i === 0 ? a.weightBps - 100 : i === 1 ? a.weightBps + 100 : a.weightBps }));
    const r = await s.confirm(txHash, tampered);
    expect(r).toMatchObject({ ok: false, error: 'VERIFICATION_FAILED', message: expect.stringMatching(/compositionHash/) });
    expect(await dbState(s.bag.id)).toMatchObject({ currentVersion: 1, versions: 1 });
  });

  it('WRONG BAG: a genuine version tx for ANOTHER of the creator\'s Bags cannot advance this one', async () => {
    const a = await deployedBag();
    // Same creator wallet deploys a second Bag on the same factory is not possible via deployedBag(); use another deployed Bag's tx instead.
    const b = await deployedBag();
    const { txHash } = await b.prepareAndSend();
    const r = await confirmBagVersionUpdate(db.client, a.session, a.bag.id, otherRecipe(), txHash, 'x', a.deps);
    expect(r).toMatchObject({ ok: false });
    expect(await dbState(a.bag.id)).toMatchObject({ currentVersion: 1, versions: 1 });
  });
});

describe('concurrency', () => {
  it('8 CONCURRENT confirms of one transaction → one writer, one version row', async () => {
    const s = await deployedBag();
    const { txHash } = await s.prepareAndSend();
    const results = await Promise.all(Array.from({ length: 8 }, () => s.confirm(txHash)));
    expect(results.filter((r) => !r.ok)).toEqual([]);
    expect(results.filter((r) => r.ok && !r.alreadyConfirmed)).toHaveLength(1);
    expect(await dbState(s.bag.id)).toMatchObject({ currentVersion: 2, onChainVersion: 2, versions: 2 });
  });

  it('two updates prepared on the SAME version: the second reverts StaleVersion on-chain and can never be recorded', async () => {
    const s = await deployedBag();
    const p1 = await prepareBagVersionUpdate(db.client, s.session, s.bag.id, otherRecipe(), s.deps);
    const p2 = await prepareBagVersionUpdate(db.client, s.session, s.bag.id, evenChange(), s.deps);
    if (!p1.ok || !p2.ok) throw new Error('prepare');
    expect(p1.expectedCurrentOnChainVersion).toBe(p2.expectedCurrentOnChainVersion);
    await rpc('evm_setAutomine', [false]);
    let tx1: Hex, tx2: Hex;
    try {
      tx1 = await s.user.sendTransaction({ to: p1.transaction.to, data: p1.transaction.data, gas: BigInt(500_000) });
      tx2 = await s.user.sendTransaction({ to: p2.transaction.to, data: p2.transaction.data, gas: BigInt(500_000) });
      await rpc('evm_mine'); // same block, nonce order: tx1 lands, tx2 reverts StaleVersion
    } finally {
      await rpc('evm_setAutomine', [true]);
    }
    expect((await publicClient.getTransactionReceipt({ hash: tx2 })).status).toBe('reverted');
    const [r1, r2] = await Promise.all([s.confirm(tx1, otherRecipe()), s.confirm(tx2, evenChange())]);
    expect(r1.ok).toBe(true);
    expect(r2).toMatchObject({ ok: false, error: 'VERIFICATION_FAILED' });
    expect(await dbState(s.bag.id)).toMatchObject({ currentVersion: 2, onChainVersion: 2, versions: 2 });
  });

  it('the database compare-and-swap is independent of the chain: a stale expected version is refused', async () => {
    const s = await deployedBag();
    const { txHash } = await s.prepareAndSend();
    expect((await s.confirm(txHash)).ok).toBe(true);
    const r = (
      await db.service.query(
        `select record_onchain_bag_version($1, $2, $3, $4, $5, 1, 2, 'h', $6, 'u', $7::jsonb, $8, 'replay') as r`,
        [s.bag.id, s.userId, s.deployment.factoryAddress, s.deployment.contractAddress, s.deployment.onChainBagId, `0x${'11'.repeat(32)}`, JSON.stringify(otherFullRecipe()), `0x${'22'.repeat(32)}`]
      )
    ).rows[0].r;
    expect(r).toMatchObject({ outcome: 'STALE_VERSION', onChainVersion: 2 });
  });
});

describe('interaction with the performance-fee lock', () => {
  // The fee is not part of the on-chain composition hash, so a version update can no longer change it (only assets
  // and weights): it is always the current version's. See VersionChange in lib/server/bag-versioning.ts.
  it('a fee change (or any other non-asset field) through a version update is refused, locked or not', async () => {
    const s = await deployedBag();
    expect(await prepareBagVersionUpdate(db.client, s.session, s.bag.id, { ...otherRecipe(), performanceFeeBps: 2500 }, s.deps)).toEqual({ ok: false, error: 'IMMUTABLE_FIELD', fields: ['performanceFeeBps'] });
    const investor = await newWallet(db);
    await purchase(db, { ...investor, bagId: s.bag.id, sharesRaw: '1000', costBasis: '1' });
    expect(await prepareBagVersionUpdate(db.client, s.session, s.bag.id, { ...otherRecipe(), performanceFeeBps: 2500 }, s.deps)).toMatchObject({ ok: false, error: 'IMMUTABLE_FIELD' });
  });

  it('the fee locking between prepare and confirm changes nothing: the version keeps the current fee, no override', async () => {
    const s = await deployedBag();
    const currentFee = validRecipeInput().performanceFeeBps ?? 0;
    const { txHash } = await s.prepareAndSend(otherRecipe());
    const investor = await newWallet(db);
    await purchase(db, { ...investor, bagId: s.bag.id, sharesRaw: '1000', costBasis: '1' });
    const r = await s.confirm(txHash, otherRecipe());
    if (!r.ok) throw new Error(JSON.stringify(r));
    expect(r.feeLockedOverride).toBe(false);
    expect(r.version?.recipe.performanceFeeBps ?? 0).toBe(currentFee);
    expect(await dbState(s.bag.id)).toMatchObject({ currentVersion: 2, onChainVersion: 2 });
  });
});

describe('Edit strategy (composition body)', () => {
  // The shim has no PostgREST .or(); read the registry rows directly.
  const lookupAssets = async (_admin: unknown, ids: { chain: string; address: string }[]) =>
    (
      await db.admin.query(`select * from assets where (chain, address) in (select * from unnest($1::text[], $2::text[]))`, [ids.map((i) => i.chain), ids.map((i) => i.address.toLowerCase())])
    ).rows.map((r) => ({ chain: r.chain, address: r.address, symbol: r.symbol, decimals: r.decimals, name: r.name, status: r.status, assetType: r.asset_type }) as unknown as CanonicalAsset);

  it('only assets and weights change; name, rules and fee carry over; the Bag reads as v2', async () => {
    const s = await deployedBag();
    const current = (await db.admin.query('select recipe from bag_versions where id = (select current_version_id from bags where id = $1)', [s.bag.id])).rows[0].recipe;
    const newcomer = '0x44444444444444444444444444444444444444cc';
    await db.admin.query(`insert into assets (chain, address, symbol, decimals, name, status, asset_type) values ('robinhood', $1, 'SOLX', 18, 'Sol X', 'VERIFIED', 'crypto') on conflict do nothing`, [newcomer]);
    const edit = [
      { address: current.assets[0].address, weightBps: 5000 },
      { address: newcomer.toUpperCase().replace('0X', '0x'), weightBps: 5000 },
    ];

    const built = await buildEditedRecipe(db.client, s.bag.id, edit, { lookupAssets });
    if (!built.ok) throw new Error(JSON.stringify(built));
    const { txHash } = await s.prepareAndSend(built.recipe);
    // confirm rebuilds the recipe from the same body (as the route does) and must land on the same hash.
    const rebuilt = await buildEditedRecipe(db.client, s.bag.id, edit, { lookupAssets });
    if (!rebuilt.ok) throw new Error(JSON.stringify(rebuilt));
    const r = await s.confirm(txHash, rebuilt.recipe);
    if (!r.ok) throw new Error(JSON.stringify(r));

    const after = (await db.admin.query('select b.name, b.current_version, v.recipe from bags b join bag_versions v on v.id = b.current_version_id where b.id = $1', [s.bag.id])).rows[0];
    expect(after.current_version).toBe(2);
    expect(after.name).toBe(s.bag.name);
    expect(after.recipe.name).toBe(current.name);
    expect(after.recipe.rebalanceRule).toEqual(current.rebalanceRule);
    expect(after.recipe.performanceFeeBps ?? 0).toBe(current.performanceFeeBps ?? 0);
    expect(after.recipe.assets.map((a: { symbol: string; weightBps: number }) => [a.symbol, a.weightBps])).toEqual([
      [current.assets[0].symbol, 5000],
      ['SOLX', 5000],
    ]);
    expect(await s.bagContract.read.compositionHash()).toBe(computeOnChainCompositionHash(after.recipe.assets));
  });

  it('refuses an asset that is not VERIFIED on the Bag chain, a duplicate, and an unchanged composition', async () => {
    const s = await deployedBag();
    const current = (await db.admin.query('select recipe from bag_versions where id = (select current_version_id from bags where id = $1)', [s.bag.id])).rows[0].recipe;
    const unknown = await buildEditedRecipe(db.client, s.bag.id, [{ address: '0x55555555555555555555555555555555555555dd', weightBps: 10_000 }], { lookupAssets });
    expect(unknown).toMatchObject({ ok: false, error: 'VALIDATION_FAILED', issues: [{ code: 'UNVERIFIED_ASSET' }] });
    const dup = await buildEditedRecipe(
      db.client,
      s.bag.id,
      [
        { address: current.assets[0].address, weightBps: 5000 },
        { address: current.assets[0].address.toUpperCase().replace('0X', '0x'), weightBps: 5000 },
      ],
      { lookupAssets }
    );
    expect(dup).toMatchObject({ ok: false, error: 'VALIDATION_FAILED', issues: [{ code: 'DUPLICATE_ASSET' }] });
    const same = await buildEditedRecipe(db.client, s.bag.id, current.assets.map((a: { address: string; weightBps: number }) => ({ address: a.address, weightBps: a.weightBps })), { lookupAssets });
    if (!same.ok) throw new Error(JSON.stringify(same));
    expect(await prepareBagVersionUpdate(db.client, s.session, s.bag.id, same.recipe, s.deps)).toMatchObject({ ok: false, error: 'NO_CHANGE' });
  });
});
