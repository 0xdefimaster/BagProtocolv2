import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBag, createForkBag, isBagNameAvailable } from '@/lib/server/bag-repo';
import { TestDatabase, createTestDatabase, insertUser, validRecipeInput } from './pg-harness';

// Bag names are unique across the project (migration 0058): same name ignoring case and spacing, among Bags that
// are not ARCHIVED, drafts included. Checked on a fresh install and on the upgrade path.

const dbs: Record<'fresh' | 'upgrade', TestDatabase | undefined> = { fresh: undefined, upgrade: undefined };
beforeAll(async () => {
  [dbs.fresh, dbs.upgrade] = await Promise.all([createTestDatabase({ mode: 'fresh' }), createTestDatabase({ mode: 'upgrade' })]);
});
afterAll(async () => {
  await Promise.all([dbs.fresh?.drop(), dbs.upgrade?.drop()]);
});

let n = 0;
const wallet = () => `0x${(++n).toString(16).padStart(40, 'd')}`;
const create = (db: TestDatabase, creatorId: string, name: string) =>
  createBag(db.client, { slug: `un-${Date.now()}-${n++}`, creatorId, mutability: 'MUTABLE', recipe: validRecipeInput({ name }), reason: 't' });

describe.each(['fresh', 'upgrade'] as const)('unique Bag names (%s)', (mode) => {
  it('a second Bag with the same name is refused, whoever creates it, ignoring case and spacing', async () => {
    const db = dbs[mode]!;
    const alice = await insertUser(db, wallet());
    const bob = await insertUser(db, wallet());
    const name = `Blue Chips ${mode} ${n}`;
    const first = await create(db, alice, name);
    expect(first.ok).toBe(true);

    for (const [who, variant] of [
      [alice, name],
      [bob, name],
      [bob, `  ${name.toUpperCase()}  `],
      [bob, name.replace(/ /g, '   ')],
    ] as const) {
      const again = await create(db, who, variant);
      expect(again).toMatchObject({ ok: false, error: 'DUPLICATE_NAME' });
    }
    expect(await isBagNameAvailable(db.client, name.toLowerCase())).toBe(false);
    expect(await isBagNameAvailable(db.client, `${name} 2`)).toBe(true);
    expect((await db.admin.query('select count(*)::int as c from bags where lower(name) = lower($1)', [name])).rows[0].c).toBe(1);
  });

  it('a fork needs its own name too; an archived Bag frees its name', async () => {
    const db = dbs[mode]!;
    const u = await insertUser(db, wallet());
    const name = `Forkable ${mode} ${n}`;
    const src = await create(db, u, name);
    if (!src.ok) throw new Error(JSON.stringify(src));
    const fork = await createForkBag(db.client, { slug: `unf-${n++}`, creatorId: u, mutability: 'MUTABLE', recipe: validRecipeInput({ name }), reason: 'fork' }, src.bag, 1);
    expect(fork).toMatchObject({ ok: false, error: 'DUPLICATE_NAME' });

    await db.admin.query(`update bags set status = 'ARCHIVED' where id = $1`, [src.bag.id]);
    expect(await isBagNameAvailable(db.client, name)).toBe(true);
    const reuse = await create(db, u, name);
    expect(reuse.ok).toBe(true);
    // Un-archiving the old one would make two live Bags share the name: refused.
    await expect(db.admin.query(`update bags set status = 'ACTIVE' where id = $1`, [src.bag.id])).rejects.toThrow(/BAG_NAME_TAKEN/);
    // Renaming onto a taken name is refused; renaming to a free one works.
    if (!reuse.ok) throw new Error('unreachable');
    const other = await create(db, u, `Other ${mode} ${n}`);
    if (!other.ok) throw new Error(JSON.stringify(other));
    await expect(db.admin.query('update bags set name = $1 where id = $2', [name, other.bag.id])).rejects.toThrow(/BAG_NAME_TAKEN/);
    await db.admin.query('update bags set name = $1 where id = $2', [`Renamed ${mode} ${n}`, other.bag.id]);
  });

  it('concurrent creations of one name: exactly one succeeds', async () => {
    const db = dbs[mode]!;
    const users = await Promise.all(Array.from({ length: 6 }, () => insertUser(db, wallet())));
    const name = `Race ${mode} ${n}`;
    const results = await Promise.all(users.map((u) => create(db, u, name)));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.error === 'DUPLICATE_NAME')).toBe(true);
  });

  it('a slug clash is still reported as DUPLICATE_SLUG, not as a name clash', async () => {
    const db = dbs[mode]!;
    const u = await insertUser(db, wallet());
    const slug = `same-slug-${mode}-${n++}`;
    const a = await createBag(db.client, { slug, creatorId: u, mutability: 'MUTABLE', recipe: validRecipeInput(), reason: 't' });
    expect(a.ok).toBe(true);
    const b = await createBag(db.client, { slug, creatorId: u, mutability: 'MUTABLE', recipe: validRecipeInput(), reason: 't' });
    expect(b).toMatchObject({ ok: false, error: 'DUPLICATE_SLUG' });
  });
});

describe('names duplicated before 0058', () => {
  it('stay as they are; only new names are checked', async () => {
    const db = dbs.fresh!;
    const u = await insertUser(db, wallet());
    const name = `Legacy dup ${n}`;
    await db.admin.query('alter table bags disable trigger bags_unique_name');
    for (let i = 0; i < 2; i++) {
      await db.admin.query(`insert into bags (id, slug, name, symbol, creator_id, chain, mutability) values (gen_random_uuid(), $1, $2, 'S', $3, 'robinhood', 'MUTABLE')`, [`legacy-${n}-${i}`, name, u]);
    }
    await db.admin.query('alter table bags enable trigger bags_unique_name');
    // Unrelated updates to those rows still work (the trigger only fires on name/status changes, and an unchanged name passes).
    await db.admin.query(`update bags set description = 'x' where name = $1`, [name]);
    await db.admin.query(`update bags set name = name where name = $1`, [name]);
    // Deploying one of them (DRAFT -> ACTIVE) is not blocked by the other.
    await db.admin.query(`update bags set status = 'ACTIVE' where slug = $1`, [`legacy-${n}-0`]);
    expect(await create(db, u, name)).toMatchObject({ ok: false, error: 'DUPLICATE_NAME' });
  });
});
