import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { keccak256, type Hex } from 'viem';
import { createViemKeeperChain } from '../../lib/dca/keeper/chain';
import { DcaKeeper, type KeeperAlert } from '../../lib/dca/keeper/keeper';
import { MemoryKeeperStore } from '../../lib/dca/keeper/store';
import { DAY, E18, setup, USDG } from './helpers/dca-fixture';

// -----------------------------------------------------------------------------
// LOCAL (Hardhat EVM) end-to-end: the production keeper code (lib/dca/keeper,
// viem chain adapter, SDK verifier) driving the real BagDcaExecutor and
// UniswapV3ExactInAdapter over mock Uniswap. Keys are Hardhat test accounts.
// Not a fork and not a mainnet test.
// -----------------------------------------------------------------------------

describe('DcaKeeper → BagDcaExecutor (local EVM)', () => {
  it('buys each window once, verifies every run, logs a window lost to the price ceiling, and stops at the budget', async () => {
    const c = await setup();
    const quoter = await c.viem.deployContract('DcaMockQuoterV2', [c.router.address, c.v3.address]);
    const chain = createViemKeeperChain({ publicClient: c.publicClient as any, walletClient: c.keeper as any, quoter: quoter.address, v3Factory: c.v3.address });
    const alerts: KeeperAlert[] = [];
    const store = new MemoryKeeperStore();
    let wall = 1_000_000;
    // The reviewed build's runtime for these constructor arguments: here the code this test just deployed.
    const executorCodeHash = keccak256((await c.publicClient.getCode({ address: c.executor.address }))!);
    const tokens = [c.tsla.address, c.nvda.address].map((x) => x.toLowerCase());
    const keeper = new DcaKeeper({
      store, chain, mode: 'SEND', holder: 'local', now: () => wall, onAlert: (a) => alerts.push(a),
      executorCodeHash, assetAllowed: (a) => tokens.includes(a.toLowerCase()),
    });
    const deployment = { chainId: c.chainId, executor: c.executor.address };
    const job = await keeper.addJob({ authorization: c.auth, ownerSignature: await c.sign(c.auth), deployment });
    const tickAt = async (t: bigint) => {
      await c.testClient.setNextBlockTimestamp({ timestamp: t });
      await c.testClient.mine({ blocks: 1 });
      wall += 60_000;
      for (const j of await store.list()) await store.setNextCheck(j.id, 0);
      return (await keeper.tick())[0] ?? (await store.get(job.id))!;
    };
    const s = c.auth.schedule.startsAt;

    // window 0: sent and mined (automine), next tick records it
    let j = await tickAt(s + 100n);
    assert.equal(j.state, 'PENDING_TX', `${j.state}: ${j.stateDetail}`);
    j = await tickAt(s + 200n);
    assert.equal(j.state, 'DONE_THIS_WINDOW');
    assert.equal(j.confirmed[0].verification, 'VERIFIED');

    // window 1: TSLA above its 420 ceiling the whole window → nothing sent
    // (ticks sit 300 s into each window: a run must also be ≥ one period after the previous one)
    await c.router.write.setRate([c.tsla.address, E18, USDG(450)]);
    j = await tickAt(s + DAY + 300n);
    assert.equal(j.state, 'WAITING_PRICE');
    await c.router.write.setRate([c.tsla.address, E18, USDG(400)]);

    // windows 2–5: bought; window 1 recorded as missed (WAITING_PRICE), never made up
    for (const w of [2n, 3n, 4n]) {
      // each run lands ~1 s after its tick, so the earliest next run drifts by that much (min-gap rule)
      j = await tickAt(s + w * DAY + 300n + w * 10n);
      assert.equal(j.state, 'PENDING_TX', `window ${w}: ${j.stateDetail}`);
      j = await tickAt(s + w * DAY + 400n + w * 10n);
      assert.equal(j.state, w === 4n ? 'EXPIRED' : 'DONE_THIS_WINDOW', `window ${w}`);
    }
    assert.deepEqual(j.missed.map((m) => [m.window, m.reason]), [[1n, 'WAITING_PRICE']]);
    assert.deepEqual(j.confirmed.map((r) => [r.window, r.verification, r.codeChecked]), [[0n, 'VERIFIED', true], [2n, 'VERIFIED', true], [3n, 'VERIFIED', true], [4n, 'VERIFIED', true]]);
    const st = await c.state(c.auth);
    assert.equal(st.runs, 4);
    assert.equal(await c.bal(c.usdg, c.auth.owner), USDG(1000) - USDG(40), 'one run (10 USDG) was never spent');
    assert.equal(alerts.filter((a) => a.kind === 'VERIFICATION_NOT_VERIFIED').length, 0);
    assert.equal((j.attempts as unknown[]).length, 0);
    assert.ok(((await c.publicClient.getTransactionCount({ address: c.keeper.account.address as Hex })) as number) > 0);
  });
});
