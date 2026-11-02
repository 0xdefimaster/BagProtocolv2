import type { Pool, PoolClient } from 'pg';
import type { Hex } from 'viem';
import { deserializeJob, isActive, serializeJob, type KeeperStore } from './store';
import type { KeeperJob } from './types';

// -----------------------------------------------------------------------------
// PostgreSQL keeper store. Lives in its own schema (`dca_keeper`) in a database
// the keeper owns: it is NOT part of the app's Supabase schema and must never
// be exposed through PostgREST. Leases use the DATABASE clock (now()), so
// workers with drifting clocks still exclude each other. Claims use
// FOR UPDATE SKIP LOCKED. The write-ahead record and its nonce are written in
// one transaction under a per-account row lock, and a unique index forbids
// two unresolved write-ahead records with the same (account, nonce).
// `dca_keeper.events` is append-only: runs, attempts and missed windows.
// -----------------------------------------------------------------------------

export const DCA_KEEPER_SCHEMA_VERSION = 1;

export const DCA_KEEPER_SCHEMA_SQL = `
create schema if not exists dca_keeper;

create table if not exists dca_keeper.schema_version (
  version integer primary key,
  applied_at timestamptz not null default now()
);

create table if not exists dca_keeper.jobs (
  id text primary key check (id ~ '^0x[0-9a-f]{64}$'),
  chain_id integer not null,
  executor text not null check (executor ~ '^0x[0-9a-f]{40}$'),
  owner_address text not null,
  state text not null,
  active boolean not null,
  next_check_at timestamptz not null default now(),
  lease_holder text,
  lease_until timestamptz,
  pending_from text,
  pending_nonce bigint check (pending_nonce is null or pending_nonce >= 0),
  doc jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((pending_from is null) = (pending_nonce is null))
);

create index if not exists jobs_due_idx on dca_keeper.jobs (next_check_at) where active;
create unique index if not exists jobs_pending_nonce_uq on dca_keeper.jobs (pending_from, pending_nonce) where pending_nonce is not null;

create table if not exists dca_keeper.accounts (
  address text primary key check (address ~ '^0x[0-9a-f]{40}$')
);

create table if not exists dca_keeper.events (
  id bigserial primary key,
  job_id text not null references dca_keeper.jobs(id),
  at timestamptz not null default now(),
  kind text not null check (kind in ('RUN', 'ATTEMPT', 'MISSED_WINDOW')),
  window_index numeric(78, 0),
  detail jsonb not null
);
create index if not exists events_job_idx on dca_keeper.events (job_id, id);

create or replace function dca_keeper.events_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'dca_keeper.events is append-only';
end $$;
drop trigger if exists events_append_only on dca_keeper.events;
create trigger events_append_only before update or delete on dca_keeper.events for each row execute function dca_keeper.events_append_only();

insert into dca_keeper.schema_version (version) values (1) on conflict do nothing;
`;

const bigText = (v: bigint | null | undefined) => (v === null || v === undefined ? null : v.toString());

export class PostgresKeeperStore implements KeeperStore {
  constructor(private readonly pool: Pool) {}

  /** Creates the schema (idempotent). Run once per deployment, by the keeper's own database role. */
  async migrate(): Promise<void> {
    const c = await this.pool.connect();
    try {
      await c.query('begin');
      await c.query("select pg_advisory_xact_lock(hashtext('dca_keeper.migrate'))");
      await c.query(DCA_KEEPER_SCHEMA_SQL);
      await c.query('commit');
    } catch (e) {
      await c.query('rollback');
      throw e;
    } finally {
      c.release();
    }
  }

  private async tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query('begin');
      const out = await fn(c);
      await c.query('commit');
      return out;
    } catch (e) {
      await c.query('rollback');
      throw e;
    } finally {
      c.release();
    }
  }

  private static row(job: KeeperJob) {
    return {
      state: job.state,
      active: isActive(job),
      pendingFrom: job.pending && job.pending.nonce >= 0 ? job.pending.from.toLowerCase() : null,
      pendingNonce: job.pending && job.pending.nonce >= 0 ? job.pending.nonce : null,
    };
  }

  async insert(job: KeeperJob): Promise<KeeperJob> {
    const r = PostgresKeeperStore.row(job);
    const doc = serializeJob({ ...job, lease: null });
    await this.pool.query(
      `insert into dca_keeper.jobs (id, chain_id, executor, owner_address, state, active, doc)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb) on conflict (id) do nothing`,
      [job.id.toLowerCase(), job.deployment.chainId, job.deployment.executor.toLowerCase(), job.authorization.owner.toLowerCase(), r.state, r.active, doc],
    );
    return (await this.get(job.id))!;
  }

  async get(id: string): Promise<KeeperJob | null> {
    const { rows } = await this.pool.query(
      `select doc, lease_holder, (extract(epoch from lease_until) * 1000)::bigint::text as lease_ms from dca_keeper.jobs where id = $1`,
      [id.toLowerCase()],
    );
    return rows[0] ? PostgresKeeperStore.fromRow(rows[0]) : null;
  }

  private static fromRow(row: { doc: object; lease_holder: string | null; lease_ms: string | null }): KeeperJob {
    const job = deserializeJob(row.doc);
    job.lease = row.lease_holder && row.lease_ms ? { holder: row.lease_holder, until: Number(row.lease_ms) } : null;
    return job;
  }

  /** `nowMs` is ignored: leases are checked against the database clock. */
  async save(job: KeeperJob, holder: string, _nowMs?: number): Promise<boolean> {
    return this.tx(async (c) => this.saveIn(c, job, holder));
  }

  private async saveIn(c: PoolClient, job: KeeperJob, holder: string): Promise<boolean> {
    const { rows } = await c.query(
      `select doc, lease_holder = $2 and lease_until > now() as held from dca_keeper.jobs where id = $1 for update`,
      [job.id.toLowerCase(), holder],
    );
    if (!rows[0]?.held) return false;
    const before = deserializeJob(rows[0].doc);
    const r = PostgresKeeperStore.row(job);
    await c.query(
      `update dca_keeper.jobs set doc = $2::jsonb, state = $3, active = $4, pending_from = $5, pending_nonce = $6, updated_at = now() where id = $1`,
      [job.id.toLowerCase(), serializeJob({ ...job, lease: null }), r.state, r.active, r.pendingFrom, r.pendingNonce],
    );
    // Append-only log of what is new since the stored version.
    const known = new Set(before.confirmed.map((x) => `${x.hash}:${x.blockHash}:${x.reorged}`));
    const events: [string, bigint | null, object][] = [
      ...job.missed.slice(before.missed.length).map((m) => ['MISSED_WINDOW', m.window, m] as [string, bigint, object]),
      ...job.attempts.slice(before.attempts.length).map((a) => ['ATTEMPT', a.window, a] as [string, bigint | null, object]),
      ...job.confirmed.filter((x) => !known.has(`${x.hash}:${x.blockHash}:${x.reorged}`)).map((x) => ['RUN', x.window, x] as [string, bigint, object]),
    ];
    for (const [kind, window, detail] of events) {
      await c.query(`insert into dca_keeper.events (job_id, kind, window_index, detail) values ($1, $2, $3::numeric, $4::jsonb)`, [
        job.id.toLowerCase(), kind, bigText(window), JSON.stringify(detail, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
      ]);
    }
    return true;
  }

  async claimDue(holder: string, _nowMs: number, ttlMs: number, limit: number): Promise<KeeperJob[]> {
    const { rows } = await this.pool.query(
      `with c as (
         select id from dca_keeper.jobs
          where active and next_check_at <= now() and (lease_until is null or lease_until <= now() or lease_holder = $1)
          order by next_check_at
          for update skip locked
          limit $3
       )
       update dca_keeper.jobs j set lease_holder = $1, lease_until = now() + ($2::bigint * interval '1 millisecond')
         from c where j.id = c.id
       returning j.doc, j.lease_holder, (extract(epoch from j.lease_until) * 1000)::bigint::text as lease_ms`,
      [holder, ttlMs, limit],
    );
    return rows.map(PostgresKeeperStore.fromRow);
  }

  async release(id: string, holder: string): Promise<void> {
    await this.pool.query(`update dca_keeper.jobs set lease_holder = null, lease_until = null where id = $1 and lease_holder = $2`, [id.toLowerCase(), holder]);
  }

  async setNextCheck(id: string, nextCheckMs: number): Promise<void> {
    await this.pool.query(`update dca_keeper.jobs set next_check_at = to_timestamp($2::double precision / 1000) where id = $1`, [id.toLowerCase(), nextCheckMs]);
  }

  async writeAhead(job: KeeperJob, holder: string, _nowMs: number, chainPending: number): Promise<number | null> {
    if (!job.pending) throw new Error('writeAhead: job.pending is required');
    const from = job.pending.from.toLowerCase() as Hex;
    return this.tx(async (c) => {
      await c.query(`insert into dca_keeper.accounts (address) values ($1) on conflict do nothing`, [from]);
      await c.query(`select 1 from dca_keeper.accounts where address = $1 for update`, [from]);
      const { rows } = await c.query(
        `select coalesce(max(pending_nonce) + 1, 0)::text as next from dca_keeper.jobs where pending_from = $1 and id <> $2`,
        [from, job.id.toLowerCase()],
      );
      const n = Math.max(chainPending, Number(rows[0].next));
      const ok = await this.saveIn(c, { ...job, pending: { ...job.pending!, nonce: n } }, holder);
      return ok ? n : null;
    });
  }

  async list(): Promise<KeeperJob[]> {
    const { rows } = await this.pool.query(`select doc, lease_holder, (extract(epoch from lease_until) * 1000)::bigint::text as lease_ms from dca_keeper.jobs order by created_at`);
    return rows.map(PostgresKeeperStore.fromRow);
  }

  /** The append-only log of one job (runs, attempts, missed windows), oldest first. */
  async events(id: string): Promise<{ kind: string; window: string | null; detail: any }[]> {
    const { rows } = await this.pool.query(`select kind, window_index::text as window, detail from dca_keeper.events where job_id = $1 order by id`, [id.toLowerCase()]);
    return rows;
  }
}
