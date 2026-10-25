import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { network } from 'hardhat';
import { keccak256, pad, toHex, type Hex } from 'viem';
import { recurringAuthorizationTypedData, recurringCompositionHash, type RecurringAuthorization } from '../../packages/bag-sdk/src/recurring';
import { routerPlanTypedData } from '../../packages/bag-sdk/src/adapters/uniswap-v3';
import { createViemKeeperChain, type KeeperChain } from '../../lib/dca/keeper/chain';
import { RecurringKeeper } from '../../lib/dca/keeper/keeper';
import { FileKeeperStore, MemoryKeeperStore, type KeeperStore } from '../../lib/dca/keeper/store';

// -----------------------------------------------------------------------------
// The persistent keeper (lib/dca/keeper) against the REAL RecurringPurchaseExecutor,
// BagExecutionRouter, BagFactory and StrategyRegistry on Hardhat's in-process EVM,
// with the DCA mocks for token, DEX and QuoterV2. Every transaction is real and
// mined; restarts, crashes, drops and competing keepers are produced with real
// keeper instances, a durable file store and the node's mempool controls.
// The point: the chain decides. No restart, lost store or second keeper may reset
// a budget, reopen a window or buy twice.
// -----------------------------------------------------------------------------

const PERIOD = 3600n;
const GROSS = 5_000_000n;
const RUNS = 3;
const DEFINITION = keccak256(toHex('bag.json v1 definition'));
const OFF_CHAIN_REF = pad('0x955df6e0', { size: 32 });

async function setup() {
  const connection = await network.connect();
  const { viem } = connection;
  const publicClient = await viem.getPublicClient();
  const [deployer, owner, keeperA, planSigner, creator, keeperB] = await viem.getWalletClients();
  const rpc = (method: string, params: unknown[] = []) => connection.provider.request({ method, params });

  const usdg = await viem.deployContract('DcaTestToken', ['Global Dollar', 'USDG', 6]);
  const gme = await viem.deployContract('DcaTestToken', ['GameStop', 'GME', 18]);
  const aapl = await viem.deployContract('DcaTestToken', ['Apple', 'AAPL', 18]);
  const dex = await viem.deployContract('DcaMockSwapRouter02', []);
  await dex.write.setRate([gme.address, 10n ** 18n, 25_000_000n]);
  await dex.write.setRate([aapl.address, 10n ** 18n, 200_000_000n]);
  await gme.write.mint([dex.address, 10n ** 30n]);
  await aapl.write.mint([dex.address, 10n ** 30n]);
  const quoter = await viem.deployContract('DcaMockQuoterV2', [dex.address]);

  // The BAG's registered content, in its registered (symbol) order; the authorization signs exactly these rows.
  const assets = [
    { asset: aapl.address.toLowerCase() as Hex, symbol: 'AAPL', weightBps: 4000, decimals: 18, maxPriceRaw: 250_000_000n },
    { asset: gme.address.toLowerCase() as Hex, symbol: 'GME', weightBps: 6000, decimals: 18, maxPriceRaw: 30_000_000n },
  ];
  const COMPOSITION = recurringCompositionHash('robinhood', assets);
  const factory = await viem.deployContract('BagFactory', [deployer.account.address, deployer.account.address, 0n, 0n]);
  await (await viem.getContractAt('BagFactory', factory.address, { client: { wallet: creator } })).write.createBag([OFF_CHAIN_REF, COMPOSITION, 'ipfs://bag', true]);
  const bagId = (await factory.read.deriveBagId([creator.account.address, OFF_CHAIN_REF])) as Hex;
  const registry = await viem.deployContract('StrategyRegistry', []);
  await (await viem.getContractAt('StrategyRegistry', registry.address, { client: { wallet: creator } })).write.registerStrategy([OFF_CHAIN_REF, DEFINITION, 'ipfs://definition']);
  const strategyId = (await registry.read.deriveStrategyId([creator.account.address, OFF_CHAIN_REF])) as Hex;
  const router = await viem.deployContract('BagExecutionRouter', [factory.address, deployer.account.address, planSigner.account.address]);
  await router.write.setAllowedTarget([dex.address, true]);
  for (const t of [usdg, gme, aapl]) await router.write.setAllowedToken([t.address, true]);
  const executor = await viem.deployContract('RecurringPurchaseExecutor', [factory.address, registry.address, 'robinhood']);

  await usdg.write.mint([owner.account.address, 1_000_000_000n]);
  const usdgAsOwner = await viem.getContractAt('DcaTestToken', usdg.address, { client: { wallet: owner } });
  await usdgAsOwner.write.approve([executor.address, GROSS * BigInt(RUNS)]);
  const executorAsOwner = await viem.getContractAt('RecurringPurchaseExecutor', executor.address, { client: { wallet: owner } });

  const chainId = await publicClient.getChainId();
  const now = async () => (await publicClient.getBlock()).timestamp;
  const startsAt = (await now()) + 10n;
  const auth: RecurringAuthorization = {
    owner: owner.account.address.toLowerCase() as Hex,
    sourceAccount: owner.account.address.toLowerCase() as Hex,
    recipient: owner.account.address.toLowerCase() as Hex,
    fundingKind: 0,
    fundingContract: usdg.address.toLowerCase() as Hex,
    inputToken: usdg.address.toLowerCase() as Hex,
    bag: { bagId, bagVersion: 1n, compositionHash: COMPOSITION, definitionHash: DEFINITION, strategyId, strategyVersion: 1 },
    assets,
    schedule: { grossAmountPerRun: GROSS, totalBudget: GROSS * BigInt(RUNS), maxExecutions: RUNS, startsAt, periodSeconds: PERIOD, expiresAt: startsAt + BigInt(RUNS + 1) * PERIOD },
    route: { router: router.address.toLowerCase() as Hex, swapTarget: dex.address.toLowerCase() as Hex, allowedFees: [500, 3000] },
    nonce: 1n,
  };
  const deployment = { chainId, executor: executor.address.toLowerCase() as Hex, router: router.address.toLowerCase() as Hex };
  const ownerSignature = await owner.signTypedData(recurringAuthorizationTypedData(auth, deployment) as any);
  const signPlan = (plan: Parameters<typeof routerPlanTypedData>[0], r: Hex) => planSigner.signTypedData(routerPlanTypedData(plan, { chainId, router: r }) as any);

  const chainFor = (wallet: typeof keeperA) => createViemKeeperChain({ publicClient: publicClient as any, walletClient: wallet as any });
  const makeKeeper = (store: KeeperStore, chain: KeeperChain, holder = 'keeper-a') =>
    new RecurringKeeper({ store, chain, signPlan, quoter: quoter.address, holder, pendingTimeoutMs: 60_000 });
  const tmpStore = async () => new FileKeeperStore(join(await mkdtemp(join(tmpdir(), 'bag-keeper-')), 'jobs.json'));
  const state = async () => executor.read.getState([auth.owner, (await executor.read.authorizationIdOf([auth])) as Hex]) as Promise<{ executions: number; grossUsed: bigint; lastWindow: bigint; revoked: boolean }>;
  const ownerUsdg = () => usdg.read.balanceOf([owner.account.address]) as Promise<bigint>;
  const nonceOf = (w: typeof keeperA) => publicClient.getTransactionCount({ address: w.account.address });
  /** Into window w: its start for w = 0, its middle otherwise (a purchase also needs one full period since the last one). */
  const toWindow = async (w: bigint) => {
    await rpc('evm_setNextBlockTimestamp', [Number(startsAt + w * PERIOD + (w === 0n ? 5n : PERIOD / 2n))]);
    await rpc('evm_mine');
  };
  const add = (k: RecurringKeeper) => k.addJob({ authorization: auth, ownerSignature, deployment });
  return { rpc, publicClient, keeperA, keeperB, owner, usdgAsOwner, executorAsOwner, quoter, dex, gme, auth, deployment, chainFor, makeKeeper, tmpStore, state, ownerUsdg, nonceOf, toWindow, add };
}

describe('RecurringKeeper (persistent, chain counters as truth)', () => {
  it('one purchase per window; a restarted keeper on the same store neither resends nor resets', async () => {
    const t = await setup();
    const store = await t.tmpStore();
    const k1 = t.makeKeeper(store, t.chainFor(t.keeperA));
    await t.add(k1);
    await t.toWindow(0n);
    const before = await t.ownerUsdg();
    assert.equal((await k1.tick())[0].state, 'PENDING_TX');
    const [after1] = await k1.tick();
    assert.equal(after1.state, 'DONE_THIS_WINDOW');
    assert.equal(after1.confirmed.length, 1);
    assert.equal(after1.confirmed[0].verification, 'VERIFIED', JSON.stringify(after1.confirmed[0].issues));
    // the SDK verified the mined call against the call this keeper prepared, and the balances of this transaction
    assert.deepEqual([after1.confirmed[0].binding, after1.confirmed[0].evidence, after1.confirmed[0].balanceScope], ['PREPARED_INTENT', 'TRANSACTION_AND_BALANCE_DELTAS', 'SINGLE_TRANSACTION_BLOCK']);
    assert.equal(after1.pending, null, 'the prepared call (with its plan signature) is not kept after confirmation');
    assert.equal(before - (await t.ownerUsdg()), GROSS);

    // restart: a new process with the same durable store
    const nonce = await t.nonceOf(t.keeperA);
    const k2 = t.makeKeeper(new FileKeeperStore(store.path), t.chainFor(t.keeperA));
    assert.equal((await k2.tick())[0].state, 'DONE_THIS_WINDOW');
    assert.equal(await t.nonceOf(t.keeperA), nonce, 'nothing was sent after the restart');
    assert.equal((await t.state()).executions, 1);

    await t.toWindow(1n);
    await k2.tick();
    const [after2] = await k2.tick();
    assert.equal(after2.confirmed.length, 2);
    assert.deepEqual([(await t.state()).executions, (await t.state()).grossUsed], [2, 2n * GROSS]);
  });

  it('a LOST store cannot reset the budget or reopen a window: a fresh store reads the chain', async () => {
    const t = await setup();
    const k1 = t.makeKeeper(new MemoryKeeperStore(), t.chainFor(t.keeperA));
    await t.add(k1);
    await t.toWindow(0n);
    await k1.tick();
    await k1.tick();
    const start = await t.ownerUsdg();

    const k2 = t.makeKeeper(new MemoryKeeperStore(), t.chainFor(t.keeperA)); // everything the first keeper knew is gone
    await t.add(k2);
    const [job] = await k2.tick();
    assert.equal(job.state, 'DONE_THIS_WINDOW');
    assert.equal(job.confirmed.length, 1, 'the earlier run is recovered from PurchaseExecuted logs');
    // this keeper did not prepare that call: it is verified from the decoded call and balances, and labelled weaker
    assert.deepEqual([job.confirmed[0].verification, job.confirmed[0].binding], ['VERIFIED', 'DECODED_CALL']);
    for (const w of [1n, 2n, 3n]) {
      await t.toWindow(w);
      await k2.tick();
      await k2.tick();
    }
    const [end] = await k2.tick();
    assert.equal(end.state, 'COMPLETED');
    assert.equal((await t.state()).executions, RUNS);
    assert.equal(start - (await t.ownerUsdg()), GROSS * BigInt(RUNS - 1), 'exactly the remaining runs, never more');
  });

  it('crash after the write-ahead record, before sending: the restart records UNSENT and sends once', async () => {
    const t = await setup();
    const store = await t.tmpStore();
    const chain = t.chainFor(t.keeperA);
    const crashing = t.makeKeeper(store, { ...chain, sendExecute: async () => { throw new Error('CRASH before send'); } });
    await t.add(crashing);
    await t.toWindow(0n);
    await assert.rejects(crashing.tick(), /CRASH before send/);
    const stored = (await store.list())[0];
    assert.ok(stored.pending && stored.pending.hash === null, 'the write-ahead record survived the crash');
    const k = t.makeKeeper(new FileKeeperStore(store.path), chain);
    await k.tick();
    const [job] = await k.tick();
    assert.deepEqual(job.attempts.map((a) => a.outcome), ['UNSENT']);
    assert.equal(job.confirmed.length, 1);
    assert.equal((await t.state()).executions, 1);
  });

  it('crash after sending, before the hash is stored: the restart finds the purchase on chain; no second send', async () => {
    const t = await setup();
    const store = await t.tmpStore();
    const chain = t.chainFor(t.keeperA);
    const crashing = t.makeKeeper(store, { ...chain, sendExecute: async (...a: Parameters<KeeperChain['sendExecute']>) => { await chain.sendExecute(...a); throw new Error('CRASH after send'); } });
    await t.add(crashing);
    await t.toWindow(0n);
    await assert.rejects(crashing.tick(), /CRASH after send/);
    const nonce = await t.nonceOf(t.keeperA);
    const [job] = await t.makeKeeper(new FileKeeperStore(store.path), chain).tick();
    assert.equal(job.state, 'DONE_THIS_WINDOW');
    assert.equal(job.confirmed.length, 1);
    assert.equal(job.pending, null);
    assert.deepEqual([job.confirmed[0].verification, job.confirmed[0].binding], ['VERIFIED', 'PREPARED_INTENT'], 'the write-ahead intent identifies the call even without its hash');
    assert.equal(await t.nonceOf(t.keeperA), nonce, 'nothing re-sent');
    assert.equal((await t.state()).executions, 1);
  });

  it('a dropped transaction is detected from the nonce and retried in the same window, still once', async () => {
    const t = await setup();
    const k = t.makeKeeper(new MemoryKeeperStore(), t.chainFor(t.keeperA));
    await t.add(k);
    await t.toWindow(0n);
    await t.rpc('evm_setAutomine', [false]);
    const [sent] = await k.tick();
    assert.equal(sent.state, 'PENDING_TX');
    assert.equal((await k.tick())[0].state, 'PENDING_TX', 'still in the mempool');
    await t.rpc('hardhat_dropTransaction', [sent.pending!.hash]);
    const [resent] = await k.tick();
    assert.deepEqual(resent.attempts.map((a) => a.outcome), ['DROPPED']);
    assert.equal(resent.state, 'PENDING_TX');
    await t.rpc('evm_mine');
    await t.rpc('evm_setAutomine', [true]);
    const [done] = await k.tick();
    assert.equal(done.confirmed.length, 1);
    assert.equal((await t.state()).executions, 1);
  });

  it('a second keeper whose node shows the pending purchase does not send (pending-aware estimate)', async () => {
    const t = await setup();
    const a = t.makeKeeper(new MemoryKeeperStore(), t.chainFor(t.keeperA), 'a');
    const b = t.makeKeeper(new MemoryKeeperStore(), t.chainFor(t.keeperB), 'b');
    await t.add(a);
    await t.add(b);
    await t.toWindow(0n);
    await t.rpc('evm_setAutomine', [false]);
    await a.tick();
    const nonceB = await t.nonceOf(t.keeperB);
    const [jb] = await b.tick();
    assert.equal(jb.state, 'SIMULATION_REVERTED');
    assert.match(jb.stateDetail ?? '', /NotDue/);
    await t.rpc('evm_mine');
    await t.rpc('evm_setAutomine', [true]);
    assert.equal(await t.nonceOf(t.keeperB), nonceB);
    assert.equal((await t.state()).executions, 1);
  });

  it('two keepers with separate stores, one blind to the mempool: one purchase; the other is mined, reverts and is recorded', async () => {
    const t = await setup();
    const a = t.makeKeeper(new MemoryKeeperStore(), t.chainFor(t.keeperA), 'a');
    // b's node does not show a's pending transaction: its pre-flight passes, so it sends
    const b = t.makeKeeper(new MemoryKeeperStore(), { ...t.chainFor(t.keeperB), simulateExecute: async () => ({ ok: true as const, gas: 3_000_000n }) }, 'b');
    await t.add(a);
    await t.add(b);
    await t.toWindow(0n);
    const before = await t.ownerUsdg();
    await t.rpc('evm_setAutomine', [false]);
    assert.equal((await a.tick())[0].state, 'PENDING_TX');
    assert.equal((await b.tick())[0].state, 'PENDING_TX', 'b cannot see a\'s pending purchase and sends too');
    await t.rpc('evm_mine');
    await t.rpc('evm_setAutomine', [true]);
    const [ja] = await a.tick();
    const [jb] = await b.tick();
    assert.equal((await t.state()).executions, 1);
    assert.equal(before - (await t.ownerUsdg()), GROSS, 'charged once');
    assert.equal(ja.confirmed.length + jb.confirmed.length, 2, 'both record the one purchase');
    assert.equal(ja.confirmed[0].hash, jb.confirmed[0].hash);
    assert.deepEqual([ja.confirmed[0].binding, jb.confirmed[0].binding].sort(), ['DECODED_CALL', 'PREPARED_INTENT'], 'only the winner holds the prepared call');
    assert.equal([...ja.attempts, ...jb.attempts].filter((x) => x.outcome === 'REVERTED').length, 1, 'the loser\'s mined revert is on record');
  });

  it('two keepers sharing one store: the lease lets one send; the other skips the job', async () => {
    const t = await setup();
    const store = await t.tmpStore();
    const chainA = t.chainFor(t.keeperA);
    let release!: () => void;
    let reachedSend!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const reached = new Promise<void>((r) => (reachedSend = r));
    const a = t.makeKeeper(store, { ...chainA, sendExecute: async (...x: Parameters<KeeperChain['sendExecute']>) => { reachedSend(); await gate; return chainA.sendExecute(...x); } }, 'a');
    const b = t.makeKeeper(new FileKeeperStore(store.path), t.chainFor(t.keeperB), 'b');
    await t.add(a);
    await t.toWindow(0n);
    const running = a.tick();
    await reached; // a holds the lease, about to send
    const nonceB = await t.nonceOf(t.keeperB);
    assert.deepEqual(await b.tick(), [], 'b could not lease the job');
    release();
    await running;
    assert.equal(await t.nonceOf(t.keeperB), nonceB);
    await a.tick();
    assert.equal((await t.state()).executions, 1);
  });

  it('gas and funding shortages are visible states that send nothing; price beyond the limit waits; revoke ends it', async () => {
    const t = await setup();
    const k = t.makeKeeper(new MemoryKeeperStore(), t.chainFor(t.keeperA));
    await t.add(k);
    await t.toWindow(0n);
    const nonce = await t.nonceOf(t.keeperA);
    const funded = await t.publicClient.getBalance({ address: t.keeperA.account.address });
    await t.rpc('hardhat_setBalance', [t.keeperA.account.address, '0x1']);
    assert.equal((await k.tick())[0].state, 'GAS_SHORTAGE');
    await t.rpc('hardhat_setBalance', [t.keeperA.account.address, toHex(funded)]);
    await t.usdgAsOwner.write.approve([t.executorAsOwner.address, 0n]);
    assert.equal((await k.tick())[0].state, 'FUNDING_SHORTAGE');
    await t.usdgAsOwner.write.approve([t.executorAsOwner.address, GROSS * BigInt(RUNS)]);
    await t.quoter.write.setLimited([true]);
    assert.equal((await k.tick())[0].state, 'WAITING_PRICE');
    assert.equal(await t.nonceOf(t.keeperA), nonce, 'no transaction in any of these states');
    assert.equal((await t.state()).executions, 0, 'no window consumed');
    await t.quoter.write.setLimited([false]);
    await k.tick();
    assert.equal((await k.tick())[0].confirmed.length, 1);
    await t.executorAsOwner.write.revoke([(await k.tick())[0].id]);
    await t.toWindow(1n);
    const [job] = await k.tick();
    assert.equal(job.state, 'REVOKED');
    assert.equal((await t.state()).executions, 1);
  });

  it('the FIXED max price skips windows: they are recorded with the market price, never made up, and the unspendable budget is shown', async () => {
    const t = await setup();
    const k = t.makeKeeper(new MemoryKeeperStore(), t.chainFor(t.keeperA));
    await t.add(k);
    const start = await t.ownerUsdg();
    await t.toWindow(0n);
    await k.tick();
    assert.equal((await k.tick())[0].confirmed.length, 1);
    // window 1: no keeper step at all
    await t.toWindow(2n);
    // window 2: GME trades at 40 USDG, above the signed ceiling of 30 (not a slippage bound on the current price)
    await t.dex.write.setRate([t.gme.address, 10n ** 18n, 40_000_000n]);
    const [waiting] = await k.tick();
    assert.equal(waiting.state, 'WAITING_PRICE');
    assert.match(waiting.stateDetail ?? '', /GME .*market price ~40000000 is above the FIXED max price 30000000.*not made up later/);
    assert.deepEqual(waiting.missed.map((m) => [m.window, m.reason]), [[1n, 'NOT_OBSERVED']]);
    assert.deepEqual(waiting.outlook, { missedWindows: 1, runsLeft: 2, windowsLeft: 2, allRunsStillPossible: true, unspendableRaw: 0n });
    // window 3: the price is back; one purchase, not two (no catch-up)
    await t.toWindow(3n);
    await t.dex.write.setRate([t.gme.address, 10n ** 18n, 25_000_000n]);
    const [late] = await k.tick();
    assert.deepEqual(late.missed.map((m) => [m.window, m.reason]), [[1n, 'NOT_OBSERVED'], [2n, 'WAITING_PRICE']]);
    assert.match(late.missed[1].detail ?? '', /market price ~40000000/);
    assert.deepEqual(late.outlook, { missedWindows: 2, runsLeft: 2, windowsLeft: 1, allRunsStillPossible: false, unspendableRaw: GROSS });
    await k.tick();
    const [bought] = await k.tick();
    // that was the last window: the job is over with a run and its budget left unused
    assert.deepEqual([bought.state, bought.confirmed.length, bought.outlook?.unspendableRaw], ['EXPIRED', 2, GROSS]);
    assert.equal((await t.state()).executions, 2);
    // expiry: 2 of 3 runs; one run's budget is never spent, and nothing more is taken
    await t.toWindow(BigInt(RUNS + 1));
    const [end] = await k.tick();
    assert.equal(end.state, 'EXPIRED');
    assert.deepEqual(end.outlook, { missedWindows: 2, runsLeft: 1, windowsLeft: 0, allRunsStillPossible: false, unspendableRaw: GROSS });
    assert.equal(end.missed.length, 2);
    assert.equal(start - (await t.ownerUsdg()), 2n * GROSS);
  });

  it('does not send within the inclusion slack before a window boundary; sends after it', async () => {
    const t = await setup();
    const k = t.makeKeeper(new MemoryKeeperStore(), t.chainFor(t.keeperA));
    await t.add(k);
    await t.rpc('evm_setNextBlockTimestamp', [Number(t.auth.schedule.startsAt + PERIOD - 30n)]);
    await t.rpc('evm_mine');
    const nonce = await t.nonceOf(t.keeperA);
    const [job] = await k.tick();
    assert.equal(job.state, 'DUE');
    assert.match(job.stateDetail ?? '', /window boundary/);
    assert.equal(await t.nonceOf(t.keeperA), nonce);
    await t.toWindow(1n);
    await k.tick();
    const [done] = await k.tick();
    assert.equal(done.confirmed.length, 1);
    assert.equal(done.confirmed[0].window, 1n);
  });

  it('a job past its expiry is EXPIRED; addJob refuses a signature that is not the owner\'s', async () => {
    const t = await setup();
    const k = t.makeKeeper(new MemoryKeeperStore(), t.chainFor(t.keeperA));
    const forged = await t.keeperA.signTypedData(recurringAuthorizationTypedData(t.auth, t.deployment) as any);
    await assert.rejects(k.addJob({ authorization: t.auth, ownerSignature: forged, deployment: t.deployment }), /owner signature/);
    await t.add(k);
    await t.toWindow(BigInt(RUNS + 2));
    assert.equal((await k.tick())[0].state, 'EXPIRED');
  });
});
