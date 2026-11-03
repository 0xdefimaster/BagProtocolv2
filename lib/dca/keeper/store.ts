import type { KeeperJob } from './types';

// -----------------------------------------------------------------------------
// Keeper store contract. Durable, NOT authoritative: the keeper re-reads the
// executor on every step. What must survive a crash is the write-ahead record
// (job.pending), so a restarted keeper reconciles a transaction it may have
// sent instead of sending a second one blind, and the nonce allocator, so two
// workers sharing a keeper account never reuse a nonce.
// -----------------------------------------------------------------------------

export interface KeeperStore {
  /** Inserts the job when its id is new. Returns the stored job (existing one when already present). */
  insert(job: KeeperJob): Promise<KeeperJob>;
  get(id: string): Promise<KeeperJob | null>;
  /** Replaces the job. Refused (false) unless `holder` holds an unexpired lease on it. */
  save(job: KeeperJob, holder: string, nowMs: number): Promise<boolean>;
  /**
   * Leases up to `limit` jobs that are not terminal (or still have a pending tx), whose lease is free or expired,
   * and that are due (`nextCheckMs <= nowMs`). Atomic: two workers never get the same job.
   */
  claimDue(holder: string, nowMs: number, ttlMs: number, limit: number): Promise<KeeperJob[]>;
  release(id: string, holder: string): Promise<void>;
  /** When the job should next be looked at (ms since epoch). */
  setNextCheck(id: string, nextCheckMs: number): Promise<void>;
  /**
   * Write-ahead with nonce allocation, atomically and serialised per keeper account: the nonce is the LOWEST nonce
   * ≥ `chainLatest` (the account's mined transaction count) that no other unresolved write-ahead record of
   * `job.pending.from` holds, so a nonce freed by a dropped or never-sent transaction is reused instead of leaving a
   * gap that would block every later transaction. Requires that the keeper account sends only through this store.
   * `job.pending` is stored with the nonce. Returns it, or null when `holder` lost the lease (nothing stored).
   */
  writeAhead(job: KeeperJob, holder: string, nowMs: number, chainLatest: number): Promise<number | null>;
  list(): Promise<KeeperJob[]>;
}

const BIG = '__bigint';
export const serializeJob = (job: KeeperJob): string => JSON.stringify(job, (_k, v) => (typeof v === 'bigint' ? { [BIG]: v.toString() } : v));
export const deserializeJob = (text: string | object): KeeperJob =>
  JSON.parse(typeof text === 'string' ? text : JSON.stringify(text), (_k, v) =>
    v && typeof v === 'object' && Object.keys(v).length === 1 && typeof v[BIG] === 'string' ? BigInt(v[BIG]) : v,
  );
const clone = (job: KeeperJob): KeeperJob => deserializeJob(serializeJob(job));

/** The lowest nonce ≥ `from` not in `held`. */
export function lowestFreeNonce(from: number, held: Iterable<number>): number {
  const h = new Set(held);
  let n = from;
  while (h.has(n)) n++;
  return n;
}

export const isActive = (job: KeeperJob) => !['COMPLETED', 'EXPIRED', 'REVOKED'].includes(job.state) || job.pending !== null;

/** In-memory store: tests, and a single-process paper run. Same semantics as the Postgres store. */
export class MemoryKeeperStore implements KeeperStore {
  private readonly jobs = new Map<string, { job: KeeperJob; nextCheckMs: number }>();

  async insert(job: KeeperJob) {
    const k = job.id.toLowerCase();
    const existing = this.jobs.get(k);
    if (existing) return clone(existing.job);
    this.jobs.set(k, { job: clone(job), nextCheckMs: 0 });
    return clone(job);
  }
  async get(id: string) {
    const j = this.jobs.get(id.toLowerCase());
    return j ? clone(j.job) : null;
  }
  async save(job: KeeperJob, holder: string, nowMs: number) {
    const j = this.jobs.get(job.id.toLowerCase());
    if (!j || j.job.lease?.holder !== holder || j.job.lease.until <= nowMs) return false;
    j.job = { ...clone(job), lease: j.job.lease };
    return true;
  }
  async claimDue(holder: string, nowMs: number, ttlMs: number, limit: number) {
    const out: KeeperJob[] = [];
    for (const j of [...this.jobs.values()].sort((a, b) => a.nextCheckMs - b.nextCheckMs)) {
      if (out.length >= limit) break;
      if (!isActive(j.job) || j.nextCheckMs > nowMs) continue;
      if (j.job.lease && j.job.lease.holder !== holder && j.job.lease.until > nowMs) continue;
      j.job.lease = { holder, until: nowMs + ttlMs };
      out.push(clone(j.job));
    }
    return out;
  }
  async release(id: string, holder: string) {
    const j = this.jobs.get(id.toLowerCase());
    if (j?.job.lease?.holder === holder) j.job.lease = null;
  }
  async setNextCheck(id: string, nextCheckMs: number) {
    const j = this.jobs.get(id.toLowerCase());
    if (j) j.nextCheckMs = nextCheckMs;
  }
  async writeAhead(job: KeeperJob, holder: string, nowMs: number, chainLatest: number) {
    if (!job.pending) throw new Error('writeAhead: job.pending is required');
    const from = job.pending.from.toLowerCase();
    const held = new Set<number>();
    for (const { job: other } of this.jobs.values()) {
      if (other.id.toLowerCase() !== job.id.toLowerCase() && other.pending && other.pending.nonce >= 0 && other.pending.from.toLowerCase() === from) held.add(other.pending.nonce);
    }
    const n = lowestFreeNonce(chainLatest, held);
    const next = { ...job, pending: { ...job.pending, nonce: n } };
    return (await this.save(next, holder, nowMs)) ? n : null;
  }
  async list() {
    return [...this.jobs.values()].map((j) => clone(j.job));
  }
}
