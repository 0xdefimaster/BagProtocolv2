import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SHARE_DECIMALS, getShareSupply, setShareSupply } from '../bag-share-state-repo';

// -----------------------------------------------------------------------------
// Fake reproduces exactly the bag_share_state surface bag-share-state-repo.ts
// calls: `.select().eq().maybeSingle()` and `.upsert(...).select().single()`
// — same minimal-fake philosophy as bag-holdings-repo.test.ts.
// -----------------------------------------------------------------------------

interface Row {
  [key: string]: unknown;
}

class FakeQueryBuilder {
  private filters: Array<(row: Row) => boolean> = [];
  private upsertRow: Row | null = null;

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

  private resolve(): Row[] {
    return Array.from(this.table.values()).filter((row) => this.filters.every((f) => f(row)));
  }

  async maybeSingle() {
    const rows = this.resolve();
    return { data: rows[0] ?? null, error: null };
  }

  async single() {
    if (this.upsertRow) {
      const bagId = this.upsertRow.bag_id as string;
      const existing = this.table.get(bagId);
      const row: Row = { ...(existing ?? {}), ...this.upsertRow };
      this.table.set(bagId, row);
      return { data: row, error: null };
    }
    const rows = this.resolve();
    if (rows.length === 0) return { data: null, error: { message: 'no row found' } };
    return { data: rows[0], error: null };
  }
}

class FakeSupabase {
  bagShareState = new Map<string, Row>();

  from(tableName: string) {
    if (tableName !== 'bag_share_state') throw new Error(`FakeSupabase: unexpected table "${tableName}"`);
    return new FakeQueryBuilder(this.bagShareState);
  }
}

let db: FakeSupabase;

beforeEach(() => {
  db = new FakeSupabase();
});

const BAG_ID = 'bag_1';

describe('getShareSupply — bootstrap (no row yet)', () => {
  it('returns a zero-supply ShareSupply, never throws, for a Bag with no persisted row', async () => {
    const supply = await getShareSupply(db as never, BAG_ID);
    expect(supply.bagId).toBe(BAG_ID);
    expect(supply.totalSharesRaw).toBe('0');
    expect(supply.shareDecimals).toBe(DEFAULT_SHARE_DECIMALS);
  });

  it('the bootstrap updatedAt is the epoch — distinguishable from a real, freshly-written zero row', async () => {
    const supply = await getShareSupply(db as never, BAG_ID);
    expect(supply.updatedAt).toBe(new Date(0).toISOString());
  });
});

describe('setShareSupply / getShareSupply round trip', () => {
  it('a written row is read back exactly', async () => {
    await setShareSupply(db as never, { bagId: BAG_ID, totalSharesRaw: '5000000000000000000000', shareDecimals: 18 });
    const supply = await getShareSupply(db as never, BAG_ID);
    expect(supply.totalSharesRaw).toBe('5000000000000000000000');
    expect(supply.shareDecimals).toBe(18);
    expect(supply.updatedAt).not.toBe(new Date(0).toISOString());
  });

  it('writing twice for the same bag updates in place — one row, no duplicate', async () => {
    await setShareSupply(db as never, { bagId: BAG_ID, totalSharesRaw: '100', shareDecimals: 18 });
    await setShareSupply(db as never, { bagId: BAG_ID, totalSharesRaw: '200', shareDecimals: 18 });
    expect(db.bagShareState.size).toBe(1);
    const supply = await getShareSupply(db as never, BAG_ID);
    expect(supply.totalSharesRaw).toBe('200');
  });

  it('respects a non-default shareDecimals', async () => {
    await setShareSupply(db as never, { bagId: BAG_ID, totalSharesRaw: '100', shareDecimals: 6 });
    const supply = await getShareSupply(db as never, BAG_ID);
    expect(supply.shareDecimals).toBe(6);
  });

  it('two different bags never collide', async () => {
    await setShareSupply(db as never, { bagId: 'bag_a', totalSharesRaw: '111', shareDecimals: 18 });
    await setShareSupply(db as never, { bagId: 'bag_b', totalSharesRaw: '222', shareDecimals: 18 });
    expect((await getShareSupply(db as never, 'bag_a')).totalSharesRaw).toBe('111');
    expect((await getShareSupply(db as never, 'bag_b')).totalSharesRaw).toBe('222');
  });
});
