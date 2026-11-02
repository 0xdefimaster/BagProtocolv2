import { describe, expect, it } from 'vitest';
import { dcaAuthorizationId, dcaCeilingMinimums } from '../../../packages/bag-sdk/src/dca';
import { DcaKeeper, planRun, type KeeperAlert } from '../keeper/keeper';
import { B, DAY, DEP, FakeChain, makeAuth, signAuth, START, TSLA } from './fake-chain';
import { MemoryKeeperStore } from '../keeper/store';

// -----------------------------------------------------------------------------
// Keeper state machine against an in-memory chain that applies the executor's
// own rules (SDK dcaRunDue, window, deadline, ceilings/floors). Unit tests:
// no node, no database. The real-executor run is contracts/test/BagDcaKeeper.test.ts
// (local Hardhat EVM); the Postgres store has its own integration test.
// -----------------------------------------------------------------------------

async function setup(o: { mode?: 'PAPER' | 'SEND'; store?: MemoryKeeperStore; chain?: FakeChain; holder?: string; clock?: { ms: number } } = {}) {
  const chain = o.chain ?? new FakeChain();
  const store = o.store ?? new MemoryKeeperStore();
  const alerts: KeeperAlert[] = [];
  const clock = o.clock ?? { ms: 1_000_000 };
  const keeper = new DcaKeeper({ store, chain, mode: o.mode ?? 'SEND', holder: o.holder ?? 'w1', now: () => clock.ms, onAlert: (a) => alerts.push(a), pendingTimeoutMs: 600_000 });
  const auth = makeAuth();
  const job = await keeper.addJob({ authorization: auth, ownerSignature: await signAuth(auth), deployment: DEP });
  /** Advances the wall clock by 20 s, makes every job due now, and ticks. */
  const tick = async () => {
    clock.ms += 20_000;
    for (const j of await store.list()) await store.setNextCheck(j.id, 0);
    return keeper.tick();
  };
  return { chain, store, keeper, alerts, auth, job, tick, clock };
}

describe('DcaKeeper', () => {
  it('addJob checks the owner signature and terms, and is idempotent', async () => {
    const { keeper, auth, job, store } = await setup();
    expect(job.id).toBe(dcaAuthorizationId(auth, DEP).toLowerCase());
    await expect(keeper.addJob({ authorization: auth, ownerSignature: await signAuth(makeAuth(B(2))), deployment: DEP })).rejects.toThrow(/signature/);
    const bad = { ...auth, schedule: { ...auth.schedule, totalBudget: B(1) } };
    await expect(keeper.addJob({ authorization: bad, ownerSignature: await signAuth(bad), deployment: DEP })).rejects.toThrow(/totalBudget/);
    await keeper.addJob({ authorization: auth, ownerSignature: await signAuth(auth), deployment: DEP });
    expect(await store.list()).toHaveLength(1);
  });

  it('runs once per window, records a VERIFIED run per window, then completes', async () => {
    const { chain, tick, store, job } = await setup();
    for (let k = 0; k < 5; k++) {
      chain.at(START + B(k) * DAY + B(100));
      const [j] = await tick();
      expect(j.state).toBe('PENDING_TX');
      chain.mine();
      const [after] = await tick();
      expect(after.state).toBe(k < 4 ? 'DONE_THIS_WINDOW' : 'COMPLETED');
      expect(after.confirmed.at(-1)!.verification).toBe('VERIFIED');
      expect(after.confirmed.at(-1)!.window).toBe(B(k));
    }
    chain.at(START + B(5) * DAY + B(1));
    expect(await tick()).toEqual([]); // terminal jobs are no longer claimed
    const done = (await store.get(job.id))!;
    expect(done.state).toBe('COMPLETED');
    expect(chain.sent).toHaveLength(5);
    expect(done.missed).toEqual([]);
  });

  it('crash between write-ahead and broadcast: the record is resolved as UNSENT and the window is still bought once', async () => {
    const { chain, tick } = await setup();
    chain.at(START + B(100));
    chain.sendMode = 'throwBeforeBroadcast';
    const [j] = await tick();
    expect(j.pending?.hash).toBeNull();
    chain.sendMode = 'ok';
    const [k] = await tick();
    expect(k.attempts.map((a) => a.outcome)).toContain('UNSENT');
    expect(k.state).toBe('PENDING_TX');
    chain.mine();
    const [m] = await tick();
    expect(m.confirmed).toHaveLength(1);
    expect(chain.sent).toHaveLength(1);
  });

  it('broadcast succeeded but the hash was never stored: reconciled by nonce, never sent twice', async () => {
    const { chain, tick } = await setup();
    chain.at(START + B(100));
    chain.sendMode = 'broadcastThenThrow';
    const [j] = await tick();
    expect(j.pending?.hash).toBeNull();
    chain.sendMode = 'ok';
    const [k] = await tick(); // tx is in the mempool (pending nonce > recorded): wait
    expect(k.state).toBe('PENDING_TX');
    expect(chain.sent).toHaveLength(1);
    chain.mine();
    const [m] = await tick();
    expect(m.confirmed).toHaveLength(1);
    expect(m.confirmed[0].verification).toBe('VERIFIED');
    expect(chain.sent).toHaveLength(1);
  });

  it('dropped transaction: DROPPED after the timeout, re-sent within the same window', async () => {
    const { chain, tick, alerts } = await setup();
    chain.at(START + B(100));
    await tick();
    chain.mempool = []; // dropped by the node
    const [j] = await tick();
    expect(j.attempts.map((a) => a.outcome)).toContain('DROPPED');
    expect(alerts.map((a) => a.kind)).toContain('TX_NOT_INCLUDED');
    chain.mine();
    const [k] = await tick();
    expect(k.confirmed).toHaveLength(1);
    expect(chain.sent).toHaveLength(2);
  });

  it('two independent keepers race for one window: one run, the other reverts and back-fills the winner', async () => {
    const chain = new FakeChain();
    const a = await setup({ chain, holder: 'A' });
    const b = await setup({ chain, holder: 'B' });
    chain.at(START + B(100));
    await a.tick();
    await b.tick();
    expect(chain.mempool).toHaveLength(2);
    chain.mine();
    const [ja] = await a.tick();
    const [jb] = await b.tick();
    expect(chain.logs).toHaveLength(1);
    expect(ja.confirmed).toHaveLength(1);
    expect(jb.confirmed).toHaveLength(1);
    expect(ja.confirmed[0].hash).toBe(jb.confirmed[0].hash);
    expect([...ja.attempts, ...jb.attempts].map((x) => x.outcome)).toContain('REVERTED');
  });

  it('a shared store leases each job to one worker at a time', async () => {
    const store = new MemoryKeeperStore();
    const { auth } = await setup({ store });
    const first = await store.claimDue('A', 2_000_000, 60_000, 10);
    expect(first).toHaveLength(1);
    expect(await store.claimDue('B', 2_000_000, 60_000, 10)).toHaveLength(0);
    expect(await store.save({ ...first[0], state: 'DUE' }, 'B', 2_000_000)).toBe(false);
    expect(await store.claimDue('B', 2_070_000, 60_000, 10)).toHaveLength(1); // A's lease expired
    expect(auth).toBeTruthy();
  });

  it('price above the ceiling: WAITING_PRICE, nothing sent; the closed window is logged as missed, never made up', async () => {
    const { chain, tick } = await setup();
    chain.prices.set(TSLA, B(430_000_000)); // ceiling 420
    chain.at(START + B(100));
    const [j] = await tick();
    expect(j.state).toBe('WAITING_PRICE');
    expect(j.stateDetail).toMatch(/TSLA/);
    expect(chain.sent).toHaveLength(0);
    chain.prices.set(TSLA, B(400_000_000));
    chain.at(START + DAY + B(100));
    const [k] = await tick();
    expect(k.missed).toEqual([{ window: B(0), reason: 'WAITING_PRICE', detail: expect.stringMatching(/TSLA/) }]);
    chain.mine();
    chain.at(START + DAY + B(200));
    const [m] = await tick();
    expect(m.confirmed.map((c) => c.window)).toEqual([B(1)]);
    expect(chain.sent).toHaveLength(1);
  });

  it('planRun picks the best signed tier, keeps floors at or above the ceiling minimum, and reports NO_ROUTE', async () => {
    const chain = new FakeChain();
    const auth = makeAuth();
    const p = await planRun(chain, auth, 100);
    expect(p.ok).toBe(true);
    if (p.ok) {
      expect(p.fees).toEqual([3000, 3000]);
      dcaCeilingMinimums(auth).forEach((m, i) => expect(p.floors[i] >= m).toBe(true));
    }
    const none = await planRun(chain, { ...auth, route: { ...auth.route, allowedFees: [500] } }, 100);
    expect(none).toMatchObject({ ok: false, reason: 'NO_ROUTE' });
  });

  it('funding and gas shortages: no transaction, a visible state, an alert for gas, the missed window logged', async () => {
    const { chain, tick, alerts } = await setup();
    chain.allowance = B(9_000_000);
    chain.at(START + B(100));
    expect((await tick())[0].state).toBe('FUNDING_SHORTAGE');
    chain.allowance = B(50_000_000);
    chain.keeperWei = B(1);
    chain.at(START + B(200));
    expect((await tick())[0].state).toBe('GAS_SHORTAGE');
    expect(alerts.map((a) => a.kind)).toContain('GAS_SHORTAGE');
    chain.at(START + DAY + B(10));
    const [j] = await tick();
    expect(j.missed[0]).toMatchObject({ window: B(0), reason: 'GAS_SHORTAGE' });
    expect(chain.sent).toHaveLength(0);
  });

  it('RPC failure: RPC_ERROR state and alert, nothing sent, recovers on the next tick', async () => {
    const { chain, tick, alerts } = await setup();
    chain.at(START + B(100));
    chain.failOp = 'getState';
    const [j] = await tick();
    expect(j.state).toBe('RPC_ERROR');
    expect(alerts.map((a) => a.kind)).toContain('RPC_ERROR');
    expect(chain.sent).toHaveLength(0);
    chain.failOp = null;
    expect((await tick())[0].state).toBe('PENDING_TX');
  });

  it('reorg: a recorded run whose block disappears is marked reorged; the chain counters decide and the window is bought again', async () => {
    const { chain, tick, alerts } = await setup();
    chain.at(START + B(100));
    await tick();
    chain.mine();
    expect((await tick())[0].confirmed).toHaveLength(1);
    chain.reorgLatest();
    chain.at(START + B(300));
    const [j] = await tick();
    expect(j.confirmed[0].reorged).toBe(true);
    expect(alerts.map((a) => a.kind)).toContain('REORG');
    expect(j.state).toBe('PENDING_TX'); // counters rolled back: due again, re-sent
    chain.mine();
    const [k] = await tick();
    expect(k.confirmed.filter((c) => !c.reorged)).toHaveLength(1);
  });

  it('PAPER mode never sends', async () => {
    const { chain, tick } = await setup({ mode: 'PAPER' });
    chain.keeper = null;
    chain.at(START + B(100));
    const [j] = await tick();
    expect(j.stateDetail).toMatch(/^PAPER: would send window 0/);
    expect(chain.sent).toHaveLength(0);
  });

  it('revoked on chain: REVOKED (terminal), nothing sent', async () => {
    const { chain, tick, job } = await setup();
    chain.states.set(job.id, { runs: 0, spent: B(0), lastWindow: B(0), lastRunAt: B(0), revoked: true });
    chain.at(START + B(100));
    expect((await tick())[0].state).toBe('REVOKED');
    expect(chain.sent).toHaveLength(0);
  });

  it('nonces: two jobs of one keeper account in the same tick get distinct nonces even when the node lags', async () => {
    const chain = new FakeChain();
    chain.pendingLag = true;
    const s = await setup({ chain });
    const b = makeAuth(B(2));
    await s.keeper.addJob({ authorization: b, ownerSignature: await signAuth(b), deployment: DEP });
    chain.at(START + B(100));
    chain.allowance = B(100_000_000);
    const jobs = await s.tick();
    const nonces = jobs.map((j) => j.pending!.nonce).sort();
    expect(nonces).toEqual([0, 1]);
  });
});
