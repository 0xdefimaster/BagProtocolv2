import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBag, createForkBag } from '@/lib/server/bag-repo';
import { TestDatabase, createTestDatabase, insertUser, validRecipeInput } from './pg-harness';

// Fork lineage decides the fork-royalty recipient (root_bag_id -> root creator), so it must come only from a
// trusted fork operation and never change. Checked on a fresh install and on the upgrade path (0046).

const dbs: Record<'fresh' | 'upgrade', TestDatabase | undefined> = { fresh: undefined, upgrade: undefined };
beforeAll(async () => {
  [dbs.fresh, dbs.upgrade] = await Promise.all([createTestDatabase({ mode: 'fresh' }), createTestDatabase({ mode: 'upgrade' })]);
});
afterAll(async () => {
  await Promise.all([dbs.fresh?.drop(), dbs.upgrade?.drop()]);
});

let n = 0;
const wallet = () => `0x${(++n).toString(16).padStart(40, 'c')}`;
async function bag(db: TestDatabase, creatorId: string) {
  const r = await createBag(db.client, { slug: `lin-${Date.now()}-${n++}`, creatorId, mutability: 'MUTABLE', recipe: validRecipeInput(), reason: 't' });
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r.bag;
}
const lineage = async (db: TestDatabase, id: string) =>
  (await db.admin.query('select parent_bag_id, root_bag_id from bags where id = $1', [id])).rows[0] as { parent_bag_id: string | null; root_bag_id: string | null };
const rawInsert = (db: TestDatabase, creatorId: string, parent: string | null, root: string | null) =>
  db.admin.query(
    `insert into bags (id, slug, name, symbol, creator_id, chain, mutability, parent_bag_id, root_bag_id)
     values (gen_random_uuid(), $1, $1, 'S', $2, 'robinhood', 'MUTABLE', $3, $4)`,
    [`raw-${Date.now()}-${n++}`, creatorId, parent, root]
  );

describe.each(['fresh', 'upgrade'] as const)('fork lineage integrity (%s)', (mode) => {
  it('a normal Bag has no lineage; a fork derives it from the source; a fork of a fork keeps the original root', async () => {
    const db = dbs[mode]!;
    const alice = await insertUser(db, wallet());
    const bob = await insertUser(db, wallet());
    const original = await bag(db, alice);
    expect(await lineage(db, original.id)).toEqual({ parent_bag_id: null, root_bag_id: null });

    const fork = await createForkBag(db.client, { slug: `f-${n++}`, creatorId: bob, mutability: 'MUTABLE', recipe: validRecipeInput(), reason: 'fork' }, original, 1);
    if (!fork.ok) throw new Error(JSON.stringify(fork));
    expect(await lineage(db, fork.bag.id)).toEqual({ parent_bag_id: original.id, root_bag_id: original.id });

    const forkOfFork = await createForkBag(db.client, { slug: `ff-${n++}`, creatorId: alice, mutability: 'MUTABLE', recipe: validRecipeInput(), reason: 'fork' }, fork.bag, 1);
    if (!forkOfFork.ok) throw new Error(JSON.stringify(forkOfFork));
    expect(await lineage(db, forkOfFork.bag.id)).toEqual({ parent_bag_id: fork.bag.id, root_bag_id: original.id });
    // Fork provenance (0052): the exact parent version is recorded.
    const v = async (id: string) => (await db.admin.query('select parent_bag_version from bags where id = $1', [id])).rows[0].parent_bag_version;
    expect([await v(original.id), await v(fork.bag.id), await v(forkOfFork.bag.id)]).toEqual([null, 1, 1]);
  });

  it('fork provenance: the parent version must exist, needs a parent, and never changes', async () => {
    const db = dbs[mode]!;
    const u = await insertUser(db, wallet());
    const a = await bag(db, u);
    const bad = await createForkBag(db.client, { slug: `pv-${n++}`, creatorId: u, mutability: 'MUTABLE', recipe: validRecipeInput(), reason: 'fork' }, a, 7);
    expect(bad).toMatchObject({ ok: false, error: 'DB_ERROR' });
    expect(JSON.stringify(bad)).toMatch(/BAG_LINEAGE_INVALID/);
    await expect(
      db.admin.query(`insert into bags (id, slug, name, symbol, description, creator_id, chain, mutability, status, parent_bag_version) values (gen_random_uuid(), $1, $1, 'X', '', $2, 'robinhood', 'MUTABLE', 'DRAFT', 1)`, [`pvn-${n++}`, u])
    ).rejects.toThrow(/BAG_LINEAGE_INVALID/);
    const fork = await createForkBag(db.client, { slug: `pvi-${n++}`, creatorId: u, mutability: 'MUTABLE', recipe: validRecipeInput(), reason: 'fork' }, a, 1);
    if (!fork.ok) throw new Error('fork');
    await expect(db.admin.query('update bags set parent_bag_version = null where id = $1', [fork.bag.id])).rejects.toThrow(/BAG_LINEAGE_IMMUTABLE/);
    await expect(db.admin.query('update bags set parent_bag_version = 2 where id = $1', [fork.bag.id])).rejects.toThrow(/BAG_LINEAGE_IMMUTABLE/);
  });

  it('the database refuses forged lineage at insert', async () => {
    const db = dbs[mode]!;
    const mallory = await insertUser(db, wallet());
    const a = await bag(db, mallory);
    const z = await bag(db, mallory);
    // Root that is not the parent's root (royalty redirect).
    await expect(rawInsert(db, mallory, a.id, z.id)).rejects.toThrow(/BAG_LINEAGE_INVALID/);
    // Root without a parent.
    await expect(rawInsert(db, mallory, null, z.id)).rejects.toThrow(/BAG_LINEAGE_INVALID/);
    // A consistent lineage is accepted.
    await expect(rawInsert(db, mallory, a.id, a.id)).resolves.toBeTruthy();
  });

  it('lineage is immutable after insert', async () => {
    const db = dbs[mode]!;
    const u = await insertUser(db, wallet());
    const a = await bag(db, u);
    const b = await bag(db, u);
    const fork = await createForkBag(db.client, { slug: `im-${n++}`, creatorId: u, mutability: 'MUTABLE', recipe: validRecipeInput(), reason: 'fork' }, a, 1);
    if (!fork.ok) throw new Error('fork');
    await expect(db.admin.query('update bags set root_bag_id = $2 where id = $1', [fork.bag.id, b.id])).rejects.toThrow(/BAG_LINEAGE_IMMUTABLE/);
    await expect(db.admin.query('update bags set parent_bag_id = null, root_bag_id = null where id = $1', [fork.bag.id])).rejects.toThrow(/BAG_LINEAGE_IMMUTABLE/);
    await expect(db.admin.query('update bags set parent_bag_id = $2 where id = $1', [b.id, a.id])).rejects.toThrow(/BAG_LINEAGE_IMMUTABLE/);
    // Other columns still update normally.
    await db.admin.query(`update bags set name = 'renamed' where id = $1`, [fork.bag.id]);
    expect(await lineage(db, fork.bag.id)).toEqual({ parent_bag_id: a.id, root_bag_id: a.id });
  });

  it('deleting a parent still clears the reference (ON DELETE SET NULL)', async () => {
    const db = dbs[mode]!;
    const u = await insertUser(db, wallet());
    const a = await bag(db, u);
    const fork = await createForkBag(db.client, { slug: `del-${n++}`, creatorId: u, mutability: 'MUTABLE', recipe: validRecipeInput(), reason: 'fork' }, a, 1);
    if (!fork.ok) throw new Error('fork');
    await db.admin.query('delete from bags where id = $1', [a.id]);
    expect(await lineage(db, fork.bag.id)).toEqual({ parent_bag_id: null, root_bag_id: null });
  });
});
