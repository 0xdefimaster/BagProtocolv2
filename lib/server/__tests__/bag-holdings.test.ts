import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_REBALANCE_RULE, RecipeAsset } from '@/types/basket-protocol';
import { MockPriceProvider } from '@/lib/domain/basket-protocol/pricing/mock-provider';
import { createBag } from '../bag-repo';
import { registerAsset } from '../asset-repo';
import { setBagHoldings } from '../bag-holdings';
import { getBagNav } from '../bag-nav';

// -----------------------------------------------------------------------------
// `bag-holdings-repo.test.ts` covers pure repository CRUD (create, dedupe,
// update, remove, atomic replace). This file covers the layer ABOVE it —
// `lib/server/bag-holdings.ts`'s `setBagHoldings()` (ownership + verified-
// asset policy) and `lib/server/bag-nav.ts`'s `getBagNav()` (the
// repository-to-NAV-Engine bridge) — the cases spec section 14 explicitly
// calls out: ownership, verified-asset allow/reject, and NAV integration.
//
// One combined fake here (bags + bag_versions + assets + bag_holdings)
// since `setBagHoldings()` genuinely spans all four tables — same
// "reproduce exactly the surface each repo calls" approach as every other
// fake in this test suite, just merged into one class instead of three,
// since a single test in this file exercises all three repos together.
// -----------------------------------------------------------------------------

interface Row {
  [key: string]: unknown;
}

class FakeQueryBuilder {
  private filters: Array<(row: Row) => boolean> = [];
  private orFilters: Array<{ chain: string; address: string }> | null = null;
  private patch: Row | null = null;
  private insertRow: Row | null = null;
  private upsertRow: Row | null = null;
  private deleteMode = false;

  constructor(private table: Map<string, Row>, private tableName: string) {}

  select() {
    return this;
  }

  eq(col: string, val: unknown) {
    this.filters.push((row) => row[col] === val);
    return this;
  }

  or(filter: string) {
    const pairs: Array<{ chain: string; address: string }> = [];
    const re = /and\(chain\.eq\.([^,]+),address\.eq\.([^)]+)\)/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(filter))) pairs.push({ chain: match[1], address: match[2] });
    this.orFilters = pairs;
    return this;
  }

  insert(row: Row) {
    this.insertRow = row;
    return this;
  }

  upsert(row: Row, _opts: { onConflict: string }) {
    this.upsertRow = row;
    return this;
  }

  update(patch: Row) {
    this.patch = patch;
    return this;
  }

  delete() {
    this.deleteMode = true;
    return this;
  }

  private resolve(): Row[] {
    let rows = Array.from(this.table.values()).filter((row) => this.filters.every((f) => f(row)));
    if (this.orFilters) {
      const pairs = this.orFilters;
      rows = rows.filter((row) => pairs.some((p) => row.chain === p.chain && row.address === p.address));
    }
    if (this.patch) {
      rows = rows.map((row) => {
        const updated = { ...row, ...this.patch };
        this.table.set(updated.id as string, updated);
        return updated;
      });
    }
    return rows;
  }

  async maybeSingle() {
    const rows = this.resolve();
    return { data: rows[0] ?? null, error: null };
  }

  async single() {
    if (this.insertRow) {
      const id = crypto.randomUUID();
      const row: Row = { id, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...this.insertRow };
      this.table.set(id, row);
      return { data: row, error: null };
    }
    if (this.upsertRow) {
      const existing = Array.from(this.table.values()).find(
        (r) => r.bag_id === this.upsertRow!.bag_id && r.chain === this.upsertRow!.chain && r.address === this.upsertRow!.address
      );
      const now = new Date().toISOString();
      if (existing) {
        const updated = { ...existing, ...this.upsertRow, updated_at: now };
        this.table.set(existing.id as string, updated);
        return { data: updated, error: null };
      }
      const id = crypto.randomUUID();
      const row: Row = { id, created_at: now, updated_at: now, ...this.upsertRow };
      this.table.set(id, row);
      return { data: row, error: null };
    }
    const rows = this.resolve();
    if (rows.length === 0) return { data: null, error: { message: `no row found in ${this.tableName}` } };
    return { data: rows[0], error: null };
  }

  then<TResult1 = { data: Row[]; error: null }, TResult2 = never>(
    onfulfilled?: ((value: { data: Row[]; error: null }) => TResult1 | PromiseLike<TResult1>) | null
  ): Promise<TResult1 | TResult2> {
    if (this.deleteMode) {
      for (const row of this.resolve()) this.table.delete(row.id as string);
      const result = { data: [], error: null as null };
      return Promise.resolve(onfulfilled ? onfulfilled(result) : (result as unknown as TResult1));
    }
    const result = { data: this.resolve(), error: null as null };
    return Promise.resolve(onfulfilled ? onfulfilled(result) : (result as unknown as TResult1));
  }
}

class FakeSupabase {
  bags = new Map<string, Row>();
  bagVersions = new Map<string, Row>();
  assets = new Map<string, Row>();
  bagHoldings = new Map<string, Row>();

  from(tableName: string) {
    const table =
      tableName === 'bags'
        ? this.bags
        : tableName === 'bag_versions'
          ? this.bagVersions
          : tableName === 'assets'
            ? this.assets
            : tableName === 'bag_holdings'
              ? this.bagHoldings
              : (() => {
                  throw new Error(`FakeSupabase: unexpected table "${tableName}"`);
                })();
    return new FakeQueryBuilder(table, tableName);
  }

  async rpc(name: string, params: Record<string, unknown>) {
    if (name === 'create_bag_with_initial_version') return this.createBagWithInitialVersion(params);
    if (name === 'replace_bag_holdings') return this.replaceBagHoldings(params);
    throw new Error(`unknown rpc: ${name}`);
  }

  private createBagWithInitialVersion(p: Record<string, unknown>) {
    for (const bag of this.bags.values()) {
      if (bag.slug === p.p_slug) {
        return { data: null, error: { code: '23505', message: 'duplicate slug' } };
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
      current_version: 1,
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
    bagRow.current_version_id = versionId;

    return { data: { bag: bagRow, version: versionRow }, error: null };
  }

  private replaceBagHoldings(p: Record<string, unknown>) {
    const bagId = p.p_bag_id as string;
    const holdings = p.p_holdings as Row[];
    for (const [id, row] of this.bagHoldings) {
      if (row.bag_id === bagId) this.bagHoldings.delete(id);
    }
    const now = new Date().toISOString();
    const inserted: Row[] = holdings.map((h) => {
      const row: Row = { id: crypto.randomUUID(), bag_id: bagId, created_at: now, updated_at: now, ...h };
      this.bagHoldings.set(row.id as string, row);
      return row;
    });
    return { data: inserted, error: null };
  }
}

// ----------------------------- Fixtures -----------------------------------------

function asset(overrides: Partial<RecipeAsset>): RecipeAsset {
  return {
    chain: 'ethereum',
    address: '0x1111111111111111111111111111111111111111',
    symbol: 'BTC',
    decimals: 18,
    weightBps: 10000,
    ...overrides,
  };
}

const CREATOR_ID = 'user_creator_1';
const OTHER_USER_ID = 'user_other_1';
const BTC = { chain: 'ethereum' as const, address: '0x1111111111111111111111111111111111111111' };
const ETH = { chain: 'ethereum' as const, address: '0x2222222222222222222222222222222222222222' };

let db: FakeSupabase;

beforeEach(() => {
  db = new FakeSupabase();
});

async function createTestBag(status: 'DRAFT' | 'ACTIVE' = 'DRAFT') {
  const result = await createBag(db as never, {
    slug: `bag-${crypto.randomUUID()}`,
    creatorId: CREATOR_ID,
    mutability: 'MUTABLE',
    status,
    recipe: {
      name: 'Test Bag',
      symbol: 'TEST',
      description: 'Fixture',
      chain: 'ethereum',
      strategyType: 'STATIC_BASKET',
      assets: [asset({})],
      rebalanceRule: DEFAULT_REBALANCE_RULE,
      minInvestment: 100,
      maxAssets: 10,
      minWeightBps: 0,
      maxWeightBps: 10000,
      mutability: 'MUTABLE',
    },
    reason: 'Initial creation',
  });
  if (!result.ok) throw new Error('fixture setup failed: ' + JSON.stringify(result));
  return result.bag;
}

describe('setBagHoldings — ownership', () => {
  it('rejects a caller who is not the bag creator', async () => {
    const bag = await createTestBag();
    const result = await setBagHoldings(db as never, OTHER_USER_ID, bag.id, [
      { asset: BTC, quantityRaw: '1', decimals: 0 },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('FORBIDDEN');
    expect(db.bagHoldings.size).toBe(0); // nothing written
  });

  it('rejects a bag that does not exist', async () => {
    const result = await setBagHoldings(db as never, CREATOR_ID, 'nonexistent', [
      { asset: BTC, quantityRaw: '1', decimals: 0 },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('BAG_NOT_FOUND');
  });

  it('allows the actual creator to set holdings', async () => {
    const bag = await createTestBag();
    const result = await setBagHoldings(db as never, CREATOR_ID, bag.id, [
      { asset: BTC, quantityRaw: '1', decimals: 0 },
    ]);
    expect(result.ok).toBe(true);
  });
});

describe('setBagHoldings — verified asset policy', () => {
  it('a verified asset is always allowed, regardless of bag status', async () => {
    await registerAsset(db as never, { ...BTC, symbol: 'BTC', decimals: 18, name: 'Bitcoin', assetType: 'crypto' });
    const activeBag = await createTestBag('ACTIVE');

    const result = await setBagHoldings(db as never, CREATOR_ID, activeBag.id, [
      { asset: BTC, quantityRaw: '1', decimals: 18 },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.unverifiedWarnings).toEqual([]);
  });

  it('an unverified asset is allowed on a DRAFT bag, reported as a warning', async () => {
    const draftBag = await createTestBag('DRAFT');

    const result = await setBagHoldings(db as never, CREATOR_ID, draftBag.id, [
      { asset: ETH, quantityRaw: '1', decimals: 18 }, // never registered
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.unverifiedWarnings).toHaveLength(1);
      expect(result.holdings).toHaveLength(1); // write still happened
    }
  });

  it('an unverified asset is REJECTED outright on an ACTIVE bag — nothing is written', async () => {
    const activeBag = await createTestBag('ACTIVE');

    const result = await setBagHoldings(db as never, CREATOR_ID, activeBag.id, [
      { asset: ETH, quantityRaw: '1', decimals: 18 }, // never registered
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error === 'UNVERIFIED_ASSETS') {
      expect(result.unverified).toHaveLength(1);
    }
    expect(db.bagHoldings.size).toBe(0);
  });
});

describe('getBagNav — repository-to-NAV-Engine integration', () => {
  it('Bag -> repository holdings -> AssetHolding[] -> PriceProvider -> calculateNav() produces a real value', async () => {
    const bag = await createTestBag('ACTIVE');
    await registerAsset(db as never, { ...BTC, symbol: 'BTC', decimals: 0, name: 'Bitcoin', assetType: 'crypto' });
    await registerAsset(db as never, { ...ETH, symbol: 'ETH', decimals: 0, name: 'Ether', assetType: 'crypto' });

    const setResult = await setBagHoldings(db as never, CREATOR_ID, bag.id, [
      { asset: BTC, quantityRaw: '2', decimals: 0 },
      { asset: ETH, quantityRaw: '3', decimals: 0 },
    ]);
    expect(setResult.ok).toBe(true);

    const provider = new MockPriceProvider();
    provider.setPrice(BTC, '100');
    provider.setPrice(ETH, '50');

    const nav = await getBagNav(db as never, bag.id, provider);
    expect(nav.grossNav).toBe('350.000000000000000000');
    expect(nav.components).toHaveLength(2);
  });

  it('a bag with no holdings yet produces a zero NAV, not an error', async () => {
    const bag = await createTestBag('DRAFT');
    const provider = new MockPriceProvider();

    const nav = await getBagNav(db as never, bag.id, provider);
    expect(nav.grossNav).toBe('0.000000000000000000');
    expect(nav.components).toEqual([]);
  });
});
