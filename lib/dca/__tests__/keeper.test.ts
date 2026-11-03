import { describe, expect, it } from 'vitest';
import { dcaAuthorizationId, dcaCeilingMinimums } from '../../../packages/bag-sdk/src/dca';
import { DcaKeeper, planRun, type KeeperAlert } from '../keeper/keeper';
import { B, DAY, DEP, FAKE_EXECUTOR_CODE_HASH, FakeChain, KEEPER, makeAuth, NVDA, signAuth, START, TSLA } from './fake-chain';
import { MemoryKeeperStore } from '../keeper/store';

// -----------------------------------------------------------------------------
// Keeper state machine against an in-memory chain that applies the executor's
// own rules (SDK dcaRunDue, window, deadline, ceilings/floors). Unit tests:
// no node, no database. The real-executor run is contracts/test/BagDcaKeeper.test.ts
// (local Hardhat EVM); the Postgres store has its own integration test.
// -----------------------------------------------------------------------------

async function setup(o: { mode?: 'PAPER' | 'SEND'; store?: MemoryKeeperStore; chain?: FakeChain; holder?: string; clock?: { ms: number }; keeperOptions?: Partial<ConstructorParameters<typeof DcaKeeper>[0]> } = {}) {
  const chain = o.chain ?? new FakeChain();
  const store = o.store ?? new MemoryKeeperStore();
  const alerts: KeeperAlert[] = [];
  const clock = o.clock ?? { ms: 1_000_000 };
  const keeper = new DcaKeeper({
    store, chain, mode: o.mode ?? 'SEND', holder: o.holder ?? 'w1', now: () => clock.ms, onAlert: (a) => alerts.push(a), pendingTimeoutMs: 600_000,
    executorCodeHash: FAKE_EXECUTOR_CODE_HASH, assetAllowed: (a) => [TSLA, NVDA].includes(a), ...(o.keeperOptions ?? {}),
  });
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
    expect((await tick())[0].state).toBe('PENDING_TX'); // 20 s: inside the drop grace period
    const [j] = await tick();
    expect(j.attempts.map((a) => a.outcome)).toContain('DROPPED');
    expect(alerts.map((a) => a.kind)).toContain('TX_NOT_INCLUDED');
    chain.mine();
    const [k] = await tick();
    expect(k.confirmed).toHaveLength(1);
    expect(chain.sent).toHaveLength(2);
  });

  it('two keepers sharing one account but NOT one store (a misconfiguration) race: still one run; the loser back-fills it', async () => {
    const chain = new FakeChain();
    const a = await setup({ chain, holder: 'A' });
    const b = await setup({ chain, holder: 'B' });
    chain.at(START + B(100));
    await a.tick();
    await b.tick(); // B allocates the same nonce (it cannot see A's write-ahead); the node refuses it as an underpriced replacement
    chain.mine();
    const [ja] = await a.tick();
    const [jb] = await b.tick();
    expect(chain.logs).toHaveLength(1);
    expect(ja.confirmed).toHaveLength(1);
    expect(jb.confirmed).toHaveLength(1);
    expect(ja.confirmed[0].hash).toBe(jb.confirmed[0].hash);
    expect(jb.pending).toBeNull();
    expect(jb.attempts.map((x) => x.outcome)).toContain('UNSENT');
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

  it('SEND mode refuses to start without the reviewed executor code hash or a token policy', async () => {
    const chain = new FakeChain();
    const store = new MemoryKeeperStore();
    expect(() => new DcaKeeper({ store, chain, mode: 'SEND', holder: 'x', assetAllowed: () => true })).toThrow(/executorCodeHash/);
    expect(() => new DcaKeeper({ store, chain, mode: 'SEND', holder: 'x', executorCodeHash: FAKE_EXECUTOR_CODE_HASH })).toThrow(/assetAllowed/);
  });

  it('addJob refuses: another executor build, assets outside the token policy, an authorization for another caller', async () => {
    const chain = new FakeChain();
    const { keeper } = await setup({ chain });
    const a = makeAuth(B(7));
    chain.executorCode = '0x6002';
    await expect(keeper.addJob({ authorization: a, ownerSignature: await signAuth(a), deployment: DEP })).rejects.toThrow(/code hash/);
    chain.executorCode = '0x6001600155';
    const strict = new DcaKeeper({ store: new MemoryKeeperStore(), chain, mode: 'SEND', holder: 's', executorCodeHash: FAKE_EXECUTOR_CODE_HASH, assetAllowed: (x) => x === TSLA });
    await expect(strict.addJob({ authorization: a, ownerSignature: await signAuth(a), deployment: DEP })).rejects.toThrow(/token policy.*NVDA/);
    const other = { ...makeAuth(B(8)), allowedCaller: '0x00000000000000000000000000000000000000cc' as const };
    await expect(keeper.addJob({ authorization: other, ownerSignature: await signAuth(other), deployment: DEP })).rejects.toThrow(/may only be executed by/);
  });

  it('every run is verified against the reviewed executor code; a run under different code is not VERIFIED', async () => {
    const { chain, tick, alerts } = await setup();
    chain.at(START + B(100));
    await tick();
    chain.mine();
    const [j] = await tick();
    expect(j.confirmed[0]).toMatchObject({ verification: 'VERIFIED', codeChecked: true });
    chain.at(START + DAY + B(100));
    await tick();
    chain.executorCode = '0x6002'; // the code at the address changed (e.g. a different deployment answered)
    chain.mine();
    const [k] = await tick();
    expect(k.confirmed[1].verification).toBe('FAILED');
    expect(alerts.map((a) => a.kind)).toContain('VERIFICATION_NOT_VERIFIED');
  });

  it('confirmations: a run below minConfirmations is INDETERMINATE, then re-verified VERIFIED once deep enough; finalized runs stop being re-checked', async () => {
    const { chain, tick } = await setup({ keeperOptions: { minConfirmations: B(3), reorgDepth: B(2) } });
    chain.at(START + B(100));
    await tick();
    chain.mine();
    const [j] = await tick();
    expect(j.confirmed[0].verification).toBe('INDETERMINATE');
    chain.mine();
    chain.mine();
    const [k] = await tick();
    expect(k.confirmed.filter((c) => !c.reorged).map((c) => c.verification)).toEqual(['VERIFIED']);
    chain.finalized = chain.blockNumber;
    const [m] = await tick();
    expect(m.confirmed[0].finalized).toBe(true);
  });

  it('stuck broadcast: replaced with the same nonce and a higher gas price, STUCK_NONCE after the limit, never cleared or duplicated', async () => {
    const { chain, tick, alerts } = await setup();
    chain.minIncludedGasPrice = B(10) ** B(12); // nothing at 1 gwei gets in
    chain.at(START + B(100));
    const [j] = await tick();
    const nonce = j.pending!.nonce;
    for (let i = 0; i < 4; i++) {
      await tick(); // 20 s
      await tick(); // 40 s
      await tick(); // 60 s → replacement due
      chain.mine();
    }
    const [k] = await tick();
    expect(k.pending!.nonce).toBe(nonce);
    expect(k.attempts.filter((a) => a.outcome === 'REPLACED').length).toBe(3);
    expect(alerts.map((a) => a.kind)).toContain('STUCK_NONCE');
    expect(new Set(chain.mempool.map((t) => t.nonce)).size).toBe(1);
    chain.minIncludedGasPrice = B(0);
    chain.mine();
    const [m] = await tick();
    expect(m.pending).toBeNull();
    expect(m.confirmed).toHaveLength(1);
    expect(chain.logs).toHaveLength(1);
  });

  it('stuck past the run deadline: cancelled at the same nonce, the nonce freed, the window bought by a fresh run', async () => {
    const { chain, tick } = await setup({ keeperOptions: { deadlineSeconds: B(60) } });
    chain.minIncludedGasPrice = B(1_500_000_000); // 1 and 1.25 gwei stay stuck; the second cancel (1.5625 gwei) gets in
    chain.at(START + B(100));
    await tick();
    chain.at(START + B(400)); // past the 60 s deadline
    await tick();
    await tick();
    const [j] = await tick();
    expect(j.attempts.map((a) => a.outcome)).toContain('CANCEL_SENT');
    for (let i = 0; i < 6 && chain.mempool.length && chain.mempool[0].gasPrice < chain.minIncludedGasPrice; i++) {
      await tick();
      await tick();
      await tick();
    }
    chain.mine();
    const [k] = await tick(); // cancel mined → CANCELLED → same tick sends a fresh run
    expect(k.attempts.map((a) => a.outcome)).toContain('CANCELLED');
    chain.minIncludedGasPrice = B(0);
    chain.mine();
    const [m] = await tick();
    expect(m.confirmed.map((c) => c.window)).toEqual([B(0)]);
    expect(chain.logs).toHaveLength(1);
    expect(KEEPER).toBeTruthy();
  });

  it('a nonce freed by a dropped transaction is reused (no nonce gap blocks the other jobs)', async () => {
    const chain = new FakeChain();
    const s = await setup({ chain });
    const b = makeAuth(B(2));
    await s.keeper.addJob({ authorization: b, ownerSignature: await signAuth(b), deployment: DEP });
    chain.allowance = B(100_000_000);
    chain.at(START + B(100));
    const first = await s.tick(); // A → nonce 0, B → nonce 1
    expect(first.map((j) => j.pending!.nonce).sort()).toEqual([0, 1]);
    const a = first.find((j) => j.pending!.nonce === 0)!;
    chain.mempool = chain.mempool.filter((t) => t.nonce !== 0); // the node drops nonce 0; nonce 1 now waits behind a gap
    chain.mine();
    expect(chain.logs).toHaveLength(0);
    await s.tick(); // inside the drop grace
    const again = await s.tick(); // A: DROPPED → re-sent, must reuse nonce 0
    expect(again.find((j) => j.id === a.id)!.pending!.nonce).toBe(0);
    chain.mine();
    await s.tick();
    expect(chain.logs).toHaveLength(2); // both jobs bought window 0
  });
});

