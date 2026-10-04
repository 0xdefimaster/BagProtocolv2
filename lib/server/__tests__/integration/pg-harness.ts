import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Pool, PoolClient, types } from 'pg';
import type { SupabaseClient } from '@supabase/supabase-js';
import { BasketRecipe, DEFAULT_REBALANCE_RULE, RecipeAsset } from '@/types/basket-protocol';
import { createBag } from '@/lib/server/bag-repo';

// -----------------------------------------------------------------------------
// INTEGRATION-TEST HARNESS — a REAL PostgreSQL, no mocks of the database.
//
//   TEST_DATABASE_URL   superuser connection to any reachable PostgreSQL 14+
//                       (local install, `docker run postgres:16`, Supabase CLI's
//                       local db, …). Each suite creates its own scratch
//                       database on it and drops it afterwards. Never point this
//                       at a real project's database.
//
// What is real: the schema (supabase/schema.sql or the pre-0024 schema + the
// migration files), every RPC, constraint, trigger, RLS policy and privilege.
// What is emulated: the Supabase PLATFORM around Postgres — roles, `auth.uid()`
// and default function privileges (supabase/test-fixtures/supabase-emulation.sql).
// This is not a Supabase project and not any blockchain.
//
// The `service_role` pool connects as the superuser and immediately
// `SET ROLE service_role`s, so application code runs with exactly the role the
// production service-role client has (BYPASSRLS, EXECUTE only where granted).
// -----------------------------------------------------------------------------

// pg returns bigint/numeric/timestamptz as strings/Dates; PostgREST returns numbers/ISO strings. Match PostgREST.
types.setTypeParser(20, (v) => Number(v));
types.setTypeParser(1700, (v) => Number(v));
types.setTypeParser(1184, (v) => v);

const ROOT = path.resolve(__dirname, '../../../..');
const readSql = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

export function requireTestDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      'TEST_DATABASE_URL is not set. Integration tests need a real PostgreSQL superuser connection ' +
        '(see docs/USER_SIGNED_DEPLOYMENT.md, "Running the tests"). They never skip silently.'
    );
  }
  return url;
}

// Derived from the migrations directory itself, never hand-maintained: a
// hardcoded list here silently drifted before (this exact file listed only
// through 0026 while six more migrations shipped after it, so the
// "upgrade path" test below compared a fresh install against a database
// missing 0027-0032's functions/columns entirely — caught only once this
// suite ran against a REAL Postgres in CI rather than being skipped for
// lack of one). Every migration numbered 0024 or later is included,
// nothing lower (0024 is the fork point: `schema_before_0024.sql` is the
// pinned starting point for the "upgrade" path in the test below).
export const ALL_MIGRATIONS_FROM_0024: string[] = fs
  .readdirSync(path.join(ROOT, 'supabase/migrations'))
  .filter((f) => f.endsWith('.sql') && Number(f.slice(0, 4)) >= 24)
  .sort()
  .map((f) => `supabase/migrations/${f}`);

export interface TestDatabase {
  name: string;
  /** Superuser pool — for seeding, catalog inspection, `SET ROLE` privilege probes. */
  admin: Pool;
  /** Pool whose every connection runs as `service_role` — what the application's service-role client is. */
  service: Pool;
  /** A supabase-js-shaped client over `service` (rpc + select/eq/maybeSingle/single). */
  client: SupabaseClient;
  /** Runs `fn` on a dedicated connection with `SET ROLE <role>`; always resets. */
  asRole<T>(role: 'anon' | 'authenticated' | 'service_role', fn: (c: PoolClient) => Promise<T>): Promise<T>;
  drop(): Promise<void>;
}

function withDatabase(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

/**
 * Creates a scratch database, installs the Supabase emulation and either the CURRENT schema.sql (fresh install) or
 * the schema as it was before migration 0024 followed by `migrations` (the upgrade path).
 */
export async function createTestDatabase(
  opts: { mode?: 'fresh' | 'upgrade'; seedLegacy?: (admin: Pool) => Promise<void> } = {}
): Promise<TestDatabase> {
  const adminUrl = requireTestDatabaseUrl();
  const name = `bag_it_${crypto.randomBytes(5).toString('hex')}`;

  const bootstrap = new Pool({ connectionString: adminUrl, max: 1 });
  await bootstrap.query(`create database ${name}`);
  await bootstrap.end();

  const dbUrl = withDatabase(adminUrl, name);
  const admin = new Pool({ connectionString: dbUrl, max: 8 });
  await admin.query(readSql('supabase/test-fixtures/supabase-emulation.sql'));

  if ((opts.mode ?? 'fresh') === 'fresh') {
    await admin.query(readSql('supabase/schema.sql'));
  } else {
    await admin.query(readSql('supabase/test-fixtures/schema_before_0024.sql'));
    if (opts.seedLegacy) await opts.seedLegacy(admin);
    for (const migration of ALL_MIGRATIONS_FROM_0024) await admin.query(readSql(migration));
  }

  const service = new Pool({ connectionString: dbUrl, max: 10, options: '-c role=service_role' });
  const client = pgSupabaseShim(service);

  return {
    name,
    admin,
    service,
    client,
    async asRole(role, fn) {
      const c = await admin.connect();
      try {
        await c.query(`set role ${role}`);
        return await fn(c);
      } finally {
        await c.query('reset role').catch(() => undefined);
        c.release();
      }
    },
    async drop() {
      await service.end();
      await admin.end();
      const cleanup = new Pool({ connectionString: adminUrl, max: 1 });
      // Pool.end() can resolve while a client is still closing its socket. Forcing the drop then
      // terminates that client (57P01), and the dying client's 'error' event surfaces as an
      // uncaught exception. Wait (bounded) until the database has no backends left first.
      for (let i = 0; i < 50; i++) {
        const { rows } = await cleanup.query('select count(*)::int as n from pg_stat_activity where datname = $1', [name]);
        if (rows[0].n === 0) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      await cleanup.query(`drop database if exists ${name} with (force)`);
      await cleanup.end();
    },
  };
}

// ------------------------------- supabase-js shim ----------------------------

const IDENT_RE = /^[a-z_][a-z0-9_]*$/;
const assertIdent = (s: string) => {
  if (!IDENT_RE.test(s)) throw new Error(`shim: unsafe identifier "${s}"`);
  return s;
};

type Result<T> = { data: T | null; error: { message: string; code?: string } | null };
const toError = (err: unknown) => ({ message: err instanceof Error ? err.message : String(err), code: (err as { code?: string })?.code });

class ShimQuery {
  private filters: Array<[string, unknown]> = [];
  private orders: Array<[string, boolean]> = [];
  constructor(private readonly pool: Pool, private readonly table: string) {}
  select(_columns?: string) {
    return this;
  }
  eq(column: string, value: unknown) {
    this.filters.push([assertIdent(column), value]);
    return this;
  }
  order(column: string, opts: { ascending?: boolean } = {}) {
    this.orders.push([assertIdent(column), opts.ascending !== false]);
    return this;
  }
  private async run(): Promise<Record<string, unknown>[]> {
    const where = this.filters.map(([c], i) => `${c} = $${i + 1}`).join(' and ');
    const orderBy = this.orders.map(([c, asc]) => `${c} ${asc ? 'asc' : 'desc'}`).join(', ');
    const sql = `select * from ${assertIdent(this.table)}${where ? ` where ${where}` : ''}${orderBy ? ` order by ${orderBy}` : ''}`;
    return (await this.pool.query(sql, this.filters.map(([, v]) => v))).rows;
  }
  /** `await from(t).select().eq()…` resolves to every matching row, like supabase-js. */
  then<R1 = Result<Record<string, unknown>[]>, R2 = never>(
    onfulfilled?: ((value: Result<Record<string, unknown>[]>) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null
  ): Promise<R1 | R2> {
    return this.run()
      .then((rows) => ({ data: rows, error: null }), (err) => ({ data: null, error: toError(err) }))
      .then(onfulfilled, onrejected);
  }
  /** One multi-row INSERT statement (atomic), like supabase-js `insert(rows)`. */
  async insert(values: Record<string, unknown> | Record<string, unknown>[]): Promise<Result<null>> {
    const rows = Array.isArray(values) ? values : [values];
    if (rows.length === 0) return { data: null, error: null };
    const cols = Object.keys(rows[0]).map(assertIdent);
    const params: unknown[] = [];
    const tuples = rows.map((r) => `(${cols.map((c) => (params.push(r[c] !== null && typeof r[c] === 'object' ? JSON.stringify(r[c]) : r[c]), `$${params.length}`)).join(', ')})`);
    try {
      await this.pool.query(`insert into ${assertIdent(this.table)} (${cols.join(', ')}) values ${tuples.join(', ')}`, params);
      return { data: null, error: null };
    } catch (err) {
      return { data: null, error: toError(err) };
    }
  }
  async maybeSingle<T = unknown>(): Promise<Result<T>> {
    try {
      const rows = await this.run();
      if (rows.length > 1) return { data: null, error: { message: 'multiple rows returned', code: 'PGRST116' } };
      return { data: (rows[0] ?? null) as T | null, error: null };
    } catch (err) {
      return { data: null, error: toError(err) };
    }
  }
  async single<T = unknown>(): Promise<Result<T>> {
    const r = await this.maybeSingle<T>();
    if (!r.error && r.data === null) return { data: null, error: { message: 'no rows returned', code: 'PGRST116' } };
    return r;
  }
}

/** Only what the server code paths under test use: `rpc(fn, namedArgs)`, `from(t).select().eq().order()` (awaited, or `.maybeSingle()/.single()`) and `from(t).insert(rows)`. */
export function pgSupabaseShim(pool: Pool): SupabaseClient {
  const shim = {
    from: (table: string) => new ShimQuery(pool, table),
    async rpc(fn: string, args: Record<string, unknown> = {}): Promise<Result<unknown>> {
      try {
        const keys = Object.keys(args).map(assertIdent);
        const values = keys.map((k) => {
          const v = args[k];
          return v !== null && typeof v === 'object' ? JSON.stringify(v) : v;
        });
        const placeholders = keys.map((k, i) => `${k} => $${i + 1}${args[k] !== null && typeof args[k] === 'object' ? '::jsonb' : ''}`);
        const fnIdent = assertIdent(fn);

        // Mirrors real PostgREST/supabase-js: a set-returning function
        // (`RETURNS TABLE`/`SETOF`) is called as a row source
        // (`select * from fn(...)`), and `data` is the array of result
        // rows with each output column as a proper named field — the same
        // shape application code already expects (e.g.
        // `Array.isArray(data) ? data[0] : data`). A scalar/single-value
        // function is called in the SELECT list and unwrapped to that one
        // value, unchanged from before. Getting this wrong isn't
        // cosmetic: `select fn(...) as result` against a table-returning
        // function returns the whole row serialized as ONE opaque
        // composite-type string (e.g. `(n1,msg1,"2026-...")`), so every
        // field ends up `undefined` to application code expecting
        // `data.someColumn` — caught by this project's own real-Postgres
        // integration tests once they actually ran against this harness.
        const { rows: procRows } = await pool.query('select proretset from pg_proc where oid = $1::regproc', [fnIdent]);
        const isSetReturning = procRows[0]?.proretset === true;

        if (isSetReturning) {
          const res = await pool.query(`select * from ${fnIdent}(${placeholders.join(', ')})`, values);
          return { data: res.rows, error: null };
        }

        const res = await pool.query(`select ${fnIdent}(${placeholders.join(', ')}) as result`, values);
        return { data: res.rows[0].result, error: null };
      } catch (err) {
        return { data: null, error: toError(err) };
      }
    },
  };
  return shim as unknown as SupabaseClient;
}

// ------------------------------- fixtures ------------------------------------

export const WALLET_A = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
export const WALLET_B = '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc';

export async function insertUser(db: TestDatabase, wallet: string): Promise<string> {
  const res = await db.admin.query('insert into users (wallet_address) values ($1) returning id', [wallet]);
  return res.rows[0].id as string;
}

function asset(symbol: string, address: string, weightBps: number): RecipeAsset {
  return { chain: 'robinhood', address, symbol, decimals: 18, weightBps };
}

export function validRecipeInput(overrides: Partial<Omit<BasketRecipe, 'id' | 'bagId' | 'version' | 'createdAt'>> = {}) {
  return {
    name: 'Majors Basket',
    symbol: 'MAJORS',
    description: 'BTC + ETH',
    chain: 'robinhood' as const,
    strategyType: 'STATIC_BASKET' as const,
    assets: [
      asset('BTC', '0x11111111111111111111111111111111111111aa', 6000),
      asset('ETH', '0x22222222222222222222222222222222222222bb', 4000),
    ],
    rebalanceRule: DEFAULT_REBALANCE_RULE,
    minInvestment: 100,
    maxAssets: 10,
    minWeightBps: 100,
    maxWeightBps: 8000,
    mutability: 'MUTABLE' as const,
    ...overrides,
  };
}

let slugCounter = 0;
/** Creates a DRAFT Bag + v1 through the REAL `createBag` repository function and `create_bag_with_initial_version` RPC. */
export async function createDraftBag(db: TestDatabase, creatorId: string, recipe = validRecipeInput()) {
  const result = await createBag(db.client, {
    slug: `it-bag-${Date.now()}-${slugCounter++}`,
    creatorId,
    mutability: 'MUTABLE',
    recipe,
    reason: 'integration test',
  });
  if (!result.ok) throw new Error(`createDraftBag failed: ${JSON.stringify(result)}`);
  return result;
}

export async function bagRow(db: TestDatabase, bagId: string) {
  return (await db.admin.query('select id, status, registry_id, contract_address, current_version_id from bags where id = $1', [bagId])).rows[0];
}
export async function deploymentRows(db: TestDatabase, bagId: string) {
  return (await db.admin.query('select * from bag_deployments where bag_id = $1 order by created_at', [bagId])).rows;
}

export const hex = (byte: string, bytes: number) => `0x${byte.repeat(bytes)}`;
