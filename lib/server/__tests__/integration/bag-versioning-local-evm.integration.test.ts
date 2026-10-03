import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { network } from 'hardhat';
import { decodeEventLog, type Hex, type PublicClient } from 'viem';
import { createEvmBagDeploymentAdapter } from '@/lib/blockchain/evm/adapter';
import { createEvmBagVersionAdapter } from '@/lib/blockchain/evm/version-adapter';
import type { EvmChainConfig } from '@/lib/blockchain/evm/config';
import { bagFactoryAbi } from '@/lib/blockchain/evm/factory-abi';
import { computeOnChainBagId, computeOnChainCompositionHash } from '@/lib/domain/basket-protocol/onchain';
import { confirmBagDeployment, prepareBagDeployment } from '@/lib/server/deploy-bag';
import { confirmBagVersionUpdate, prepareBagVersionUpdate, versionMetadataURI } from '@/lib/server/bag-versioning';
import { createBag, createBagVersion } from '@/lib/server/bag-repo';
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

/** Swapped weights → a different composition (and composition hash) than validRecipeInput(). */
function otherRecipe(feeBps?: number) {
  const r = validRecipeInput(feeBps === undefined ? {} : { performanceFeeBps: feeBps });
  const assets = r.assets.map((a) => ({ ...a }));
  [assets[0].weightBps, assets[1].weightBps] = [assets[1].weightBps, assets[0].weightBps];
  return { ...r, assets };
}

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
    const b = await s.prepareAndSend(validRecipeInput());
    expect(b.prepared).toMatchObject({ expectedCurrentOnChainVersion: 2, newOnChainVersion: 3, newDbVersion: 3 });
    expect((await s.confirm(b.txHash, validRecipeInput())).ok).toBe(true);
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
    await expect(db.service.query(`select create_bag_version($1, 'h', $2::jsonb, $3, 'x')`, [s.bag.id, JSON.stringify(otherRecipe()), s.userId])).rejects.toThrow(/IMMUTABLE_BAG/);
    expect(await s.bagContract.read.version()).toBe(BigInt(1));
  });

  it('a DEPLOYED Bag can no longer be versioned off-chain only (the database would move ahead of the chain)', async () => {
    const s = await deployedBag();
    expect(await createBagVersion(db.client, { bagId: s.bag.id, createdBy: s.userId, reason: 'x', recipe: otherRecipe() })).toEqual({ ok: false, error: 'DEPLOYED_BAG_REQUIRES_ONCHAIN_VERSION' });
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
    const p2 = await prepareBagVersionUpdate(db.client, s.session, s.bag.id, otherRecipe(500), s.deps);
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
    const [r1, r2] = await Promise.all([s.confirm(tx1, otherRecipe()), s.confirm(tx2, otherRecipe(500))]);
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
        [s.bag.id, s.userId, s.deployment.factoryAddress, s.deployment.contractAddress, s.deployment.onChainBagId, `0x${'11'.repeat(32)}`, JSON.stringify(otherRecipe()), `0x${'22'.repeat(32)}`]
      )
    ).rows[0].r;
    expect(r).toMatchObject({ outcome: 'STALE_VERSION', onChainVersion: 2 });
  });
});

describe('interaction with the performance-fee lock', () => {
  it('prepare refuses a fee change once the fee is locked', async () => {
    const s = await deployedBag();
    const investor = await newWallet(db);
    await purchase(db, { ...investor, bagId: s.bag.id, sharesRaw: '1000', costBasis: '1' });
    expect(await prepareBagVersionUpdate(db.client, s.session, s.bag.id, otherRecipe(2500), s.deps)).toMatchObject({ ok: false, error: 'PERFORMANCE_FEE_LOCKED' });
  });

  it('RACE: the fee locks between prepare and confirm — the mined version is still recorded (chain and DB stay in sync) with the LOCKED fee, flagged', async () => {
    const s = await deployedBag();
    const lockedAt = validRecipeInput().performanceFeeBps ?? 0;
    const { txHash } = await s.prepareAndSend(otherRecipe(lockedAt + 500));
    const investor = await newWallet(db);
    await purchase(db, { ...investor, bagId: s.bag.id, sharesRaw: '1000', costBasis: '1' }); // locks at lockedAt
    const r = await s.confirm(txHash, otherRecipe(lockedAt + 500));
    if (!r.ok) throw new Error(JSON.stringify(r));
    expect(r.feeLockedOverride).toBe(true);
    expect(r.version?.recipe.performanceFeeBps).toBe(lockedAt);
    expect(await dbState(s.bag.id)).toMatchObject({ currentVersion: 2, onChainVersion: 2 });
  });
});
