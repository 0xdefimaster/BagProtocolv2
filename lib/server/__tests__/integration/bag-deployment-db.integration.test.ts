import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  TestDatabase,
  WALLET_A,
  WALLET_B,
  bagRow,
  createDraftBag,
  createTestDatabase,
  deploymentRows,
  hex,
  insertUser,
} from './pg-harness';

// -----------------------------------------------------------------------------
// INTEGRATION (real PostgreSQL) — the database half of user-signed Bag
// deployment: migrations 0024-0026, `confirm_bag_deployment`, constraints,
// triggers, RLS and EXECUTE privileges. No blockchain is involved here; the
// RPC is exercised directly with already-"verified" values, because the point is
// what the DATABASE guarantees regardless of who calls it.
// -----------------------------------------------------------------------------

const FACTORY = '0xfac70fac70fac70fac70fac70fac70fac70fac70';
const CHAIN = 'robinhood';
/** Fresh random lower-case hex — every tx hash / on-chain id / address in a test is unique, so tests can share one database. */
const rnd = (bytes: number) => `0x${crypto.randomBytes(bytes).toString('hex')}`;
const upperHex = (h: string) => `0x${h.slice(2).toUpperCase()}`;

let fresh: TestDatabase;
let upgraded: TestDatabase;

/** Legacy data as the OLD flow could leave it — exercised by the upgrade-path migration test. */
async function seedLegacy(admin: import('pg').Pool) {
  await admin.query(`insert into users (id, wallet_address) values ('00000000-0000-0000-0000-0000000000a1', '${WALLET_A}')`);
  await admin.query(`
    insert into bags (id, slug, name, symbol, creator_id, chain, mutability, status) values
     ('11111111-1111-1111-1111-111111111111','l1','L1','L1','00000000-0000-0000-0000-0000000000a1','robinhood','IMMUTABLE','DRAFT'),
     ('22222222-2222-2222-2222-222222222222','l2','L2','L2','00000000-0000-0000-0000-0000000000a1','robinhood','IMMUTABLE','ACTIVE'),
     ('33333333-3333-3333-3333-333333333333','l3','L3','L3','00000000-0000-0000-0000-0000000000a1','robinhood','IMMUTABLE','DRAFT')`);
  await admin.query(`
    insert into bag_deployments (bag_id, chain, status, factory_address, contract_address, tx_hash, block_number) values
     ('11111111-1111-1111-1111-111111111111','robinhood','DEPLOYED','0xFAc70fAc70fAc70fAc70fAc70fAc70fAc70fAc70','0x000000000000000000000000000000000000BA90','0x${'AB'.repeat(32)}',100),
     ('22222222-2222-2222-2222-222222222222','robinhood','DEPLOYING','0xfac70fac70fac70fac70fac70fac70fac70fac70',null,null,null),
     ('33333333-3333-3333-3333-333333333333','robinhood','FAILED','0xfac70fac70fac70fac70fac70fac70fac70fac70',null,null,null)`);
}

beforeAll(async () => {
  fresh = await createTestDatabase({ mode: 'fresh' });
  upgraded = await createTestDatabase({ mode: 'upgrade', seedLegacy });
});
afterAll(async () => {
  await fresh?.drop();
  await upgraded?.drop();
});

// One deployable Bag per call, plus the RPC argument builder for it.
let counter = 0;
async function newBag(db: TestDatabase, wallet = `0x${(++counter).toString(16).padStart(40, '0')}`) {
  const userId = await insertUser(db, wallet);
  const { bag, version } = await createDraftBag(db, userId);
  const defaults = { txHash: rnd(32), contract: rnd(20), onChainId: rnd(32), block: 1000 + ++counter };
  const args = (over: Record<string, unknown> = {}) => ({
    p_bag_id: bag.id,
    p_creator_id: userId,
    p_bag_version_id: version.id,
    p_chain: CHAIN,
    p_factory_address: FACTORY,
    p_contract_address: defaults.contract,
    p_tx_hash: defaults.txHash,
    p_block_number: defaults.block,
    p_on_chain_bag_id: defaults.onChainId,
    p_on_chain_creator: wallet,
    ...over,
  });
  const confirm = async (over: Record<string, unknown> = {}) => {
    const { data, error } = await db.client.rpc('confirm_bag_deployment', args(over));
    if (error) throw new Error(error.message);
    return data as { outcome: string; deployment?: Record<string, any>; bag?: Record<string, any> };
  };
  return { bag, version, userId, wallet, args, confirm, defaults };
}

// ------------------------------------------------------------------ upgrade path
describe('migrations 0024-0026 — upgrade of an existing database', () => {
  it('lower-cases legacy hex, backfills the legacy on-chain id, repairs DEPLOYED+DRAFT, leaves other states alone', async () => {
    const rows = (
      await upgraded.admin.query(`select d.status, d.tx_hash, d.contract_address, d.on_chain_bag_id, d.on_chain_creator, b.status as bag_status
                                    from bag_deployments d join bags b on b.id = d.bag_id order by b.slug`)
    ).rows;
    expect(rows[0]).toMatchObject({
      status: 'DEPLOYED',
      tx_hash: `0x${'ab'.repeat(32)}`,
      contract_address: '0x000000000000000000000000000000000000ba90',
      // legacy id = the bag UUID as bytes32 (what the old backend-signed flow registered on-chain)
      on_chain_bag_id: '0x0000000000000000000000000000000011111111111111111111111111111111',
      on_chain_creator: null,
      bag_status: 'ACTIVE', // was DRAFT: the old two-step finalization's failure window, repaired
    });
    expect(rows[1]).toMatchObject({ status: 'DEPLOYING', bag_status: 'ACTIVE' });
    expect(rows[2]).toMatchObject({ status: 'FAILED', bag_status: 'DRAFT' });
  });

  it('a fresh install and an upgraded install expose the SAME constraints, indexes, triggers and function privileges', async () => {
    const snapshot = async (db: TestDatabase) => {
      const q = async (sql: string) => (await db.admin.query(sql)).rows.map((r) => JSON.stringify(r));
      return {
        constraints: await q(`select conname, pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'bag_deployments'::regclass order by 1`),
        indexes: await q(`select indexname, indexdef from pg_indexes where schemaname = 'public' and tablename = 'bag_deployments' order by 1`),
        triggers: await q(`select tgrelid::regclass::text as rel, tgname, tgdeferrable, tginitdeferred from pg_trigger where not tgisinternal and tgrelid in ('bags'::regclass, 'bag_deployments'::regclass) order by 1, 2`),
        functions: await q(`select p.oid::regprocedure::text as sig,
                                   has_function_privilege('anon', p.oid, 'execute') as anon,
                                   has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
                                   has_function_privilege('service_role', p.oid, 'execute') as service_role
                              from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                             where n.nspname = 'public' and p.prokind in ('f','p') order by 1`),
      };
    };
    expect(await snapshot(upgraded)).toEqual(await snapshot(fresh));
  });

  it('the legacy start_bag_deployment() RPC no longer exists', async () => {
    for (const db of [fresh, upgraded]) {
      const r = await db.admin.query(`select count(*)::int as n from pg_proc where proname = 'start_bag_deployment'`);
      expect(r.rows[0].n).toBe(0);
    }
  });
});

// ------------------------------------------------------------------ privileges & RLS
describe('RPC privileges and RLS — a browser (anon / authenticated) can never manufacture a deployment', () => {
  it.each(['fresh', 'upgraded'] as const)('%s: EVERY public function is executable by service_role only', async (which) => {
    const db = which === 'fresh' ? fresh : upgraded;
    const { rows } = await db.admin.query(`
      select p.oid::regprocedure::text as sig,
             has_function_privilege('anon', p.oid, 'execute') as anon,
             has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
             has_function_privilege('service_role', p.oid, 'execute') as service_role
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.prokind in ('f','p')`);
    expect(rows.length).toBeGreaterThan(10);
    expect(rows.filter((r) => r.anon || r.authenticated).map((r) => r.sig)).toEqual([]);
    expect(rows.filter((r) => !r.service_role).map((r) => r.sig)).toEqual([]);
  });

  it.each(['anon', 'authenticated'] as const)('%s calling confirm_bag_deployment directly is denied and writes nothing', async (role) => {
    const t = await newBag(fresh);
    await expect(
      fresh.asRole(role, (c) =>
        c.query(
          `select confirm_bag_deployment(p_bag_id => $1, p_creator_id => $2, p_bag_version_id => $3, p_chain => $4, p_factory_address => $5,
                  p_contract_address => $6, p_tx_hash => $7, p_block_number => $8, p_on_chain_bag_id => $9, p_on_chain_creator => $10)`,
          Object.values(t.args())
        )
      )
    ).rejects.toThrow(/permission denied for function confirm_bag_deployment/);
    expect(await deploymentRows(fresh, t.bag.id)).toEqual([]);
    expect((await bagRow(fresh, t.bag.id)).status).toBe('DRAFT');
  });

  it.each(['anon', 'authenticated'] as const)('%s cannot insert a DEPLOYED row directly (RLS) nor activate a Bag', async (role) => {
    const t = await newBag(fresh);
    await expect(
      fresh.asRole(role, (c) =>
        c.query(
          `insert into bag_deployments (bag_id, chain, status, on_chain_bag_id) values ($1, 'robinhood', 'DEPLOYED', $2)`,
          [t.bag.id, hex('ee', 32)]
        )
      )
    ).rejects.toThrow(/row-level security/);
    const upd = await fresh.asRole(role, (c) => c.query(`update bags set status = 'ACTIVE' where id = $1`, [t.bag.id]));
    expect(upd.rowCount).toBe(0); // RLS hides the row from UPDATE entirely
    expect((await bagRow(fresh, t.bag.id)).status).toBe('DRAFT');
    expect(await deploymentRows(fresh, t.bag.id)).toEqual([]);
  });

  it('anon cannot even read deployment bookkeeping', async () => {
    const t = await newBag(fresh);
    await t.confirm();
    const rows = await fresh.asRole('anon', (c) => c.query('select * from bag_deployments'));
    expect(rows.rows).toEqual([]);
  });

  it('service_role (the application) can execute the RPC', async () => {
    const t = await newBag(fresh);
    expect((await t.confirm()).outcome).toBe('CONFIRMED');
  });
});

// ------------------------------------------------------------------ constraints & triggers
describe('table constraints and cross-table invariants (hold for ANY writer, not just the RPC)', () => {
  it('one Bag + one chain = one deployment row: a duplicate insert is rejected by a UNIQUE constraint', async () => {
    const t = await newBag(fresh);
    await fresh.admin.query(`insert into bag_deployments (bag_id, chain, status) values ($1, 'robinhood', 'NOT_DEPLOYED')`, [t.bag.id]);
    await expect(
      fresh.admin.query(`insert into bag_deployments (bag_id, chain, status) values ($1, 'robinhood', 'NOT_DEPLOYED')`, [t.bag.id])
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('two concurrent DIRECT inserts (bypassing the RPC entirely) still produce exactly one row', async () => {
    const t = await newBag(fresh);
    const attempt = () => fresh.admin.query(`insert into bag_deployments (bag_id, chain, status) values ($1, 'robinhood', 'NOT_DEPLOYED')`, [t.bag.id]).then(() => 'ok', (e) => e.code);
    const results = await Promise.all([attempt(), attempt(), attempt(), attempt()]);
    expect(results.filter((r) => r === 'ok')).toHaveLength(1);
    expect(results.filter((r) => r === '23505')).toHaveLength(3);
    expect(await deploymentRows(fresh, t.bag.id)).toHaveLength(1);
  });

  it('a DEPLOYED row must carry an on-chain id', async () => {
    const t = await newBag(fresh);
    await expect(
      fresh.admin.query(`insert into bag_deployments (bag_id, chain, status) values ($1, 'robinhood', 'DEPLOYED')`, [t.bag.id])
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('a non-canonical (upper-case / malformed) tx_hash is rejected at the table', async () => {
    const t = await newBag(fresh);
    for (const bad of [`0x${'AB'.repeat(32)}`, '0x1234', 'not-a-hash']) {
      await expect(
        fresh.admin.query(`insert into bag_deployments (bag_id, chain, status, tx_hash) values ($1, 'robinhood', 'FAILED', $2)`, [t.bag.id, bad])
      ).rejects.toMatchObject({ code: '23514' });
    }
  });

  it('the same tx hash cannot be recorded for two different Bags on a chain', async () => {
    const a = await newBag(fresh);
    const b = await newBag(fresh);
    const shared = rnd(32);
    await a.confirm({ p_tx_hash: shared });
    expect((await b.confirm({ p_tx_hash: shared })).outcome).toBe('IDENTITY_TAKEN');
    expect(await deploymentRows(fresh, b.bag.id)).toEqual([]);
    expect((await bagRow(fresh, b.bag.id)).status).toBe('DRAFT');
  });

  it('INVARIANT: a DEPLOYED deployment on a DRAFT Bag cannot be committed by any writer', async () => {
    const t = await newBag(fresh);
    const c = await fresh.admin.connect();
    try {
      await c.query('begin');
      await c.query(
        `insert into bag_deployments (bag_id, chain, status, on_chain_bag_id) values ($1, 'robinhood', 'DEPLOYED', $2)`,
        [t.bag.id, hex('dd', 32)]
      );
      await expect(c.query('commit')).rejects.toThrow(/DEPLOYED deployment but is still DRAFT/);
    } finally {
      await c.query('rollback').catch(() => undefined);
      c.release();
    }
    expect(await deploymentRows(fresh, t.bag.id)).toEqual([]);
  });

  it('INVARIANT: an already-deployed Bag cannot be moved back to DRAFT', async () => {
    const t = await newBag(fresh);
    await t.confirm();
    await expect(fresh.admin.query(`update bags set status = 'DRAFT' where id = $1`, [t.bag.id])).rejects.toThrow(/still DRAFT/);
    expect((await bagRow(fresh, t.bag.id)).status).toBe('ACTIVE');
  });
});

// ------------------------------------------------------------------ RPC semantics
describe('confirm_bag_deployment — outcomes', () => {
  it('CONFIRMED: writes a lower-cased DEPLOYED row AND finalizes the Bag (ACTIVE + registry pointer) together', async () => {
    const t = await newBag(fresh);
    const upper = {
      p_tx_hash: upperHex(t.defaults.txHash),
      p_contract_address: upperHex(t.defaults.contract),
      p_factory_address: upperHex(FACTORY),
    };
    const r = await t.confirm(upper);
    expect(r.outcome).toBe('CONFIRMED');
    expect(r.deployment).toMatchObject({
      status: 'DEPLOYED',
      tx_hash: t.defaults.txHash, // stored canonical lower-case
      contract_address: t.defaults.contract,
      factory_address: FACTORY,
      on_chain_creator: t.wallet,
    });
    expect(r.bag).toMatchObject({ status: 'ACTIVE', registry_id: CHAIN, contract_address: t.defaults.contract });
    const bag = await bagRow(fresh, t.bag.id);
    expect(bag).toMatchObject({ status: 'ACTIVE', registry_id: CHAIN });
    expect(await deploymentRows(fresh, t.bag.id)).toHaveLength(1);
  });

  it('ALREADY_CONFIRMED (idempotent): the same confirmation again — including a different hash CASING — writes nothing', async () => {
    const t = await newBag(fresh);
    const first = await t.confirm();
    const before = (await deploymentRows(fresh, t.bag.id))[0];
    const mixed = `0x${t.defaults.txHash.slice(2).replace(/[a-f]/g, (ch, i) => (i % 2 ? ch.toUpperCase() : ch))}`;
    for (const casing of [t.defaults.txHash, upperHex(t.defaults.txHash), mixed]) {
      const again = await t.confirm({ p_tx_hash: casing });
      expect(again.outcome).toBe('ALREADY_CONFIRMED');
      expect(again.deployment?.id).toBe(first.deployment?.id);
    }
    const rows = await deploymentRows(fresh, t.bag.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].updated_at).toEqual(before.updated_at); // not rewritten
  });

  it('CONFLICT: a DIFFERENT transaction for an already-deployed (bag, chain) is refused and the original is untouched', async () => {
    const t = await newBag(fresh);
    const first = await t.confirm();
    const other = await t.confirm({ p_tx_hash: rnd(32), p_on_chain_bag_id: rnd(32), p_contract_address: rnd(20) });
    expect(other.outcome).toBe('CONFLICT');
    expect(other.deployment?.tx_hash).toBe(first.deployment?.tx_hash);
    const [row] = await deploymentRows(fresh, t.bag.id);
    expect(row).toMatchObject({ tx_hash: first.deployment?.tx_hash, on_chain_bag_id: first.deployment?.on_chain_bag_id });
  });

  it('CONFLICT also when only the on-chain id differs for the same tx hash', async () => {
    const t = await newBag(fresh);
    await t.confirm();
    expect((await t.confirm({ p_on_chain_bag_id: rnd(32) })).outcome).toBe('CONFLICT');
  });

  it('STALE_VERSION: a verified composition that is no longer the Bag\'s current one writes nothing', async () => {
    const t = await newBag(fresh);
    const r = await t.confirm({ p_bag_version_id: '00000000-0000-0000-0000-00000000dead' });
    expect(r.outcome).toBe('STALE_VERSION');
    expect(await deploymentRows(fresh, t.bag.id)).toEqual([]);
    expect((await bagRow(fresh, t.bag.id)).status).toBe('DRAFT');
  });

  it('FORBIDDEN: only the Bag\'s creator can finalize (re-checked inside the transaction)', async () => {
    const t = await newBag(fresh);
    const intruder = await insertUser(fresh, rnd(20));
    expect((await t.confirm({ p_creator_id: intruder })).outcome).toBe('FORBIDDEN');
    expect(await deploymentRows(fresh, t.bag.id)).toEqual([]);
  });

  it('BAG_NOT_FOUND', async () => {
    const t = await newBag(fresh);
    expect((await t.confirm({ p_bag_id: '00000000-0000-0000-0000-00000000beef' })).outcome).toBe('BAG_NOT_FOUND');
  });

  it.each([
    ['tx hash', { p_tx_hash: '0x1234' }],
    ['on-chain bag id', { p_on_chain_bag_id: 'nope' }],
    ['creator', { p_on_chain_creator: '0x12' }],
    ['contract address', { p_contract_address: '0xabc' }],
    ['block number', { p_block_number: -1 }],
  ])('rejects a malformed %s outright', async (_label, over) => {
    const t = await newBag(fresh);
    await expect(t.confirm(over)).rejects.toThrow(/malformed|invalid/);
    expect(await deploymentRows(fresh, t.bag.id)).toEqual([]);
  });

  it.each(['NOT_DEPLOYED', 'FAILED', 'DEPLOYING'])('a legacy %s row is promoted to DEPLOYED in place (still exactly one row)', async (legacy) => {
    const t = await newBag(fresh);
    await fresh.admin.query(`insert into bag_deployments (bag_id, chain, status, error_message) values ($1, 'robinhood', $2, 'old')`, [t.bag.id, legacy]);
    const r = await t.confirm();
    expect(r.outcome).toBe('CONFIRMED');
    const rows = await deploymentRows(fresh, t.bag.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'DEPLOYED', error_message: null });
    expect((await bagRow(fresh, t.bag.id)).status).toBe('ACTIVE');
  });

  it('never demotes: an ARCHIVED Bag stays ARCHIVED when a deployment is confirmed', async () => {
    const t = await newBag(fresh);
    await fresh.admin.query(`update bags set status = 'ARCHIVED' where id = $1`, [t.bag.id]);
    expect((await t.confirm()).outcome).toBe('CONFIRMED');
    expect((await bagRow(fresh, t.bag.id)).status).toBe('ARCHIVED');
  });

  it('the Bag\'s registry pointer records only the FIRST deployment', async () => {
    const t = await newBag(fresh);
    const first = rnd(20);
    await t.confirm({ p_chain: 'base', p_contract_address: first, p_tx_hash: rnd(32), p_on_chain_bag_id: rnd(32) });
    await t.confirm({ p_chain: CHAIN, p_contract_address: rnd(20), p_tx_hash: rnd(32), p_on_chain_bag_id: rnd(32) });
    expect(await bagRow(fresh, t.bag.id)).toMatchObject({ registry_id: 'base', contract_address: first });
    expect(await deploymentRows(fresh, t.bag.id)).toHaveLength(2); // one per chain
  });
});

// ------------------------------------------------------------------ concurrency
describe('concurrent confirmations — the database, not application code, decides', () => {
  const ROUNDS = 6;
  const PARALLEL = 10; // == service pool size: every call really runs on its own connection at once

  it('N simultaneous first confirmations of the SAME transaction → exactly one CONFIRMED, the rest idempotent, ONE row', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const t = await newBag(fresh);
      const results = await Promise.all(Array.from({ length: PARALLEL }, () => t.confirm()));
      const outcomes = results.map((r) => r.outcome).sort();
      expect(outcomes.filter((o) => o === 'CONFIRMED')).toHaveLength(1);
      expect(outcomes.filter((o) => o === 'ALREADY_CONFIRMED')).toHaveLength(PARALLEL - 1);
      expect(await deploymentRows(fresh, t.bag.id)).toHaveLength(1);
      expect((await bagRow(fresh, t.bag.id)).status).toBe('ACTIVE');
    }
  });

  it('N simultaneous first confirmations of DIFFERENT transactions → exactly one wins, the rest CONFLICT, the winner is what is stored', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const t = await newBag(fresh);
      const candidates = Array.from({ length: PARALLEL }, () => ({ tx: rnd(32), id: rnd(32), contract: rnd(20) }));
      const results = await Promise.all(
        candidates.map((c) => t.confirm({ p_tx_hash: c.tx, p_on_chain_bag_id: c.id, p_contract_address: c.contract }).then((r) => ({ r, c })))
      );
      const winners = results.filter((x) => x.r.outcome === 'CONFIRMED');
      expect(winners).toHaveLength(1);
      expect(results.filter((x) => x.r.outcome === 'CONFLICT')).toHaveLength(PARALLEL - 1);
      const rows = await deploymentRows(fresh, t.bag.id);
      expect(rows).toHaveLength(1);
      // the stored deployment is exactly the winner's — no loser overwrote or blended into it
      expect(rows[0]).toMatchObject({ tx_hash: winners[0].c.tx, on_chain_bag_id: winners[0].c.id, contract_address: winners[0].c.contract });
    }
  });

  it('the SAME transaction racing for two different Bags → one CONFIRMED, one IDENTITY_TAKEN, never two records', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const a = await newBag(fresh);
      const b = await newBag(fresh);
      const shared = rnd(32);
      const [ra, rb] = await Promise.all([a.confirm({ p_tx_hash: shared }), b.confirm({ p_tx_hash: shared })]);
      expect([ra.outcome, rb.outcome].sort()).toEqual(['CONFIRMED', 'IDENTITY_TAKEN']);
      const total = (await fresh.admin.query('select count(*)::int as n from bag_deployments where tx_hash = $1', [shared])).rows[0].n;
      expect(total).toBe(1);
    }
  });
});

// ------------------------------------------------------------------ atomicity
describe('atomic finalization — deployment + Bag state commit together or not at all', () => {
  it('a failure while finalizing the Bag rolls back the deployment row too (no DEPLOYED + DRAFT window)', async () => {
    const t = await newBag(fresh);
    await fresh.admin.query(`
      create or replace function it_fail_bag_update() returns trigger language plpgsql as $$ begin raise exception 'injected failure while finalizing bag'; end $$;
      create trigger it_fail_bag_update before update on bags for each row when (old.id = '${t.bag.id}') execute function it_fail_bag_update();`);
    try {
      await expect(t.confirm()).rejects.toThrow(/injected failure while finalizing bag/);
      expect(await deploymentRows(fresh, t.bag.id)).toEqual([]); // the INSERT was rolled back with it
      expect((await bagRow(fresh, t.bag.id)).status).toBe('DRAFT');
    } finally {
      await fresh.admin.query('drop trigger if exists it_fail_bag_update on bags; drop function if exists it_fail_bag_update()');
    }
    // and once the fault is gone the very same confirmation succeeds cleanly
    expect((await t.confirm()).outcome).toBe('CONFIRMED');
    expect((await bagRow(fresh, t.bag.id)).status).toBe('ACTIVE');
  });
});
