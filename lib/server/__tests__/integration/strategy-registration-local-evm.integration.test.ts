import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { network } from 'hardhat';
import { type Hex, type PublicClient } from 'viem';
import { createBag, createBagVersion, createForkBag, getBagById } from '@/lib/server/bag-repo';
import { buildBagJson, loadStrategyVersionRows } from '@/lib/server/strategy-api';
import { confirmStrategyRegistration, getRegistrationStatus, prepareStrategyRegistration } from '@/lib/server/strategy-registration';
import { computeOnChainBagId } from '@/lib/domain/basket-protocol/onchain';
import { readRegistryRecord, registryStrategyId, verifyBagJsonCommitment } from '@/lib/domain/basket-protocol/strategy-registry';
import { compareComposition, definitionToAllocations, readOnchainComposition, toContractAllocations } from '@/lib/domain/basket-protocol/strategy-compositions';
import { TestDatabase, createTestDatabase, validRecipeInput } from './pg-harness';

// -----------------------------------------------------------------------------
// StrategyRegistry registration, END TO END — real PostgreSQL + the real
// StrategyRegistry on Hardhat's in-process EVM + the real server orchestration.
// The creator's own wallet signs every transaction; the server only prepares
// calldata and verifies receipts. Fork provenance: a fork registers against the
// exact parent version it was made from. NOT a real-network test.
// -----------------------------------------------------------------------------

let db: TestDatabase;
let viem: Awaited<ReturnType<typeof network.connect>>['viem'];
let publicClient: PublicClient;
let registry: Hex;
let compositions: Hex;

beforeAll(async () => {
  db = await createTestDatabase({ mode: 'fresh' });
  viem = (await network.connect()).viem;
  publicClient = (await viem.getPublicClient()) as unknown as PublicClient;
  registry = (await viem.deployContract('StrategyRegistry', [])).address;
  compositions = (await viem.deployContract('StrategyCompositions', [registry])).address;
});
afterAll(async () => {
  await db?.drop();
});

/** Swapped weights → a different composition (a real new version). */
function otherRecipe() {
  const r = validRecipeInput();
  const assets = r.assets.map((a) => ({ ...a }));
  [assets[0].weightBps, assets[1].weightBps] = [assets[1].weightBps, assets[0].weightBps];
  return { ...r, assets };
}

const deps = () => ({ client: publicClient, registryAddress: registry, timeoutMs: 1200 });
let cursor = 0;

async function creator() {
  const wallets = await viem.getWalletClients();
  const w = wallets[cursor++ % wallets.length];
  const wallet = w.account.address.toLowerCase();
  const userId = (await db.admin.query('insert into users (wallet_address) values ($1) on conflict (wallet_address) do update set wallet_address = excluded.wallet_address returning id', [wallet])).rows[0].id as string;
  return { w, session: { userId, walletAddress: wallet } };
}

async function strategy(c: Awaited<ReturnType<typeof creator>>) {
  const created = await createBag(db.client, { slug: `reg-${Date.now()}-${cursor++}`, creatorId: c.session.userId, mutability: 'MUTABLE', recipe: validRecipeInput(), reason: 't' });
  if (!created.ok) throw new Error(JSON.stringify(created));
  return created.bag;
}

/** prepare → the creator's OWN wallet signs and sends → confirm. */
async function registerNext(c: Awaited<ReturnType<typeof creator>>, bagId: string) {
  const prepared = await prepareStrategyRegistration(db.client, c.session, bagId, deps());
  if (!prepared.ok) throw new Error(JSON.stringify(prepared));
  const txHash = await c.w.sendTransaction({ to: prepared.transaction.to, data: prepared.transaction.data });
  return { prepared, txHash, confirmed: await confirmStrategyRegistration(db.client, c.session, bagId, txHash, deps()) };
}

async function bagJson(bagId: string, version: number) {
  const record = (await getBagById(db.client, bagId))!;
  const row = (await loadStrategyVersionRows(db.client, bagId)).find((r) => r.version === version)!;
  return buildBagJson(record, row);
}

describe('StrategyRegistry registration (user-signed)', () => {
  it('register v1 → publish v2: recorded only after receipt verification; bag.json shows REGISTERED; a third party verifies on-chain', async () => {
    const c = await creator();
    const bag = await strategy(c);

    const first = await registerNext(c, bag.id);
    expect(first.prepared).toMatchObject({ kind: 'REGISTER', registryStrategyId: registryStrategyId(c.session.walletAddress, bag.id), fork: null });
    expect(first.confirmed).toMatchObject({ ok: true, alreadyRecorded: false });

    const v2 = await createBagVersion(db.client, { bagId: bag.id, createdBy: c.session.userId, reason: 'v2', recipe: otherRecipe() });
    if (!v2.ok) throw new Error(JSON.stringify(v2));
    const second = await registerNext(c, bag.id);
    expect(second.prepared).toMatchObject({ kind: 'PUBLISH_VERSIONS', covers: [{ version: 2 }] });
    expect(second.confirmed).toMatchObject({ ok: true });
    expect(await prepareStrategyRegistration(db.client, c.session, bag.id, deps())).toEqual({ ok: false, error: 'NOTHING_TO_REGISTER' });

    for (const version of [1, 2]) {
      const doc = await bagJson(bag.id, version);
      expect(doc.commitments.registry).toMatchObject({ status: 'REGISTERED', registryAddress: registry.toLowerCase(), recordedFrom: 'VERIFIED_TX_RECEIPT', forkOf: null });
      // Independent of BAG: recompute the hash and read the chain.
      const record = await readRegistryRecord(publicClient as never, registry, registryStrategyId(c.session.walletAddress, bag.id), version);
      expect(verifyBagJsonCommitment(doc, record).verified).toBe(true);
    }

    vi.stubEnv('STRATEGY_REGISTRY_ADDRESS_ROBINHOOD', registry);
    const status = await getRegistrationStatus(db.client, bag.id, c.session.userId);
    vi.unstubAllEnvs();
    expect(status).toMatchObject({ configured: true, viewerIsCreator: true, registryStrategyId: registryStrategyId(c.session.walletAddress, bag.id), fork: null });
    expect(status!.versions.map((v) => [v.version, v.registered])).toEqual([[1, true], [2, true]]);
    expect((await getRegistrationStatus(db.client, bag.id, null))!.viewerIsCreator).toBe(false);

    // Confirm is idempotent, and a transaction cannot be claimed by another Bag.
    expect(await confirmStrategyRegistration(db.client, c.session, bag.id, first.txHash, deps())).toMatchObject({ ok: true, alreadyRecorded: true });
    const other = await strategy(c);
    expect(await confirmStrategyRegistration(db.client, c.session, other.id, first.txHash, deps())).toEqual({ ok: false, error: 'TX_ALREADY_USED' });
  });

  it('never records a commitment that is not the stored bag.json hash, nor a transaction from another wallet', async () => {
    const c = await creator();
    const bag = await strategy(c);
    // The creator calls the registry directly with a different hash.
    const wrong = await c.w.writeContract({
      address: registry,
      abi: (await viem.getContractAt('StrategyRegistry', registry)).abi,
      functionName: 'registerStrategy',
      args: [computeOnChainBagId(bag.id), `0x${'ab'.repeat(32)}`, ''],
    });
    expect(await confirmStrategyRegistration(db.client, c.session, bag.id, wrong, deps())).toMatchObject({ ok: false, error: 'VERIFICATION_FAILED' });
    expect((await db.admin.query('select count(*)::int as n from strategy_registrations where bag_id = $1', [bag.id])).rows[0].n).toBe(0);
    expect((await bagJson(bag.id, 1)).commitments.registry.status).toBe('NOT_REGISTERED');

    // Someone else sends the prepared calldata: it is not the creator's transaction.
    const c2 = await creator();
    const bag2 = await strategy(c2);
    const prepared = await prepareStrategyRegistration(db.client, c2.session, bag2.id, deps());
    if (!prepared.ok) throw new Error('prepare');
    const stranger = await creator();
    const tx = await stranger.w.sendTransaction({ to: prepared.transaction.to, data: prepared.transaction.data });
    expect(await confirmStrategyRegistration(db.client, c2.session, bag2.id, tx, deps())).toMatchObject({ ok: false, error: 'VERIFICATION_FAILED' });
  });

  it('the prepared calldata sent to a look-alike StrategyRegistry is not recorded: the configured registry emitted nothing', async () => {
    const c = await creator();
    const bag = await strategy(c);
    const lookalike = (await viem.deployContract('StrategyRegistry', [])).address;
    const prepared = await prepareStrategyRegistration(db.client, c.session, bag.id, deps());
    if (!prepared.ok) throw new Error('prepare');
    const tx = await c.w.sendTransaction({ to: lookalike, data: prepared.transaction.data }); // succeeds on-chain, on the wrong contract
    expect(await confirmStrategyRegistration(db.client, c.session, bag.id, tx, deps())).toMatchObject({ ok: false, error: 'VERIFICATION_FAILED' });
    expect((await db.admin.query('select count(*)::int as n from strategy_registrations where bag_id = $1', [bag.id])).rows[0].n).toBe(0);
  });

  it('fork provenance: a fork registers against the exact parent version it was made from, and only once that version is registered', async () => {
    const alice = await creator();
    const parent = await strategy(alice);
    const v2 = await createBagVersion(db.client, { bagId: parent.id, createdBy: alice.session.userId, reason: 'v2', recipe: otherRecipe() });
    if (!v2.ok) throw new Error('v2');

    const bob = await creator();
    const fork = await createForkBag(db.client, { slug: `fork-${Date.now()}-${cursor++}`, creatorId: bob.session.userId, mutability: 'MUTABLE', recipe: validRecipeInput(), reason: 'fork' }, parent, 2);
    if (!fork.ok) throw new Error(JSON.stringify(fork));
    expect((await bagJson(fork.bag.id, 1)).forkedFrom).toEqual({ strategyId: parent.id, version: 2 });

    // Parent v2 not registered yet: the fork cannot be registered (as a fork or otherwise).
    expect(await prepareStrategyRegistration(db.client, bob.session, fork.bag.id, deps())).toMatchObject({ ok: false, error: 'PARENT_NOT_REGISTERED' });

    await registerNext(alice, parent.id); // v1
    await registerNext(alice, parent.id); // v2
    const forked = await registerNext(bob, fork.bag.id);
    const parentId = registryStrategyId(alice.session.walletAddress, parent.id);
    expect(forked.prepared).toMatchObject({ kind: 'REGISTER_FORK', fork: { parentRegistryStrategyId: parentId, parentVersion: 2 } });
    expect(forked.confirmed).toMatchObject({ ok: true });

    const doc = await bagJson(fork.bag.id, 1);
    expect(doc.commitments.registry).toMatchObject({ status: 'REGISTERED', forkOf: { registryStrategyId: parentId, version: 2 } });
    // The chain says the same, independently of BAG.
    const onchain = await readRegistryRecord(publicClient as never, registry, registryStrategyId(bob.session.walletAddress, fork.bag.id), 1);
    expect(onchain.fork).toEqual({ parentStrategyId: parentId, parentVersion: 2 });
    expect(verifyBagJsonCommitment(doc, onchain).verified).toBe(true);
  });

  it('a fork made before BAG recorded its parent version cannot be registered (provenance is never inferred)', async () => {
    const alice = await creator();
    const parent = await strategy(alice);
    const bob = await creator();
    const legacy = await createForkBag(db.client, { slug: `legacy-${Date.now()}-${cursor++}`, creatorId: bob.session.userId, mutability: 'MUTABLE', recipe: validRecipeInput(), reason: 'fork' }, parent, 1);
    if (!legacy.ok) throw new Error('fork');
    // Simulate a pre-0052 fork row: the trigger allows clearing the version only by recreating the row, so bypass it here.
    await db.admin.query('alter table bags disable trigger trg_guard_bag_lineage');
    await db.admin.query('update bags set parent_bag_version = null where id = $1', [legacy.bag.id]);
    await db.admin.query('alter table bags enable trigger trg_guard_bag_lineage');
    expect(await prepareStrategyRegistration(db.client, bob.session, legacy.bag.id, deps())).toMatchObject({ ok: false, error: 'FORK_PARENT_VERSION_UNKNOWN' });
  });

  it('only the creator, and only with a configured registry', async () => {
    const c = await creator();
    const bag = await strategy(c);
    const other = await creator();
    expect(await prepareStrategyRegistration(db.client, other.session, bag.id, deps())).toEqual({ ok: false, error: 'FORBIDDEN' });
    expect(await prepareStrategyRegistration(db.client, c.session, bag.id, { ...deps(), registryAddress: null })).toEqual({ ok: false, error: 'REGISTRY_NOT_CONFIGURED' });
  });
});

describe('StrategyCompositions publication (user-signed, after registration)', () => {
  const withComp = () => ({ ...deps(), compositionsAddress: compositions });
  const chainIdOf = (c: string) => (c === 'robinhood' ? 4663 : null);

  async function next(c: Awaited<ReturnType<typeof creator>>, bagId: string) {
    const prepared = await prepareStrategyRegistration(db.client, c.session, bagId, withComp());
    if (!prepared.ok) throw new Error(JSON.stringify(prepared));
    const txHash = await c.w.sendTransaction({ to: prepared.transaction.to, data: prepared.transaction.data });
    return { prepared, txHash, confirmed: await confirmStrategyRegistration(db.client, c.session, bagId, txHash, withComp()) };
  }

  it('after v1 is registered, its weights are published from the same wallet, verified against bag.json and recorded; v2 follows the same path', async () => {
    const c = await creator();
    const bag = await strategy(c);
    expect((await next(c, bag.id)).prepared.kind).toBe('REGISTER');

    const comp = await next(c, bag.id);
    expect(comp.prepared).toMatchObject({ kind: 'PUBLISH_COMPOSITION', covers: [{ version: 1 }], transaction: { to: compositions } });
    expect(comp.confirmed).toMatchObject({ ok: true, alreadyRecorded: false, registrations: [] });
    expect(await prepareStrategyRegistration(db.client, c.session, bag.id, withComp())).toEqual({ ok: false, error: 'NOTHING_TO_REGISTER' });

    // The chain holds this version's weights, independently of BAG.
    const id = registryStrategyId(c.session.walletAddress, bag.id);
    const expected = definitionToAllocations((await bagJson(bag.id, 1)).definition, chainIdOf);
    if (!expected.ok) throw new Error(expected.reason);
    const onchain = await readOnchainComposition(publicClient as never, compositions, id, 1);
    expect(compareComposition(expected.allocations, onchain!).matches).toBe(true);
    const row = (await db.admin.query('select version, compositions_address, allocations from strategy_compositions where bag_id = $1', [bag.id])).rows;
    expect(row).toEqual([{ version: 1, compositions_address: compositions.toLowerCase(), allocations: expected.allocations.map((a) => ({ chainId: a.chainId.toString(), token: a.token, weightBps: a.weightBps })) }]);

    // Idempotent; a recorded composition cannot be claimed by another Bag.
    expect(await confirmStrategyRegistration(db.client, c.session, bag.id, comp.txHash, withComp())).toMatchObject({ ok: true, alreadyRecorded: true });
    expect(await confirmStrategyRegistration(db.client, c.session, (await strategy(c)).id, comp.txHash, withComp())).toEqual({ ok: false, error: 'TX_ALREADY_USED' });

    const v2 = await createBagVersion(db.client, { bagId: bag.id, createdBy: c.session.userId, reason: 'v2', recipe: otherRecipe() });
    if (!v2.ok) throw new Error(JSON.stringify(v2));
    expect((await next(c, bag.id)).prepared).toMatchObject({ kind: 'PUBLISH_VERSIONS', covers: [{ version: 2 }] });
    vi.stubEnv('STRATEGY_REGISTRY_ADDRESS_ROBINHOOD', registry);
    vi.stubEnv('STRATEGY_COMPOSITIONS_ADDRESS_ROBINHOOD', compositions);
    const pending = await getRegistrationStatus(db.client, bag.id, c.session.userId);
    expect(pending).toMatchObject({ compositionsAddress: compositions.toLowerCase(), compositionPending: true });
    expect(pending!.versions.map((v) => [v.version, v.compositionPublished])).toEqual([[1, true], [2, false]]);
    expect((await next(c, bag.id)).prepared).toMatchObject({ kind: 'PUBLISH_COMPOSITION', covers: [{ version: 2 }] });
    const done = await getRegistrationStatus(db.client, bag.id, c.session.userId);
    vi.unstubAllEnvs();
    expect(done).toMatchObject({ compositionPending: false });
    expect(done!.versions.map((v) => [v.version, v.compositionPublished])).toEqual([[1, true], [2, true]]);
  });

  it('weights the creator publishes directly that are not the bag.json definition are never recorded', async () => {
    const c = await creator();
    const bag = await strategy(c);
    await next(c, bag.id); // register v1
    const id = registryStrategyId(c.session.walletAddress, bag.id);
    const real = definitionToAllocations((await bagJson(bag.id, 1)).definition, chainIdOf);
    if (!real.ok) throw new Error(real.reason);
    const swapped = real.allocations.map((a, i, all) => ({ ...a, weightBps: all[all.length - 1 - i].weightBps }));
    const tx = await c.w.writeContract({
      address: compositions,
      abi: (await viem.getContractAt('StrategyCompositions', compositions)).abi,
      functionName: 'publishComposition',
      args: [id, 1, toContractAllocations(swapped)],
    });
    expect(await confirmStrategyRegistration(db.client, c.session, bag.id, tx, withComp())).toMatchObject({ ok: false, error: 'VERIFICATION_FAILED' });
    expect((await db.admin.query('select count(*)::int as n from strategy_compositions where bag_id = $1', [bag.id])).rows[0].n).toBe(0);
  });

  it('without a configured StrategyCompositions the flow ends after registration, as before', async () => {
    const c = await creator();
    const bag = await strategy(c);
    await registerNext(c, bag.id);
    expect(await prepareStrategyRegistration(db.client, c.session, bag.id, { ...deps(), compositionsAddress: null })).toEqual({ ok: false, error: 'NOTHING_TO_REGISTER' });
  });
});
