import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseEventLogs, zeroAddress } from 'viem';
import { ceilingMinTs, clone, DAY, E18, legAmountsTs, REVOCATION_TYPES, rng, setup, USDG, type Auth } from './helpers/dca-fixture';

// -----------------------------------------------------------------------------
// LOCAL (Hardhat EVM) stateful fuzz of BagDcaExecutor + UniswapV3ExactInAdapter.
// Random sequences of: execute by the keeper or an attacker, with right/wrong
// window, deadline, fees, floors and authorization; price moves above/below the
// ceilings; router misbehaviour; time jumps; tokens pushed into the executor
// and the adapter; revocation. After EVERY action the invariants below must
// hold. Seeded: a failure is reproducible from its seed.
//
//   I1  owner USDG spent == runs × amountPerRun (per authorization), never more than the budget
//   I2  runs ≤ maxRuns; at most one run per window; ≥ one period between runs
//   I3  only the signed allowedCaller ever gets a run through
//   I4  no run after revocation
//   I5  executor and adapter hold only what was pushed into them (no input or asset left from a run)
//   I6  no allowance left: executor→adapter, adapter→router
//   I7  each run delivered every asset to the recipient, each delta ≥ the ceiling minimum
//   I8  a reverted action changes nothing (counters, balances)
// -----------------------------------------------------------------------------

type Ctx = Awaited<ReturnType<typeof setup>>;

async function world(c: Ctx) {
  const tokens = [c.usdg, c.tsla, c.nvda];
  const holders = [c.executor.address, c.adapter.address];
  const snapshot = async (auths: Auth[]) => ({
    owner: (await c.usdg.read.balanceOf([c.auth.owner])) as bigint,
    recipient: await Promise.all([c.tsla, c.nvda].map((t) => t.read.balanceOf([c.auth.recipient]) as Promise<bigint>)),
    held: await Promise.all(holders.flatMap((h) => tokens.map((t) => t.read.balanceOf([h]) as Promise<bigint>))),
    allowances: [
      (await c.usdg.read.allowance([c.executor.address, c.adapter.address])) as bigint,
      (await c.usdg.read.allowance([c.adapter.address, c.router.address])) as bigint,
    ],
    states: await Promise.all(auths.map((a) => c.state(a))),
  });
  return { snapshot };
}

describe('BagDcaExecutor — stateful fuzz (local EVM)', () => {
  // CI runs 3 seeds; DCA_FUZZ_SEEDS=<n> runs n more, derived deterministically.
  const extra = Number(process.env.DCA_FUZZ_SEEDS ?? 0);
  const seeds = [0xa0d1, 0xb0d2, 0xc0d3, ...Array.from({ length: extra }, (_, i) => 0x1000 + i * 7919)];
  for (const seed of seeds) {
    it(`seed ${seed.toString(16)}: 200 random actions keep every invariant`, async () => {
      const c = await setup();
      const r = rng(seed);
      // Two authorizations of the same owner (different schedules), both bound to the keeper; the attacker tries both.
      const keeperOnly = clone(c.auth);
      keeperOnly.allowedCaller = c.keeper.account.address;
      keeperOnly.schedule = { ...keeperOnly.schedule, maxRuns: 30, totalBudget: USDG(300), periodSeconds: DAY, expiresAt: keeperOnly.schedule.startsAt + 40n * DAY };
      const anyCaller = clone(c.auth);
      anyCaller.nonce = 2n;
      anyCaller.schedule = { ...anyCaller.schedule, amountPerRun: USDG(3), maxRuns: 60, totalBudget: USDG(180), periodSeconds: DAY / 2n, expiresAt: anyCaller.schedule.startsAt + 40n * DAY };
      const auths = [keeperOnly, anyCaller];
      const sigs = await Promise.all(auths.map((a) => c.sign(a)));
      await c.usdgAsOwner.write.approve([c.executor.address, USDG(1000)]);
      const asAttacker = await c.viem.getContractAt('BagDcaExecutor', c.executor.address, { client: { wallet: c.other } });
      const w = await world(c);

      const pushed = { exec: [0n, 0n, 0n], adapter: [0n, 0n, 0n] }; // usdg, tsla, nvda pushed by "someone else"
      const runs: { auth: number; window: bigint; t: bigint }[] = [];
      const revoked = [false, false];
      let t = keeperOnly.schedule.startsAt - 3600n;
      let rateMode = 0; // 0 market under ceilings, 1 TSLA above its ceiling
      let actions = 0;
      let succeeded = 0;

      for (let step = 0; step < 200; step++) {
        const before = await w.snapshot(auths);
        const roll = r.next();
        let ok = false;
        let what = '';
        try {
          if (roll < 0.2) {
            t += BigInt(r.int(Number(DAY) / 5, Number(DAY) + Number(DAY) / 5));
            await c.testClient.setNextBlockTimestamp({ timestamp: t });
            await c.testClient.mine({ blocks: 1 });
            what = 'time';
            ok = true;
          } else if (roll < 0.24) {
            rateMode = r.next() < 0.3 ? 1 : 0; // TSLA above its ceiling about a third of the time
            await c.router.write.setRate([c.tsla.address, E18, USDG(rateMode ? 430 : r.int(395, 419))]);
            t += 1n;
            what = `rate ${rateMode}`;
            ok = true;
          } else if (roll < 0.27) {
            const k = r.int(0, 2);
            const target = r.next() < 0.5 ? 'exec' : 'adapter';
            const amount = BigInt(r.int(1, 10_000));
            await [c.usdg, c.tsla, c.nvda][k].write.mint([target === 'exec' ? c.executor.address : c.adapter.address, amount]);
            pushed[target][k] += amount;
            t += 1n;
            what = `push ${target}`;
            ok = true;
          } else if (roll < 0.29) {
            await c.router.write.setMisbehaviour([r.next() < 0.5 ? 10_000n : 9_000n, r.next() < 0.5 ? 0n : 1n, zeroAddress, r.next() < 0.5]);
            t += 1n;
            what = 'router misbehaves';
            ok = true;
          } else if (roll < 0.36) {
            await c.router.write.setMisbehaviour([10_000n, 0n, zeroAddress, false]);
            t += 1n;
            what = 'router honest';
            ok = true;
          } else if (roll < 0.375 && step > 150) {
            const i = r.int(0, 1);
            const id = c.idOf(auths[i]);
            const sig = await c.owner.signTypedData({ account: c.owner.account, domain: c.domain, types: REVOCATION_TYPES, primaryType: 'Revocation', message: { owner: c.auth.owner, authorizationId: id } });
            await c.executor.write.revokeBySig([c.auth.owner, id, sig]);
            revoked[i] = true;
            t += 1n;
            what = `revoke ${i}`;
            ok = true;
          } else {
            // execute, with random mistakes
            const i = r.int(0, 1);
            const a = auths[i];
            const attacker = r.next() < 0.35;
            const tNext = t + 1n;
            const inRange = tNext >= a.schedule.startsAt && tNext < a.schedule.expiresAt;
            const trueWindow = inRange ? (tNext - a.schedule.startsAt) / a.schedule.periodSeconds : 0n;
            const window = r.next() < 0.85 ? trueWindow : trueWindow + BigInt(r.int(1, 2));
            const fees = r.next() < 0.9 ? [3000, 3000] : r.next() < 0.5 ? [3000] : [3000, 10000];
            const floors = r.next() < 0.7 ? [] : [BigInt(r.int(0, 3)) * 10n ** 16n, 0n];
            const tamper = r.next() < 0.08;
            const sent = tamper ? { ...clone(a), recipient: c.other.account.address } : a;
            const run = { authorizationId: c.idOf(a), window, deadline: r.next() < 0.9 ? tNext + 600n : tNext - 1n, fees, minOutFloors: floors };
            await c.testClient.setNextBlockTimestamp({ timestamp: tNext });
            t = tNext;
            what = `execute ${i} ${attacker ? 'attacker' : 'keeper'}${tamper ? ' tampered' : ''}`;
            const hash = await (attacker ? asAttacker : c.executor).write.execute([sent, run, sigs[i]], { account: (attacker ? c.other : c.keeper).account });
            const receipt = await c.publicClient.waitForTransactionReceipt({ hash });
            ok = true;
            succeeded++;
            runs.push({ auth: i, window, t: tNext });
            // I3, I4: only an allowed caller, never after revocation, never a tampered authorization
            assert.ok(!attacker, `${what}: an attacker executed an authorization bound to the keeper`);
            assert.ok(!revoked[i], `${what}: executed after revocation`);
            assert.ok(!tamper, `${what}: a tampered authorization executed`);
            // I7: every asset delivered, each ≥ its ceiling minimum
            const delivered = parseEventLogs({ abi: c.executor.abi, logs: receipt.logs, eventName: 'AssetDelivered' }) as any[];
            assert.equal(delivered.length, 2);
            const legs = legAmountsTs(a.schedule.amountPerRun, a.assets);
            for (const [k, d] of delivered.entries()) {
              assert.ok(d.args.balanceAfter - d.args.balanceBefore >= ceilingMinTs(legs[k], a.assets[k]), `${what}: delivery below the ceiling minimum`);
            }
          }
        } catch (e) {
          // I8: a revert changes nothing
          if (e instanceof assert.AssertionError) throw e;
          ok = false;
          if (process.env.DCA_FUZZ_DEBUG) console.log(`    seed ${seed.toString(16)} step ${step} ${what}: ${(e as any)?.cause?.data?.errorName ?? (e as any)?.cause?.reason ?? String((e as Error).message).split('\n')[0].slice(0, 60)}`);
          await c.testClient.mine({ blocks: 1 }); // the failed send mined nothing; consume the timestamp
        }
        actions++;
        t = (await c.publicClient.getBlock({ blockTag: 'latest' })).timestamp; // the chain's clock, whatever the action mined
        const after = await w.snapshot(auths);
        if (!ok) {
          assert.deepEqual(after.states, before.states, `step ${step} (${what}) reverted but counters changed`);
          assert.equal(after.owner, before.owner, `step ${step} (${what}) reverted but the owner was debited`);
        }
        // I1, I2
        for (const [i, a] of auths.entries()) {
          const mine = runs.filter((x) => x.auth === i);
          assert.equal(after.states[i].runs, mine.length, `step ${step}: run count`);
          assert.equal(after.states[i].spent, BigInt(mine.length) * a.schedule.amountPerRun);
          assert.ok(mine.length <= a.schedule.maxRuns && after.states[i].spent <= a.schedule.totalBudget);
          assert.equal(new Set(mine.map((x) => x.window.toString())).size, mine.length, `step ${step}: two runs in one window`);
          for (let k = 1; k < mine.length; k++) assert.ok(mine[k].t - mine[k - 1].t >= a.schedule.periodSeconds, `step ${step}: runs closer than one period`);
        }
        const spent = auths.reduce((s, a, i) => s + BigInt(runs.filter((x) => x.auth === i).length) * a.schedule.amountPerRun, 0n);
        assert.equal(after.owner, USDG(1000) - spent, `step ${step}: owner debit ≠ runs × amount`);
        // I5, I6
        assert.deepEqual(after.held, [...pushed.exec, ...pushed.adapter], `step ${step} (${what}): executor/adapter hold more than was pushed into them`);
        assert.deepEqual(after.allowances, [0n, 0n], `step ${step}: allowance left`);
      }
      assert.ok(succeeded >= 3, `seed ${seed}: too few successful runs to be meaningful (${succeeded})`);
      console.log(`  seed ${seed.toString(16)}: ${actions} actions, ${succeeded} runs (${runs.filter((x) => x.auth === 0).length} daily, ${runs.filter((x) => x.auth === 1).length} half-daily), revoked ${revoked.join('/')}`);
    });
  }
});
