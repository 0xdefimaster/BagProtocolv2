import { beforeEach, describe, expect, it } from 'vitest';
import { BasketRecipe, DEFAULT_REBALANCE_RULE, RecipeAsset } from '@/types/basket-protocol';
import {
  archiveBag,
  createBag,
  createBagVersion,
  getBagById,
  getBagBySlug,
  getCurrentBagVersion,
  listBags,
} from '../bag-repo';

// -----------------------------------------------------------------------------
// `lib/server/bag-repo.ts` is written against the real `SupabaseClient` type,
// but there's no live Postgres instance available to test against in this
// environment. This fake reproduces exactly the surface bag-repo.ts calls
// (`.from().select().eq().maybeSingle()/.single()`, `.update()`, `.rpc()`)
// backed by two in-memory Maps, and re-implements the two Postgres functions
// from `supabase/schema.sql` (`create_bag_with_initial_version`,
// `create_bag_version`) in JS with the SAME semantics: atomic write, unique
// slug collision surfaced as Postgres error code '23505', and — critically —
// the NEXT version number is computed inside the fake's `rpc()` handler from
// the bag's current stored state, never taken from the caller, matching the
// real function's `select ... for update` row lock. See the concurrency
// test below.
//
// What this DOES verify: repo-level logic — validation gating, atomicity of
// the create flow, status transitions, read filters. What this does NOT
// verify: real RLS enforcement (needs a live Supabase project + anon-key
// client — see the "public read active bags" policy in schema.sql, which
// has no equivalent check in this fake) or actual Postgres constraint
// behavior beyond what's reproduced here.
// -----------------------------------------------------------------------------

interface Row {
  [key: string]: unknown;
}

class FakeQueryBuilder {
  private filters: Array<(row: Row) => boolean> = [];
  private orderBy: { col: string; ascending: boolean } | null = null;
  private limitN: number | null = null;
  private patch: Row | null = null;

  constructor(private table: Map<string, Row>, private tableName: string) {}

  select() {
    return this;
  }

  eq(col: string, val: unknown) {
    this.filters.push((row) => row[col] === val);
    return this;
  }

  in(col: string, vals: unknown[]) {
    this.filters.push((row) => vals.includes(row[col]));
    return this;
  }

  order(col: string, opts: { ascending: boolean }) {
    this.orderBy = { col, ascending: opts.ascending };
    return this;
  }

  limit(n: number) {
    this.limitN = n;
    return this;
  }

  update(patch: Row) {
    this.patch = patch;
    return this;
  }

  private resolve(): Row[] {
    let rows = Array.from(this.table.values());
    for (const f of this.filters) rows = rows.filter(f);

    if (this.patch) {
      rows = rows.map((row) => {
        const updated = { ...row, ...this.patch };
        this.table.set(updated.id as string, updated);
        return updated;
      });
    }

    if (this.orderBy) {
      const { col, ascending } = this.orderBy;
      rows = [...rows].sort((a, b) => {
        const cmp = (a[col] as string) < (b[col] as string) ? -1 : 1;
        return ascending ? cmp : -cmp;
      });
    }

    if (this.limitN !== null) rows = rows.slice(0, this.limitN);
    return rows;
  }

  async maybeSingle() {
    const rows = this.resolve();
    return { data: rows[0] ?? null, error: null };
  }

  async single() {
    const rows = this.resolve();
    if (rows.length === 0) return { data: null, error: { message: `no row found in ${this.tableName}` } };
    return { data: rows[0], error: null };
  }

  // Makes an un-terminated builder (e.g. `listBags`'s bare `await query`) awaitable directly, like the real supabase-js PostgrestFilterBuilder.
  then(resolve: (v: { data: Row[]; error: null }) => void) {
    resolve({ data: this.resolve(), error: null });
  }
}

class FakeSupabase {
  bags = new Map<string, Row>();
  bagVersions = new Map<string, Row>();

  from(tableName: string) {
    const table = tableName === 'bags' ? this.bags : this.bagVersions;
    return new FakeQueryBuilder(table, tableName);
  }

  async rpc(name: string, params: Record<string, unknown>) {
    if (name === 'create_bag_with_initial_version') return this.createBagWithInitialVersion(params);
    if (name === 'create_bag_version') return this.createBagVersion(params);
    throw new Error(`unknown rpc: ${name}`);
  }

  private createBagWithInitialVersion(p: Record<string, unknown>) {
    for (const bag of this.bags.values()) {
      if (bag.slug === p.p_slug) {
        return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "bags_slug_key"' } };
      }
    }

    const now = new Date().toISOString();
    const bagRow: Row = {
      id: p.p_id,
      slug: p.p_slug,
      name: p.p_name,
      symbol: p.p_symbol,
      description: p.p_description,
      creator_id: p.p_creator_id,
      chain: p.p_chain,
      strategy_type: p.p_strategy_type ?? 'STATIC_BASKET',
      mutability: p.p_mutability,
      status: p.p_status,
      current_version: 0,
      current_version_id: null,
      registry_id: null,
      contract_address: null,
      parent_bag_id: p.p_parent_bag_id ?? null,
      root_bag_id: p.p_root_bag_id ?? null,
      created_at: now,
      updated_at: now,
    };
    this.bags.set(bagRow.id as string, bagRow);

    const versionId = crypto.randomUUID();
    const versionRow: Row = {
      id: versionId,
      bag_id: p.p_id,
      version: 1,
      composition_hash: p.p_composition_hash,
      recipe: p.p_recipe,
      created_by: p.p_creator_id,
      reason: p.p_reason,
      created_at: now,
    };
    this.bagVersions.set(versionId, versionRow);

    bagRow.current_version = 1;
    bagRow.current_version_id = versionId;
    bagRow.updated_at = now;

    return { data: { bag: bagRow, version: versionRow }, error: null };
  }

  private createBagVersion(p: Record<string, unknown>) {
    const bag = this.bags.get(p.p_bag_id as string);
    if (!bag) return { data: null, error: { message: 'bag not found' } };

    // Mirrors the real create_bag_version()'s `select ... for update`: the
    // next version number is computed HERE, from the bag's current stored
    // state, not taken from the caller. This function body runs fully
    // synchronously (no `await` before the write below), so two concurrent
    // `Promise.all`-driven calls into this fake can never interleave
    // between the read of `bag.current_version` and the write of the
    // bumped value — exactly the atomicity the real `for update` row lock
    // provides in Postgres.
    const nextVersion = (bag.current_version as number) + 1;

    const now = new Date().toISOString();
    const versionId = crypto.randomUUID();
    const recipe = { ...(p.p_recipe as Row), version: nextVersion, id: `recipe_${p.p_bag_id}_v${nextVersion}` };
    const versionRow: Row = {
      id: versionId,
      bag_id: p.p_bag_id,
      version: nextVersion,
      composition_hash: p.p_composition_hash,
      recipe,
      created_by: p.p_created_by,
      reason: p.p_reason,
      created_at: now,
    };
    this.bagVersions.set(versionId, versionRow);

    bag.current_version = nextVersion;
    bag.current_version_id = versionId;
    bag.updated_at = now;

    return { data: { bag, version: versionRow }, error: null };
  }
}

// ----------------------------- Fixtures -----------------------------------------

function asset(overrides: Partial<RecipeAsset>): RecipeAsset {
  return {
    chain: 'ethereum',
    address: '0x111111111111111111111111111111111111111a',
    symbol: 'BTC',
    decimals: 18,
    weightBps: 10000,
    ...overrides,
  };
}

function validRecipeInput(): Omit<BasketRecipe, 'id' | 'bagId' | 'version' | 'createdAt'> {
  return {
    name: 'Majors Basket',
    symbol: 'MAJORS',
    description: 'BTC + ETH',
    chain: 'ethereum',
    strategyType: 'STATIC_BASKET',
    assets: [
      asset({ symbol: 'BTC', address: '0x11111111111111111111111111111111111111aa', weightBps: 6000 }),
      asset({ symbol: 'ETH', address: '0x22222222222222222222222222222222222222bb', weightBps: 4000 }),
    ],
    rebalanceRule: DEFAULT_REBALANCE_RULE,
    minInvestment: 100,
    maxAssets: 10,
    minWeightBps: 100,
    maxWeightBps: 8000,
    mutability: 'MUTABLE',
  };
}

const CREATOR_ID = 'creator-1';

describe('bag-repo — createBag', () => {
  let db: FakeSupabase;
  beforeEach(() => {
    db = new FakeSupabase();
  });

  it('creates a bag and its initial version from a valid recipe', async () => {
    const result = await createBag(db as never, {
      slug: 'majors-basket',
      creatorId: CREATOR_ID,
      mutability: 'MUTABLE',
      recipe: validRecipeInput(),
      reason: 'Genesis',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bag.slug).toBe('majors-basket');
    expect(result.bag.status).toBe('DRAFT');
    expect(result.bag.currentVersion).toBe(1);
    expect(result.bag.currentVersionId).toBe(result.version.id);
    expect(result.version.version).toBe(1);
    expect(result.version.recipe.assets).toHaveLength(2);
    expect(db.bags.size).toBe(1);
    expect(db.bagVersions.size).toBe(1);
  });

  it('stores creatorId correctly', async () => {
    const result = await createBag(db as never, {
      slug: 'creator-check',
      creatorId: 'creator-42',
      mutability: 'MUTABLE',
      recipe: validRecipeInput(),
      reason: 'Genesis',
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.bag.creatorId).toBe('creator-42');
  });

  // Phase 11 — persistence: strategy_type round-trips onto the created
  // BagRecord (not just inside the stored recipe JSONB).
  it('persists strategyType = STATIC_BASKET on the created bag', async () => {
    const result = await createBag(db as never, {
      slug: 'strategy-type-check',
      creatorId: CREATOR_ID,
      mutability: 'MUTABLE',
      recipe: validRecipeInput(),
      reason: 'Genesis',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bag.strategyType).toBe('STATIC_BASKET');
    expect(result.version.recipe.strategyType).toBe('STATIC_BASKET');
  });

  it('rejects an invalid recipe and writes nothing', async () => {
    const invalidRecipe = {
      ...validRecipeInput(),
      assets: [asset({ symbol: 'BTC', weightBps: 5000 })], // sums to 50%, not 100%
    };

    const result = await createBag(db as never, {
      slug: 'invalid-basket',
      creatorId: CREATOR_ID,
      mutability: 'MUTABLE',
      recipe: invalidRecipe,
      reason: 'Genesis',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('VALIDATION_FAILED');
    expect(db.bags.size).toBe(0);
    expect(db.bagVersions.size).toBe(0);
  });

  it('rejects a recipe with an unknown strategy type and writes nothing', async () => {
    const invalidRecipe = {
      ...validRecipeInput(),
      strategyType: 'UNKNOWN_STRATEGY' as ReturnType<typeof validRecipeInput>['strategyType'],
    };

    const result = await createBag(db as never, {
      slug: 'unknown-strategy',
      creatorId: CREATOR_ID,
      mutability: 'MUTABLE',
      recipe: invalidRecipe,
      reason: 'Genesis',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('VALIDATION_FAILED');
    expect(db.bags.size).toBe(0);
  });

  it('rejects a duplicate slug and leaves the store unchanged', async () => {
    const first = await createBag(db as never, {
      slug: 'dup-slug',
      creatorId: CREATOR_ID,
      mutability: 'MUTABLE',
      recipe: validRecipeInput(),
      reason: 'Genesis',
    });
    expect(first.ok).toBe(true);

    const second = await createBag(db as never, {
      slug: 'dup-slug',
      creatorId: 'someone-else',
      mutability: 'MUTABLE',
      recipe: validRecipeInput(),
      reason: 'Genesis',
    });

    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toBe('DUPLICATE_SLUG');
    expect(db.bags.size).toBe(1); // no orphaned second bag
  });
});

describe('bag-repo — reads', () => {
  let db: FakeSupabase;
  beforeEach(() => {
    db = new FakeSupabase();
  });

  it('getBagById / getBagBySlug find a created bag', async () => {
    const created = await createBag(db as never, {
      slug: 'find-me',
      creatorId: CREATOR_ID,
      mutability: 'MUTABLE',
      recipe: validRecipeInput(),
      reason: 'Genesis',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const byId = await getBagById(db as never, created.bag.id);
    const bySlug = await getBagBySlug(db as never, 'find-me');
    expect(byId?.id).toBe(created.bag.id);
    expect(bySlug?.id).toBe(created.bag.id);
  });

  it('listBags defaults to ACTIVE-only for a public (no creatorId) listing', async () => {
    const draft = await createBag(db as never, {
      slug: 'draft-one',
      creatorId: CREATOR_ID,
      mutability: 'MUTABLE',
      status: 'DRAFT',
      recipe: validRecipeInput(),
      reason: 'Genesis',
    });
    const active = await createBag(db as never, {
      slug: 'active-one',
      creatorId: CREATOR_ID,
      mutability: 'MUTABLE',
      status: 'ACTIVE',
      recipe: validRecipeInput(),
      reason: 'Genesis',
    });
    expect(draft.ok && active.ok).toBe(true);

    const publicList = await listBags(db as never);
    expect(publicList.map((b) => b.slug)).toEqual(['active-one']);
  });

  it('listBags with creatorId returns every status for that creator', async () => {
    await createBag(db as never, {
      slug: 'mine-draft',
      creatorId: CREATOR_ID,
      mutability: 'MUTABLE',
      status: 'DRAFT',
      recipe: validRecipeInput(),
      reason: 'Genesis',
    });
    await createBag(db as never, {
      slug: 'mine-active',
      creatorId: CREATOR_ID,
      mutability: 'MUTABLE',
      status: 'ACTIVE',
      recipe: validRecipeInput(),
      reason: 'Genesis',
    });
    await createBag(db as never, {
      slug: 'not-mine',
      creatorId: 'someone-else',
      mutability: 'MUTABLE',
      status: 'ACTIVE',
      recipe: validRecipeInput(),
      reason: 'Genesis',
    });

    const mine = await listBags(db as never, { creatorId: CREATOR_ID });
    expect(mine.map((b) => b.slug).sort()).toEqual(['mine-active', 'mine-draft']);
  });
});

describe('bag-repo — archiveBag', () => {
  it('transitions ACTIVE -> ARCHIVED', async () => {
    const db = new FakeSupabase();
    const created = await createBag(db as never, {
      slug: 'to-archive',
      creatorId: CREATOR_ID,
      mutability: 'MUTABLE',
      status: 'ACTIVE',
      recipe: validRecipeInput(),
      reason: 'Genesis',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const archived = await archiveBag(db as never, created.bag.id);
    expect(archived.status).toBe('ARCHIVED');
  });
});

describe('bag-repo — createBagVersion', () => {
  let db: FakeSupabase;
  beforeEach(() => {
    db = new FakeSupabase();
  });

  async function createMutableBag() {
    const created = await createBag(db as never, {
      slug: 'versioned-bag',
      creatorId: CREATOR_ID,
      mutability: 'MUTABLE',
      recipe: validRecipeInput(),
      reason: 'Genesis',
    });
    if (!created.ok) throw new Error('fixture setup failed');
    return created.bag;
  }

  it('v1 is created with currentVersion = 1', async () => {
    const bag = await createMutableBag();
    expect(bag.currentVersion).toBe(1);
  });

  it('publishing a changed composition bumps currentVersion to 2', async () => {
    const bag = await createMutableBag();
    const changed = {
      ...validRecipeInput(),
      assets: [
        asset({ symbol: 'BTC', address: '0x11111111111111111111111111111111111111aa', weightBps: 5000 }),
        asset({ symbol: 'ETH', address: '0x22222222222222222222222222222222222222bb', weightBps: 5000 }),
      ],
    };

    const result = await createBagVersion(db as never, {
      bagId: bag.id,
      recipe: changed,
      createdBy: CREATOR_ID,
      reason: 'Rebalance to 50/50',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bag.currentVersion).toBe(2);
      expect(result.version.version).toBe(2);
    }

    const current = await getCurrentBagVersion(db as never, bag.id);
    expect(current?.version).toBe(2);
  });

  it('rejects a new version for an IMMUTABLE bag', async () => {
    const created = await createBag(db as never, {
      slug: 'immutable-bag',
      creatorId: CREATOR_ID,
      mutability: 'IMMUTABLE',
      recipe: validRecipeInput(),
      reason: 'Genesis',
    });
    if (!created.ok) throw new Error('fixture setup failed');

    const result = await createBagVersion(db as never, {
      bagId: created.bag.id,
      recipe: validRecipeInput(),
      createdBy: CREATOR_ID,
      reason: 'Attempted change',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('IMMUTABLE_BAG');
  });

  it('rejects a new version for an ARCHIVED bag', async () => {
    const bag = await createMutableBag();
    await archiveBag(db as never, bag.id);

    const result = await createBagVersion(db as never, {
      bagId: bag.id,
      recipe: validRecipeInput(),
      createdBy: CREATOR_ID,
      reason: 'Attempted change',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('BAG_ARCHIVED');
  });

  it('rejects a no-op composition change', async () => {
    const bag = await createMutableBag();
    const result = await createBagVersion(db as never, {
      bagId: bag.id,
      recipe: validRecipeInput(), // identical composition to v1
      createdBy: CREATOR_ID,
      reason: 'No real change',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('NO_COMPOSITION_CHANGE');
  });

  it('rejects an invalid recipe and does not bump the version', async () => {
    const bag = await createMutableBag();
    const invalid = { ...validRecipeInput(), assets: [asset({ symbol: 'BTC', weightBps: 3000 })] };

    const result = await createBagVersion(db as never, {
      bagId: bag.id,
      recipe: invalid,
      createdBy: CREATOR_ID,
      reason: 'Broken change',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('VALIDATION_FAILED');

    const stillCurrent = await getBagById(db as never, bag.id);
    expect(stillCurrent?.currentVersion).toBe(1);
  });

  it('two concurrent createBagVersion calls on the same bag never produce a duplicate version number', async () => {
    const bag = await createMutableBag();

    // Two different, each individually valid, changes to v1's BTC 60 / ETH 40 —
    // both computed from the SAME starting currentVersion (1), simulating two
    // requests racing off the same read, the exact scenario the fix targets.
    const variantA = {
      ...validRecipeInput(),
      assets: [
        asset({ symbol: 'BTC', address: '0x11111111111111111111111111111111111111aa', weightBps: 5500 }),
        asset({ symbol: 'ETH', address: '0x22222222222222222222222222222222222222bb', weightBps: 4500 }),
      ],
    };
    const variantB = {
      ...validRecipeInput(),
      assets: [
        asset({ symbol: 'BTC', address: '0x11111111111111111111111111111111111111aa', weightBps: 4500 }),
        asset({ symbol: 'ETH', address: '0x22222222222222222222222222222222222222bb', weightBps: 5500 }),
      ],
    };

    const [resultA, resultB] = await Promise.all([
      createBagVersion(db as never, { bagId: bag.id, recipe: variantA, createdBy: CREATOR_ID, reason: 'Variant A' }),
      createBagVersion(db as never, { bagId: bag.id, recipe: variantB, createdBy: CREATOR_ID, reason: 'Variant B' }),
    ]);

    expect(resultA.ok).toBe(true);
    expect(resultB.ok).toBe(true);
    if (!resultA.ok || !resultB.ok) return;

    // Never [2, 2] — the whole point of computing the version inside the
    // (fake's stand-in for the) atomic RPC rather than in application code.
    const versions = [resultA.version.version, resultB.version.version].sort((x, y) => x - y);
    expect(versions).toEqual([2, 3]);
    expect(resultA.version.version).not.toBe(resultB.version.version);

    // The persisted recipe.version always agrees with the bag_versions.version column.
    expect(resultA.version.recipe.version).toBe(resultA.version.version);
    expect(resultB.version.recipe.version).toBe(resultB.version.version);

    const final = await getBagById(db as never, bag.id);
    expect(final?.currentVersion).toBe(3);
    expect(db.bagVersions.size).toBe(3); // v1 (genesis) + the two racing versions
  });
});
