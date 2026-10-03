import { beforeEach, describe, expect, it } from 'vitest';
import { getBagHoldings, removeBagHolding, replaceBagHoldings, upsertBagHolding } from '../bag-holdings-repo';

// -----------------------------------------------------------------------------
// Fake reproduces exactly the bag_holdings surface bag-holdings-repo.ts
// calls: `.select().eq()`, `.upsert(...).select().single()`,
// `.delete().eq().eq().eq()`, and the `replace_bag_holdings` RPC with the
// SAME atomic "delete all, insert new set" semantics as the real Postgres
// function in supabase/schema.sql.
// -----------------------------------------------------------------------------

interface Row {
  [key: string]: unknown;
}

class FakeQueryBuilder {
  private filters: Array<(row: Row) => boolean> = [];
  private upsertRow: Row | null = null;
  private deleteMode = false;

  constructor(private table: Map<string, Row>) {}

  select() {
    return this;
  }

  eq(col: string, val: unknown) {
    this.filters.push((row) => row[col] === val);
    return this;
  }

  upsert(row: Row, _opts: { onConflict: string }) {
    this.upsertRow = row;
    return this;
  }

  delete() {
    this.deleteMode = true;
    return this;
  }

  private resolve(): Row[] {
    return Array.from(this.table.values()).filter((row) => this.filters.every((f) => f(row)));
  }

  async single() {
    if (this.upsertRow) {
      const existing = Array.from(this.table.values()).find(
        (r) =>
          r.bag_id === this.upsertRow!.bag_id &&
          r.chain === this.upsertRow!.chain &&
          r.address === this.upsertRow!.address
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
    if (rows.length === 0) return { data: null, error: { message: 'no row found' } };
    return { data: rows[0], error: null };
  }

  // Plain `await query` — used by getBagHoldings() (a list, no `.single()`)
  // and by `.delete().eq()...` (the delete actually happens here).
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
  bagHoldings = new Map<string, Row>();

  from(tableName: string) {
    if (tableName !== 'bag_holdings') throw new Error(`FakeSupabase: unexpected table "${tableName}"`);
    return new FakeQueryBuilder(this.bagHoldings);
  }

  async rpc(name: string, params: Record<string, unknown>) {
    if (name !== 'replace_bag_holdings') throw new Error(`unknown rpc: ${name}`);
    const bagId = params.p_bag_id as string;
    const holdings = params.p_holdings as Row[];

    // Same "delete all, insert new set" atomicity the real Postgres
    // function provides — this fake body runs fully synchronously (no
    // `await` between the delete and the inserts), so a concurrent call
    // could never observe a half-replaced state either.
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

let db: FakeSupabase;

beforeEach(() => {
  db = new FakeSupabase();
});

const BAG_ID = 'bag_1';
const BTC = { chain: 'ethereum' as const, address: '0x11111111111111111111111111111111111111' };
const ETH = { chain: 'ethereum' as const, address: '0x22222222222222222222222222222222222222' };

describe('create', () => {
  it('creates a new holding for a bag', async () => {
    const holding = await upsertBagHolding(db as never, { bagId: BAG_ID, asset: BTC, quantityRaw: '5', decimals: 0 });
    expect(holding.bagId).toBe(BAG_ID);
    expect(holding.quantityRaw).toBe('5');

    const all = await getBagHoldings(db as never, BAG_ID);
    expect(all).toHaveLength(1);
  });
});

describe('duplicate protection — same bag + same asset never produces a second row', () => {
  it('upserting the same (bagId, asset) twice updates in place, no duplicate', async () => {
    await upsertBagHolding(db as never, { bagId: BAG_ID, asset: BTC, quantityRaw: '5', decimals: 0 });
    await upsertBagHolding(db as never, { bagId: BAG_ID, asset: BTC, quantityRaw: '5', decimals: 0 });

    const all = await getBagHoldings(db as never, BAG_ID);
    expect(all).toHaveLength(1);
  });

  it('is address-case-insensitive for EVM chains (0xAbC... and 0xabc... collide)', async () => {
    await upsertBagHolding(db as never, {
      bagId: BAG_ID,
      asset: { chain: 'ethereum', address: '0xAbCdEf000000000000000000000000000000dEaD' },
      quantityRaw: '1',
      decimals: 0,
    });
    await upsertBagHolding(db as never, {
      bagId: BAG_ID,
      asset: { chain: 'ethereum', address: '0xabcdef000000000000000000000000000000dead' },
      quantityRaw: '2',
      decimals: 0,
    });

    const all = await getBagHoldings(db as never, BAG_ID);
    expect(all).toHaveLength(1);
    expect(all[0].quantityRaw).toBe('2'); // second call updated the same row
  });
});

describe('update', () => {
  it('changing the quantity updates the same holding row, not a new one', async () => {
    await upsertBagHolding(db as never, { bagId: BAG_ID, asset: BTC, quantityRaw: '5', decimals: 0 });
    const updated = await upsertBagHolding(db as never, { bagId: BAG_ID, asset: BTC, quantityRaw: '9', decimals: 0 });

    expect(updated.quantityRaw).toBe('9');
    const all = await getBagHoldings(db as never, BAG_ID);
    expect(all).toHaveLength(1);
    expect(all[0].quantityRaw).toBe('9');
  });
});

describe('remove', () => {
  it('removes a holding', async () => {
    await upsertBagHolding(db as never, { bagId: BAG_ID, asset: BTC, quantityRaw: '5', decimals: 0 });
    await upsertBagHolding(db as never, { bagId: BAG_ID, asset: ETH, quantityRaw: '3', decimals: 0 });

    await removeBagHolding(db as never, BAG_ID, BTC);

    const all = await getBagHoldings(db as never, BAG_ID);
    expect(all).toHaveLength(1);
    expect(all[0].asset.address).toBe(ETH.address);
  });
});

describe('replaceBagHoldings — atomic batch', () => {
  it('replaces the entire holdings set in one call', async () => {
    await upsertBagHolding(db as never, { bagId: BAG_ID, asset: BTC, quantityRaw: '5', decimals: 0 });

    const result = await replaceBagHoldings(db as never, BAG_ID, [
      { asset: BTC, quantityRaw: '10', decimals: 0 },
      { asset: ETH, quantityRaw: '20', decimals: 0 },
    ]);

    expect(result).toHaveLength(2);
    const all = await getBagHoldings(db as never, BAG_ID);
    expect(all).toHaveLength(2);
    expect(all.find((h) => h.asset.address === BTC.address)?.quantityRaw).toBe('10');
  });

  it('an empty replacement clears all holdings for the bag', async () => {
    await upsertBagHolding(db as never, { bagId: BAG_ID, asset: BTC, quantityRaw: '5', decimals: 0 });
    await replaceBagHoldings(db as never, BAG_ID, []);

    const all = await getBagHoldings(db as never, BAG_ID);
    expect(all).toEqual([]);
  });

  it('does not affect a different bag\'s holdings', async () => {
    await upsertBagHolding(db as never, { bagId: 'bag_2', asset: BTC, quantityRaw: '99', decimals: 0 });
    await replaceBagHoldings(db as never, BAG_ID, [{ asset: ETH, quantityRaw: '1', decimals: 0 }]);

    const otherBagHoldings = await getBagHoldings(db as never, 'bag_2');
    expect(otherBagHoldings).toHaveLength(1);
    expect(otherBagHoldings[0].quantityRaw).toBe('99');
  });
});
