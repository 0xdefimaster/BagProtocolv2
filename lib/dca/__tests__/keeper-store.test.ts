import { describe, expect, it } from 'vitest';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hex } from 'viem';
import { deriveState } from '../keeper/keeper';
import { FileKeeperStore, MemoryKeeperStore, deserializeJobs, serializeJobs } from '../keeper/store';
import type { KeeperJob } from '../keeper/types';
import type { RecurringAuthorization } from '../../../packages/bag-sdk/src/recurring';

const A = '0x1111111111111111111111111111111111111111' as Hex;
const auth: RecurringAuthorization = {
  owner: A,
  sourceAccount: A,
  recipient: A,
  fundingKind: 0,
  fundingContract: A,
  inputToken: A,
  bag: { bagId: `0x${'aa'.repeat(32)}` as Hex, bagVersion: BigInt(1), compositionHash: `0x${'bb'.repeat(32)}` as Hex, definitionHash: `0x${'cc'.repeat(32)}` as Hex, strategyId: `0x${'00'.repeat(32)}` as Hex, strategyVersion: 0 },
  assets: [{ asset: '0x2222222222222222222222222222222222222222' as Hex, weightBps: 10_000, decimals: 18, maxPriceRaw: BigInt(25_000_000) }],
  schedule: { grossAmountPerRun: BigInt(5_000_000), totalBudget: BigInt(15_000_000), maxExecutions: 3, startsAt: BigInt(1_000), periodSeconds: BigInt(100), expiresAt: BigInt(1_400) },
  route: { router: A, swapTarget: A, allowedFees: [500] },
  nonce: BigInt(1),
};
const job = (id: string): KeeperJob => ({
  id: id as Hex,
  deployment: { chainId: 4663, executor: A, router: A },
  authorization: auth,
  ownerSignature: '0x12' as Hex,
  fundingProof: null,
  createdAt: 1,
  fromBlock: BigInt(7),
  state: 'SCHEDULED',
  stateDetail: null,
  nextDueAt: null,
  observed: null,
  pending: { window: BigInt(2), from: A, nonce: 3, hash: null, preparedAt: 4 },
  confirmed: [],
  attempts: [],
  lease: null,
});
const zero = { executions: 0, grossUsed: BigInt(0), lastWindow: BigInt(0), lastExecutionAt: BigInt(0), revoked: false };

describe('keeper store', () => {
  it('round-trips bigints exactly and refuses an unknown file format', () => {
    const j = job('0xab');
    expect(deserializeJobs(serializeJobs([j]))).toEqual([j]);
    expect(() => deserializeJobs('{"jobs":[]}')).toThrow(/unknown file format/);
  });

  it('file store: atomic replace (no temp file left), survives a new instance, and a lease excludes other holders until it expires', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'keeper-store-'));
    const path = join(dir, 'jobs.json');
    const s1 = new FileKeeperStore(path);
    await s1.put(job('0xAB'));
    await s1.put(job('0xcd'));
    const s2 = new FileKeeperStore(path);
    expect((await s2.list()).map((j) => j.id)).toEqual(['0xAB', '0xcd']);
    expect((await s2.get('0xab'))?.pending?.window).toBe(BigInt(2));
    expect(await s1.claim('0xab', 'one', 1_000, 500)).toBe(true);
    expect(await s2.claim('0xab', 'two', 1_200, 500)).toBe(false);
    expect(await s2.claim('0xab', 'two', 1_600, 500)).toBe(true); // expired
    await s1.release('0xab', 'one'); // not the holder: no effect
    expect((await s2.get('0xab'))?.lease?.holder).toBe('two');
    await s2.release('0xab', 'two');
    expect((await s1.get('0xab'))?.lease).toBeNull();
    expect((await readdir(dir)).sort()).toEqual(['jobs.json']);
  });

  it('file store: concurrent writers through the lock lose no update; a stale lock is taken over', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'keeper-store-'));
    const path = join(dir, 'jobs.json');
    await Promise.all(Array.from({ length: 12 }, (_, i) => new FileKeeperStore(path).put(job(`0x${i.toString(16).padStart(2, '0')}`))));
    expect((await new FileKeeperStore(path).list()).length).toBe(12);
    await writeFile(`${path}.lock`, '');
    const stale = new FileKeeperStore(path, { staleLockMs: 0, lockTimeoutMs: 2_000 });
    await stale.put(job('0xff'));
    expect(JSON.parse(await readFile(path, 'utf8')).jobs.length).toBe(13);
  });

  it('memory store: same contract (copies, leases)', async () => {
    const s = new MemoryKeeperStore();
    const j = job('0x01');
    await s.put(j);
    j.state = 'DUE';
    expect((await s.get('0x01'))?.state).toBe('SCHEDULED');
    expect(await s.claim('0x01', 'a', 0, 10)).toBe(true);
    expect(await s.claim('0x01', 'b', 5, 10)).toBe(false);
  });
});

describe('deriveState (the executor\'s calendar, from chain counters)', () => {
  it('scheduled, due, done-this-window with the next due time, completed, expired, revoked', () => {
    expect(deriveState(auth, zero, BigInt(999))).toMatchObject({ state: 'SCHEDULED', nextDueAt: BigInt(1_000) });
    expect(deriveState(auth, zero, BigInt(1_000))).toMatchObject({ state: 'DUE', window: BigInt(0) });
    // bought at 1050 in window 0: window 1 opens at 1100, but one full period since 1050 is 1150
    const once = { ...zero, executions: 1, grossUsed: BigInt(5_000_000), lastWindow: BigInt(0), lastExecutionAt: BigInt(1_050) };
    expect(deriveState(auth, once, BigInt(1_120))).toMatchObject({ state: 'DONE_THIS_WINDOW', nextDueAt: BigInt(1_150) });
    expect(deriveState(auth, once, BigInt(1_150))).toMatchObject({ state: 'DUE', window: BigInt(1) });
    // missed windows do not accumulate: still one purchase per window
    expect(deriveState(auth, once, BigInt(1_390))).toMatchObject({ state: 'DUE', window: BigInt(3) });
    expect(deriveState(auth, { ...once, executions: 3, grossUsed: BigInt(15_000_000) }, BigInt(1_390)).state).toBe('COMPLETED');
    expect(deriveState(auth, once, BigInt(1_400)).state).toBe('EXPIRED');
    expect(deriveState(auth, { ...once, revoked: true }, BigInt(1_150)).state).toBe('REVOKED');
    // the last purchase window passed and the next one would open at/after expiry
    expect(deriveState(auth, { ...once, executions: 2, lastWindow: BigInt(3), lastExecutionAt: BigInt(1_350) }, BigInt(1_360)).state).toBe('EXPIRED');
  });
});
