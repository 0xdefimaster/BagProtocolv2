import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { Pool } from 'pg';
import type { Hex } from 'viem';
import { DcaKeeper } from '../keeper/keeper';
import { PostgresKeeperStore } from '../keeper/postgres-store';
import type { KeeperJob } from '../keeper/types';
import { B, DEP, FakeChain, KEEPER, makeAuth, signAuth, START } from './fake-chain';

// -----------------------------------------------------------------------------
// INTEGRATION: PostgresKeeperStore against a REAL PostgreSQL (TEST_DATABASE_URL,
// a superuser connection; a scratch database is created and dropped). The chain
// is the in-memory FakeChain (no node). Run: npm run test:integration.
// -----------------------------------------------------------------------------

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. Integration tests need a real PostgreSQL; they never skip silently.');

const dbName = `dca_keeper_${crypto.randomBytes(4).toString('hex')}`;
const withDb = (u: string, db: string) => {
  const x = new URL(u);
  x.pathname = `/${db}`;
  return x.toString();
};
let admin: Pool;
let pool: Pool;
let store: PostgresKeeperStore;

beforeAll(async () => {
  admin = new Pool({ connectionString: url });
  await admin.query(`create database ${dbName}`);
  pool = new Pool({ connectionString: withDb(url, dbName), max: 20 });
  store = new PostgresKeeperStore(pool);
  await store.migrate();
  await store.migrate(); // idempotent
});

afterAll(async () => {
  await pool?.end();
  await admin?.query(`drop database if exists ${dbName} with (force)`);
  await admin?.end();
});

const id = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex;
function job(n: number): KeeperJob {
  const a = makeAuth(B(n));
  return {
    id: id(n), deployment: DEP, authorization: a, ownerSignature: '0x', createdAt: 0, fromBlock: B(1), state: 'SCHEDULED', stateDetail: null,
    nextDueAt: START, observed: null, pending: null, confirmed: [], blocker: null, accountedThrough: B(0), missed: [], attempts: [], lease: null,
  };
}

describe('PostgresKeeperStore', () => {
  it('insert is idempotent and round-trips bigints exactly', async () => {
    const j = job(1);
    j.authorization.assets[0].maxPriceRaw = (B(1) << B(255)) + B(7);
    await store.insert(j);
    await store.insert({ ...j, state: 'DUE' });
    const got = (await store.get(j.id))!;
    expect(got.state).toBe('SCHEDULED');
    expect(got.authorization.assets[0].maxPriceRaw).toBe((B(1) << B(255)) + B(7));
    expect(got.authorization.schedule.startsAt).toBe(START);
  });

  it('concurrent claims (FOR UPDATE SKIP LOCKED): 6 workers × 40 jobs → every job leased exactly once', async () => {
    for (let n = 100; n < 140; n++) await store.insert(job(n));
    const results = await Promise.all([...Array(6)].map((_, w) => store.claimDue(`w${w}`, 0, 60_000, 40)));
    const ids = results.flat().map((j) => j.id).filter((x) => BigInt(x) >= B(100) && BigInt(x) < B(140));
    expect(ids).toHaveLength(40);
    expect(new Set(ids).size).toBe(40);
    for (const [w, r] of results.entries()) for (const j of r) await store.release(j.id, `w${w}`);
  });

  it('leases use the database clock: save is refused without the lease; an expired lease can be taken over', async () => {
    const j = job(2);
    await store.insert(j);
    await store.setNextCheck(j.id, 0);
    const [mine] = (await store.claimDue('A', 0, 300, 100)).filter((x) => x.id === j.id);
    expect(mine.lease?.holder).toBe('A');
    expect(await store.save({ ...mine, state: 'DUE' }, 'B', 0)).toBe(false);
    expect(await store.save({ ...mine, state: 'DUE' }, 'A', 0)).toBe(true);
    expect((await store.claimDue('B', 0, 60_000, 100)).some((x) => x.id === j.id)).toBe(false);
    await new Promise((r) => setTimeout(r, 400));
    expect((await store.claimDue('B', 0, 60_000, 100)).some((x) => x.id === j.id)).toBe(true);
    expect(await store.save({ ...mine, state: 'WAITING_PRICE' }, 'A', 0)).toBe(false); // A lost it
    await store.release(j.id, 'B');
  });

  it('write-ahead allocates distinct nonces per keeper account under concurrency, starting at the chain pending count', async () => {
    const jobs = [...Array(12)].map((_, i) => job(200 + i));
    for (const j of jobs) await store.insert(j);
    for (const j of jobs) await store.setNextCheck(j.id, 0);
    const claimed = (await store.claimDue('N', 0, 60_000, 100)).filter((x) => jobs.some((j) => j.id === x.id));
    expect(claimed).toHaveLength(12);
    const nonces = await Promise.all(
      claimed.map((j) => store.writeAhead({ ...j, pending: { window: B(0), from: KEEPER, nonce: -1, hash: null, preparedAt: 0, run: { window: B(0), deadline: B(0), fees: [], minOutFloors: [] } } }, 'N', 0, 5)),
    );
    expect([...nonces].sort((a, b) => a! - b!)).toEqual([5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    // a write-ahead without the lease stores nothing
    expect(await store.writeAhead({ ...claimed[0], pending: { ...((await store.get(claimed[0].id))!.pending!) } }, 'other', 0, 0)).toBeNull();
    // clearing every record frees the nonces
    for (const j of claimed) await store.save({ ...(await store.get(j.id))!, pending: null }, 'N', 0);
    const again = await store.writeAhead({ ...claimed[0], pending: { window: B(0), from: KEEPER, nonce: -1, hash: null, preparedAt: 0, run: { window: B(0), deadline: B(0), fees: [], minOutFloors: [] } } }, 'N', 0, 3);
    expect(again).toBe(3);
    for (const j of claimed) await store.release(j.id, 'N');
  });

  it('the database refuses two unresolved write-ahead records with the same (account, nonce)', async () => {
    await expect(pool.query(`update dca_keeper.jobs set pending_from = $1, pending_nonce = 999 where id in ($2, $3)`, [KEEPER, id(100), id(101)])).rejects.toThrow(/jobs_pending_nonce_uq|duplicate key/);
  });

  it('events are append-only and record runs, attempts and missed windows', async () => {
    const j = job(3);
    await store.insert(j);
    await store.setNextCheck(j.id, 0);
    const [c] = (await store.claimDue('E', 0, 60_000, 100)).filter((x) => x.id === j.id);
    c.missed.push({ window: B(0), reason: 'WAITING_PRICE', detail: 'TSLA above ceiling' });
    c.attempts.push({ at: 1, window: B(1), outcome: 'DROPPED', detail: 'nonce 4 not in the mempool', hash: null });
    await store.save(c, 'E', 0);
    await store.save(c, 'E', 0); // no duplicates
    const ev = await store.events(j.id);
    expect(ev.map((e) => [e.kind, e.window])).toEqual([['MISSED_WINDOW', '0'], ['ATTEMPT', '1']]);
    await expect(pool.query(`delete from dca_keeper.events where job_id = $1`, [j.id])).rejects.toThrow(/append-only/);
    await expect(pool.query(`update dca_keeper.events set kind = 'RUN' where job_id = $1`, [j.id])).rejects.toThrow(/append-only/);
    await store.release(j.id, 'E');
  });

  it('two keeper processes on one Postgres store and one chain: each window bought exactly once over a whole schedule', async () => {
    const chain = new FakeChain();
    chain.allowance = B(10) ** B(12);
    const clock = { ms: Date.now() };
    const mk = (holder: string) => new DcaKeeper({ store, chain, mode: 'SEND', holder, now: () => clock.ms, pendingTimeoutMs: 600_000 });
    const k1 = mk('P1');
    const k2 = mk('P2');
    const auths = [makeAuth(B(9001)), makeAuth(B(9002)), makeAuth(B(9003))];
    for (const a of auths) await k1.addJob({ authorization: a, ownerSignature: await signAuth(a), deployment: DEP });
    for (let day = 0; day < 6; day++) {
      chain.at(START + B(day) * B(86_400) + B(100));
      for (let round = 0; round < 3; round++) {
        for (const j of await store.list()) await store.setNextCheck(j.id, 0);
        await Promise.all([k1.tick(), k2.tick()]);
        chain.mine();
        chain.at(chain.time + B(30));
      }
    }
    const runsPerAuth = new Map<string, bigint[]>();
    for (const l of chain.logs) runsPerAuth.set(l.id, [...(runsPerAuth.get(l.id) ?? []), l.window]);
    expect(runsPerAuth.size).toBe(3);
    for (const windows of runsPerAuth.values()) expect(windows).toEqual([B(0), B(1), B(2), B(3), B(4)]);
    for (const a of auths) {
      const j = (await store.list()).find((x) => x.authorization.nonce === a.nonce)!;
      expect(j.state).toBe('COMPLETED');
      expect(j.confirmed.filter((c) => !c.reorged).map((c) => c.verification)).toEqual(['VERIFIED', 'VERIFIED', 'VERIFIED', 'VERIFIED', 'VERIFIED']);
      expect((await store.events(j.id)).filter((e) => e.kind === 'RUN')).toHaveLength(5);
    }
  });
});
