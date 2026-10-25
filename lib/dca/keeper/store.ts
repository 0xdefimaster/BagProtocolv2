import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { KeeperJob } from './types';

// -----------------------------------------------------------------------------
// Keeper job store. Durable, but NOT authoritative: the keeper re-reads the
// executor's counters on every step. What must survive a restart is the
// write-ahead record of a transaction in flight (job.pending), so the keeper can
// find out what happened to it instead of sending a second one blind.
// -----------------------------------------------------------------------------

export interface KeeperStore {
  list(): Promise<KeeperJob[]>;
  get(id: string): Promise<KeeperJob | null>;
  /** Insert or replace, atomically. */
  put(job: KeeperJob): Promise<void>;
  /** Takes the job's lease when it is free, expired or already ours. False when another holder has it. */
  claim(id: string, holder: string, nowMs: number, ttlMs: number): Promise<boolean>;
  release(id: string, holder: string): Promise<void>;
}

const BIG = '__bigint';
export const serializeJobs = (jobs: KeeperJob[]): string =>
  JSON.stringify({ schema: 'bag-dca-keeper-store/v1', jobs }, (_k, v) => (typeof v === 'bigint' ? { [BIG]: v.toString() } : v), 2);
export const deserializeJobs = (text: string): KeeperJob[] => {
  const doc = JSON.parse(text, (_k, v) => (v && typeof v === 'object' && Object.keys(v).length === 1 && typeof v[BIG] === 'string' ? BigInt(v[BIG]) : v));
  if (doc?.schema !== 'bag-dca-keeper-store/v1' || !Array.isArray(doc.jobs)) throw new Error('keeper store: unknown file format');
  return doc.jobs as KeeperJob[];
};
const clone = (job: KeeperJob): KeeperJob => deserializeJobs(serializeJobs([job]))[0];

const leaseFree = (job: KeeperJob, holder: string, nowMs: number) => !job.lease || job.lease.holder === holder || job.lease.until <= nowMs;

/** In-memory store (tests, or a keeper that relies on the chain alone). */
export class MemoryKeeperStore implements KeeperStore {
  private readonly jobs = new Map<string, KeeperJob>();
  async list() {
    return [...this.jobs.values()].map(clone);
  }
  async get(id: string) {
    const j = this.jobs.get(id.toLowerCase());
    return j ? clone(j) : null;
  }
  async put(job: KeeperJob) {
    this.jobs.set(job.id.toLowerCase(), clone(job));
  }
  async claim(id: string, holder: string, nowMs: number, ttlMs: number) {
    const j = this.jobs.get(id.toLowerCase());
    if (!j || !leaseFree(j, holder, nowMs)) return false;
    j.lease = { holder, until: nowMs + ttlMs };
    return true;
  }
  async release(id: string, holder: string) {
    const j = this.jobs.get(id.toLowerCase());
    if (j?.lease?.holder === holder) j.lease = null;
  }
}

/**
 * One JSON file. Every change is read-modify-write under an exclusive lock file (O_EXCL), written to a temp
 * file, fsynced and renamed over the store, so a crash leaves either the old or the new file, never half of one.
 * Several keeper processes may share the file; the per-job lease keeps them from sending for the same job.
 */
export class FileKeeperStore implements KeeperStore {
  constructor(
    readonly path: string,
    private readonly opts: { lockTimeoutMs?: number; staleLockMs?: number } = {},
  ) {}

  private async read(): Promise<KeeperJob[]> {
    try {
      return deserializeJobs(await readFile(this.path, 'utf8'));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
  }

  private async write(jobs: KeeperJob[]): Promise<void> {
    const tmp = `${this.path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    const fh = await open(tmp, 'w');
    try {
      await fh.writeFile(serializeJobs(jobs), 'utf8');
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, this.path);
  }

  private async locked<T>(fn: (jobs: KeeperJob[]) => Promise<{ result: T; jobs?: KeeperJob[] }>): Promise<T> {
    await mkdir(dirname(this.path), { recursive: true });
    const lock = `${this.path}.lock`;
    const deadline = Date.now() + (this.opts.lockTimeoutMs ?? 10_000);
    for (let wait = 5; ; wait = Math.min(wait * 2, 200)) {
      try {
        const fh = await open(lock, 'wx');
        await fh.close();
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        const s = await stat(lock).catch(() => null);
        if (s && Date.now() - s.mtimeMs > (this.opts.staleLockMs ?? 30_000)) await rm(lock, { force: true });
        else if (Date.now() > deadline) throw new Error('keeper store: lock timeout');
        await new Promise((r) => setTimeout(r, wait));
      }
    }
    try {
      const out = await fn(await this.read());
      if (out.jobs) await this.write(out.jobs);
      return out.result;
    } finally {
      await rm(lock, { force: true });
    }
  }

  async list() {
    return this.locked(async (jobs) => ({ result: jobs }));
  }
  async get(id: string) {
    return this.locked(async (jobs) => ({ result: jobs.find((j) => j.id.toLowerCase() === id.toLowerCase()) ?? null }));
  }
  async put(job: KeeperJob) {
    return this.locked(async (jobs) => ({ result: undefined, jobs: [...jobs.filter((j) => j.id.toLowerCase() !== job.id.toLowerCase()), clone(job)] }));
  }
  async claim(id: string, holder: string, nowMs: number, ttlMs: number) {
    return this.locked(async (jobs) => {
      const j = jobs.find((x) => x.id.toLowerCase() === id.toLowerCase());
      if (!j || !leaseFree(j, holder, nowMs)) return { result: false };
      j.lease = { holder, until: nowMs + ttlMs };
      return { result: true, jobs };
    });
  }
  async release(id: string, holder: string) {
    return this.locked(async (jobs) => {
      const j = jobs.find((x) => x.id.toLowerCase() === id.toLowerCase());
      if (j?.lease?.holder !== holder) return { result: undefined };
      j.lease = null;
      return { result: undefined, jobs };
    });
  }
}
