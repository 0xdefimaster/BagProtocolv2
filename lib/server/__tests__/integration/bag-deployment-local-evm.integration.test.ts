import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { network } from 'hardhat';
import type { PublicClient } from 'viem';
import { createEvmBagDeploymentAdapter } from '@/lib/blockchain/evm/adapter';
import type { EvmChainConfig } from '@/lib/blockchain/evm/config';
import { computeOnChainBagId, computeOnChainCompositionHash, deriveOnChainBagId } from '@/lib/domain/basket-protocol/onchain';
import { confirmBagDeployment, prepareBagDeployment } from '@/lib/server/deploy-bag';
import { getBagById } from '@/lib/server/bag-repo';
import { loadStrategyPassport } from '@/lib/server/strategy-passport';
import { buildBagJson, loadStrategyVersionRows } from '@/lib/server/strategy-api';
import { TestDatabase, bagRow, createDraftBag, createTestDatabase, deploymentRows } from './pg-harness';

// -----------------------------------------------------------------------------
// LOCAL-EVM INTEGRATION — real PostgreSQL + the REAL read-only adapter + the REAL
// contracts/BagFactory.sol running on Hardhat's in-process EVM, with a real
// wallet client signing `createBag` (the user-signed model end to end).
//
// What this proves: the adapter's checks work against genuine EVM receipts,
// events and contract reads (not mocked viem objects), and that the TypeScript
// `deriveOnChainBagId` equals the Solidity `deriveBagId`.
// What it does NOT prove: anything about Robinhood Chain or any other real
// network — this is a local simulated chain. "Real-chain" verification requires
// a deployed factory + RPC and is reported separately as NOT RUN.
// -----------------------------------------------------------------------------

let db: TestDatabase;
let viem: Awaited<ReturnType<typeof network.connect>>['viem'];
let publicClient: PublicClient;

beforeAll(async () => {
  db = await createTestDatabase({ mode: 'fresh' });
  const conn = await network.connect();
  viem = conn.viem;
  publicClient = (await viem.getPublicClient()) as unknown as PublicClient;
});
afterAll(async () => {
  await db?.drop();
});

const rpc = (method: string, params: unknown[] = []) => (publicClient as unknown as { request: (a: { method: string; params: unknown[] }) => Promise<unknown> }).request({ method, params });

function configFor(factoryAddress: `0x${string}`, over: Partial<EvmChainConfig> = {}): EvmChainConfig {
  return {
    chain: 'robinhood',
    viemChain: { id: 31337, name: 'Hardhat (local)', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [] } } } as unknown as EvmChainConfig['viemChain'],
    rpcUrl: 'in-process',
    factoryAddress,
    confirmations: 1,
    receiptTimeoutMs: 2000,
    ...over,
  };
}

let walletCursor = 0;
async function scenario(over: Partial<EvmChainConfig> = {}, fee = BigInt(0)) {
  const wallets = await viem.getWalletClients();
  const user = wallets[walletCursor++ % wallets.length];
  const stranger = wallets[walletCursor++ % wallets.length];
  // Treasury is `stranger` so the fee shows up as a balance change.
  const factory = await viem.deployContract('BagFactory', [user.account.address, stranger.account.address, fee, fee]);
  const config = configFor(factory.address, over);
  const adapter = createEvmBagDeploymentAdapter(config, publicClient);
  const wallet = user.account.address.toLowerCase();
  // Hardhat has 20 funded wallets, so a long suite reuses them: the DB user for a wallet is get-or-create (a fresh factory + Bag per scenario keeps scenarios independent).
  const userId = (await db.admin.query('insert into users (wallet_address) values ($1) on conflict (wallet_address) do update set wallet_address = excluded.wallet_address returning id', [wallet])).rows[0].id as string;
  const { bag, version } = await createDraftBag(db, userId);
  const session = { userId, walletAddress: wallet };
  const deps = { resolveAdapter: () => adapter };
  const offChainRef = computeOnChainBagId(bag.id);
  const compositionHash = computeOnChainCompositionHash(version.recipe.assets);
  /** The browser step: prepare → the person's OWN wallet signs and sends the prepared transaction. */
  const prepareAndSend = async (from = user) => {
    const prepared = await prepareBagDeployment(db.client, session, bag.id, deps);
    if (!prepared.ok) throw new Error(`prepare failed: ${JSON.stringify(prepared)}`);
    return from.sendTransaction({ to: prepared.transaction.to as `0x${string}`, data: prepared.transaction.data, value: BigInt(prepared.transaction.value) });
  };
  return { user, stranger, factory, config, adapter, wallet, userId, bag, version, session, deps, offChainRef, compositionHash, prepareAndSend };
}

const noState = async (bagId: string) => {
  expect(await deploymentRows(db, bagId)).toEqual([]);
  expect((await bagRow(db, bagId)).status).toBe('DRAFT');
};

describe('real BagFactory + user-signed createBag on a local EVM', () => {
  it('HAPPY PATH: prepare → the user\'s wallet signs → confirm verifies the real receipt → DEPLOYED + ACTIVE; ids match the contract', async () => {
    const s = await scenario();
    const txHash = await s.prepareAndSend();
    await noState(s.bag.id); // signed and sent, not yet confirmed: still DRAFT, no row

    const r = await confirmBagDeployment(db.client, s.session, s.bag.id, txHash, s.deps);
    if (!r.ok) throw new Error(JSON.stringify(r));
    expect(r.alreadyConfirmed).toBe(false);
    expect(r.bag.status).toBe('ACTIVE');

    // The persisted id is what the CONTRACT computed and emitted…
    const onChain = (await s.factory.read.deriveBagId([s.wallet as `0x${string}`, s.offChainRef])) as string;
    expect(r.deployment.onChainBagId).toBe(onChain.toLowerCase());
    // …and the TypeScript derivation used to cross-check it is byte-identical to Solidity's.
    expect(deriveOnChainBagId(s.wallet, s.offChainRef).toLowerCase()).toBe(onChain.toLowerCase());
    // The stored Bag address is the factory's registry entry and its creator is the SESSION wallet, not any server key.
    const registered = (await s.factory.read.bagOf([onChain as `0x${string}`])) as string;
    expect(r.deployment.contractAddress).toBe(registered.toLowerCase());
    const bagContract = await viem.getContractAt('Bag', registered as `0x${string}`);
    expect(((await bagContract.read.creator()) as string).toLowerCase()).toBe(s.wallet);
    expect(r.deployment).toMatchObject({ status: 'DEPLOYED', txHash: txHash.toLowerCase(), onChainCreator: s.wallet, factoryAddress: s.factory.address.toLowerCase() });
    expect(await deploymentRows(db, s.bag.id)).toHaveLength(1);

    // The deployed version IS on-chain version 1: Passport and bag.json show the composition hash the contract holds.
    const onchainComposition = ((await bagContract.read.compositionHash()) as string).toLowerCase();
    const record = (await getBagById(db.client, s.bag.id))!;
    const passport = await loadStrategyPassport(db.client, record, null);
    expect(passport.currentVersion?.onchainCompositionHash).toBe(onchainComposition);
    expect(passport.lineage.versions.nodes.find((v) => v.version === s.version.version)?.onchain).toMatchObject({ txHash: txHash.toLowerCase(), onchainVersion: 1, compositionHash: onchainComposition });
    const row = (await loadStrategyVersionRows(db.client, s.bag.id)).find((v) => v.version === s.version.version)!;
    expect(buildBagJson(record, row).commitments).toMatchObject({
      onchainCompositionHash: onchainComposition,
      onchainTxHash: txHash.toLowerCase(),
      onchainComposition: { status: 'MATCHES_RECORDED', recordedFrom: 'VERIFIED_TX_RECEIPT' },
    });
  });

  it('CREATION FEE: prepare carries the fee as value; the one-transaction paid deployment verifies and the treasury receives it', async () => {
    const FEE = BigInt(150_000_000_000_000);
    const s = await scenario({}, FEE);
    const prepared = await prepareBagDeployment(db.client, s.session, s.bag.id, s.deps);
    if (!prepared.ok) throw new Error(JSON.stringify(prepared));
    expect(prepared.transaction.value).toBe(FEE.toString());

    const before = await publicClient.getBalance({ address: s.stranger.account.address });
    const txHash = await s.user.sendTransaction({ to: prepared.transaction.to as `0x${string}`, data: prepared.transaction.data, value: FEE });

    const r = await confirmBagDeployment(db.client, s.session, s.bag.id, txHash, s.deps);
    if (!r.ok) throw new Error(JSON.stringify(r));
    expect(r.bag.status).toBe('ACTIVE');
    expect((await publicClient.getBalance({ address: s.stranger.account.address })) - before).toBe(FEE);
  });

  it('CREATION FEE: sending createBag without the fee reverts on-chain and nothing is recorded', async () => {
    const s = await scenario({}, BigInt(150_000_000_000_000));
    const prepared = await prepareBagDeployment(db.client, s.session, s.bag.id, s.deps);
    if (!prepared.ok) throw new Error('prepare failed');
    await expect(s.user.sendTransaction({ to: prepared.transaction.to as `0x${string}`, data: prepared.transaction.data })).rejects.toThrow();
    await noState(s.bag.id);
  });

  it('a duplicate confirm (refresh / retry / other casing) is idempotent against the real chain too', async () => {
    const s = await scenario();
    const txHash = await s.prepareAndSend();
    expect((await confirmBagDeployment(db.client, s.session, s.bag.id, txHash, s.deps)).ok).toBe(true);
    for (const h of [txHash, `0x${txHash.slice(2).toUpperCase()}`]) {
      expect(await confirmBagDeployment(db.client, s.session, s.bag.id, h, s.deps)).toMatchObject({ ok: true, alreadyConfirmed: true });
    }
    expect(await deploymentRows(db, s.bag.id)).toHaveLength(1);
  });

  it('after a successful (but unconfirmed) transaction, prepare refuses to offer one that would only revert', async () => {
    const s = await scenario();
    await s.prepareAndSend();
    expect(await prepareBagDeployment(db.client, s.session, s.bag.id, s.deps)).toEqual({ ok: false, error: 'ALREADY_CREATED_ON_CHAIN' });
  });

  it('WRONG SENDER: another wallet sends the identical createBag — confirm as the session wallet is rejected; nothing is written', async () => {
    const s = await scenario();
    const txHash = await s.prepareAndSend(s.stranger);
    const r = await confirmBagDeployment(db.client, s.session, s.bag.id, txHash, s.deps);
    expect(r).toMatchObject({ ok: false, error: 'VERIFICATION_FAILED', message: expect.stringMatching(/not the authenticated wallet/) });
    await noState(s.bag.id);
  });

  it('WRONG FACTORY: createBag sent to a look-alike BagFactory (real contract, wrong address) is rejected', async () => {
    const s = await scenario();
    const lookalike = await viem.deployContract('BagFactory', [s.user.account.address, s.user.account.address, BigInt(0), BigInt(0)]);
    const prepared = await prepareBagDeployment(db.client, s.session, s.bag.id, s.deps);
    if (!prepared.ok) throw new Error('prepare failed');
    const txHash = await s.user.sendTransaction({ to: lookalike.address, data: prepared.transaction.data }); // succeeds ON-CHAIN, just on the wrong contract
    const r = await confirmBagDeployment(db.client, s.session, s.bag.id, txHash, s.deps);
    expect(r).toMatchObject({ ok: false, error: 'VERIFICATION_FAILED', message: expect.stringMatching(/not the expected BagFactory/) });
    await noState(s.bag.id);
  });

  it('TAMPERED COMPOSITION: the user signs a createBag with a different compositionHash than the database holds', async () => {
    const s = await scenario();
    const tampered = await viem.getContractAt('BagFactory', s.factory.address, { client: { wallet: s.user } });
    const txHash = await tampered.write.createBag([s.offChainRef, `0x${'ab'.repeat(32)}`, `bag:${s.bag.id}`, true]);
    const r = await confirmBagDeployment(db.client, s.session, s.bag.id, txHash, s.deps);
    expect(r).toMatchObject({ ok: false, error: 'VERIFICATION_FAILED', message: expect.stringMatching(/compositionHash/) });
    await noState(s.bag.id);
  });

  it('WRONG BAG: a genuine createBag for a DIFFERENT Bag\'s offChainRef cannot be used to activate this one', async () => {
    const s = await scenario();
    const other = await createDraftBag(db, s.userId);
    const asUser = await viem.getContractAt('BagFactory', s.factory.address, { client: { wallet: s.user } });
    const txHash = await asUser.write.createBag([computeOnChainBagId(other.bag.id), s.compositionHash, `bag:${other.bag.id}`, true]);
    const r = await confirmBagDeployment(db.client, s.session, s.bag.id, txHash, s.deps);
    expect(r).toMatchObject({ ok: false, error: 'VERIFICATION_FAILED', message: expect.stringMatching(/offChainRef/) });
    await noState(s.bag.id);
  });

  it('A transaction that is not a createBag call at all (plain transfer to the factory address) has no BagCreated event and is rejected', async () => {
    const s = await scenario();
    // The factory has no receive()/fallback, so a plain call reverts: send with explicit gas while automine is off so it is mined as failed.
    await rpc('evm_setAutomine', [false]);
    try {
      const txHash = await s.user.sendTransaction({ to: s.factory.address, data: '0x12345678', gas: BigInt(200_000) });
      await rpc('evm_mine');
      const r = await confirmBagDeployment(db.client, s.session, s.bag.id, txHash, s.deps);
      expect(r).toMatchObject({ ok: false, error: 'VERIFICATION_FAILED' });
    } finally {
      await rpc('evm_setAutomine', [true]);
    }
    await noState(s.bag.id);
  });

  it('REVERTED TRANSACTION: a real on-chain revert (duplicate createBag mined as failed) is rejected, while the successful one still confirms', async () => {
    const s = await scenario();
    await rpc('evm_setAutomine', [false]);
    let good: `0x${string}`;
    let bad: `0x${string}`;
    try {
      const prepared = await prepareBagDeployment(db.client, s.session, s.bag.id, s.deps);
      if (!prepared.ok) throw new Error('prepare failed');
      const tx = { to: prepared.transaction.to as `0x${string}`, data: prepared.transaction.data, gas: BigInt(1_500_000) };
      good = await s.user.sendTransaction(tx);
      bad = await s.user.sendTransaction(tx); // same (creator, ref): AlreadyDeployed once `good` is mined first
      await rpc('evm_mine'); // both land in one block, in nonce order: good succeeds, bad reverts
    } finally {
      await rpc('evm_setAutomine', [true]);
    }
    const receiptBad = await publicClient.getTransactionReceipt({ hash: bad });
    expect(receiptBad.status).toBe('reverted');

    expect(await confirmBagDeployment(db.client, s.session, s.bag.id, bad, s.deps)).toMatchObject({ ok: false, error: 'VERIFICATION_FAILED', message: expect.stringMatching(/reverted/) });
    await noState(s.bag.id);
    expect(await confirmBagDeployment(db.client, s.session, s.bag.id, good, s.deps)).toMatchObject({ ok: true });
    expect((await bagRow(db, s.bag.id)).status).toBe('ACTIVE');
  });

  it('PENDING (real un-mined transaction): bounded wait → PENDING, nothing written, still DRAFT; after it is mined the SAME confirm succeeds', async () => {
    const s = await scenario({ receiptTimeoutMs: 1200 });
    await rpc('evm_setAutomine', [false]);
    let txHash: `0x${string}`;
    try {
      txHash = await s.prepareAndSend();
      const started = Date.now();
      const r = await confirmBagDeployment(db.client, s.session, s.bag.id, txHash, s.deps);
      expect(r).toMatchObject({ ok: false, error: 'PENDING' });
      expect(Date.now() - started).toBeLessThan(6000); // the wait is BOUNDED — the request cannot hang on a pending tx
      await noState(s.bag.id);
      await rpc('evm_mine');
    } finally {
      await rpc('evm_setAutomine', [true]);
    }
    expect(await confirmBagDeployment(db.client, s.session, s.bag.id, txHash, s.deps)).toMatchObject({ ok: true, alreadyConfirmed: false });
    expect((await bagRow(db, s.bag.id)).status).toBe('ACTIVE');
  });

  it('CONFIRMATION DEPTH is explicit and enforced: with 3 confirmations required, a 1-deep receipt is PENDING until two more blocks exist', async () => {
    const s = await scenario({ confirmations: 3, receiptTimeoutMs: 1200 });
    const txHash = await s.prepareAndSend(); // mined: 1 confirmation
    expect(await confirmBagDeployment(db.client, s.session, s.bag.id, txHash, s.deps)).toMatchObject({ ok: false, error: 'PENDING' });
    await noState(s.bag.id);
    await rpc('hardhat_mine', ['0x2']);
    expect(await confirmBagDeployment(db.client, s.session, s.bag.id, txHash, s.deps)).toMatchObject({ ok: true });
    expect((await bagRow(db, s.bag.id)).status).toBe('ACTIVE');
  });

  // CONCURRENT confirms used to be intermittently red (it carried `retry: 2` and a
  // "Retried, not fixed" note). Root cause: viem's `waitForTransactionReceipt`
  // shares one observer per (client, hash) and leaves resolved followers
  // registered until their own timeout, so a confirm arriving in that window
  // hung and came back PENDING for an already-mined transaction. The adapter
  // now polls per call (lib/blockchain/evm/receipt-confirmation.ts); these two
  // tests pin that down — no retry, and the second one reproduces the exact
  // staggered-arrival shape that used to fail every time.
  it('CONCURRENT confirms of one real transaction → all succeed, one writer, one row', async () => {
    const s = await scenario();
    const txHash = await s.prepareAndSend();
    const results = await Promise.all(Array.from({ length: 8 }, () => confirmBagDeployment(db.client, s.session, s.bag.id, txHash, s.deps)));
    expect(results.filter((r) => !r.ok)).toEqual([]);
    expect(results.filter((r) => r.ok && !r.alreadyConfirmed)).toHaveLength(1);
    expect(results.filter((r) => r.ok && r.alreadyConfirmed)).toHaveLength(7);
    for (const r of results) if (r.ok) expect(r.bag.status).toBe('ACTIVE');
    const rows = await deploymentRows(db, s.bag.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'DEPLOYED', tx_hash: txHash.toLowerCase() });
    expect((await bagRow(db, s.bag.id)).status).toBe('ACTIVE');
  });

  it('STAGGERED verifications of one mined transaction on ONE shared client never report a spurious PENDING (regression)', async () => {
    const s = await scenario({ receiptTimeoutMs: 2000 });
    const txHash = await s.prepareAndSend();
    const params = {
      txHash,
      expectedFactoryAddress: s.adapter.factoryAddress,
      expectedOffChainRef: s.offChainRef,
      expectedCompositionHash: s.compositionHash,
      expectedCreator: s.wallet as `0x${string}`,
      expectedIsMutable: true,
    };
    // Two overlapping waits, then — after both resolved — a third. Under viem's shared observer the third hung for the full timeout.
    await Promise.all([s.adapter.verifyBagCreation(params), s.adapter.verifyBagCreation(params)]);
    const started = Date.now();
    await expect(s.adapter.verifyBagCreation(params)).resolves.toMatchObject({ txHash: txHash.toLowerCase() });
    expect(Date.now() - started).toBeLessThan(1000); // already mined: answered on the first poll, not after a timeout
    // …and the full server path for that same late arrival.
    expect(await confirmBagDeployment(db.client, s.session, s.bag.id, txHash, s.deps)).toMatchObject({ ok: true, alreadyConfirmed: false });
  });

  it('the adapter exposes no signing/sending capability — the server cannot create a Bag itself', async () => {
    const s = await scenario();
    expect(Object.keys(s.adapter).sort()).toEqual(['factoryAddress', 'hasBagOnChain', 'isLive', 'name', 'prepareBagCreation', 'verifyBagCreation']);
  });
});
