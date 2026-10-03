import { beforeEach, describe, expect, it } from 'vitest';
import {
  ListAssetsOptions,
  getAssetByIdentity,
  getVerifiedIdentityKeys,
  listAssets,
  registerAsset,
  setAssetStatus,
  updateAssetMultiplier,
} from '../asset-repo';

// -----------------------------------------------------------------------------
// Fake Supabase client reproducing exactly the surface `asset-repo.ts` calls
// (`.from('assets').insert().select().single()`, `.select().eq().eq()
// .maybeSingle()`, `.select().in().in().eq()` awaited directly, `.update()
// .eq().select().single()`) backed by an in-memory array. Duplicate
// `(chain, address)` inserts surface as Postgres error code '23505', same
// as the real `unique(chain, address)` constraint in supabase/schema.sql —
// see lib/server/__tests__/bag-repo.test.ts for the sibling fake this one
// follows the same shape as.
// -----------------------------------------------------------------------------

interface Row {
  [key: string]: unknown;
}

class FakeAssetsClient {
  private rows: Row[] = [];
  private idCounter = 0;

  from(table: string) {
    if (table !== 'assets') throw new Error(`FakeAssetsClient: unexpected table "${table}"`);
    return new AssetsQueryBuilder(this);
  }

  insertRow(row: Row): { data: Row | null; error: { code: string; message: string } | null } {
    const dup = this.rows.find((r) => r.chain === row.chain && r.address === row.address);
    if (dup) {
      return {
        data: null,
        error: { code: '23505', message: 'duplicate key value violates unique constraint "assets_chain_address_key"' },
      };
    }
    const id = `asset_${++this.idCounter}`;
    const full: Row = { id, ...row };
    this.rows.push(full);
    return { data: full, error: null };
  }

  selectRows(filters: Array<(r: Row) => boolean>): Row[] {
    return this.rows.filter((r) => filters.every((f) => f(r)));
  }

  updateRow(id: string, patch: Row): Row | null {
    const idx = this.rows.findIndex((r) => r.id === id);
    if (idx === -1) return null;
    this.rows[idx] = { ...this.rows[idx], ...patch };
    return this.rows[idx];
  }
}

class AssetsQueryBuilder {
  private filters: Array<(r: Row) => boolean> = [];
  private mode: 'select' | 'insert' | 'update' = 'select';
  private insertPayload: Row | null = null;
  private updatePatch: Row | null = null;
  private orderBy: { col: string; ascending: boolean } | null = null;
  private limitN: number | null = null;

  constructor(private client: FakeAssetsClient) {}

  insert(row: Row) {
    this.mode = 'insert';
    this.insertPayload = row;
    return this;
  }

  update(patch: Row) {
    this.mode = 'update';
    this.updatePatch = patch;
    return this;
  }

  select() {
    return this;
  }

  eq(col: string, val: unknown) {
    this.filters.push((r) => r[col] === val);
    return this;
  }

  in(col: string, vals: unknown[]) {
    this.filters.push((r) => vals.includes(r[col]));
    return this;
  }

  /**
   * Minimal parser for the one `.or()` shape `asset-repo.ts` actually
   * produces: a comma-joined list of `and(chain.eq.X,address.eq.Y)`
   * clauses. Matches a row iff it satisfies at least one (chain, address)
   * pair as a PAIR — not chain-in-any and address-in-any independently —
   * so the fake actually exercises the bug this filter was written to fix.
   */
  or(filter: string) {
    const pairs: Array<{ chain: string; address: string }> = [];
    const re = /and\(chain\.eq\.([^,]+),address\.eq\.([^)]+)\)/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(filter))) {
      pairs.push({ chain: match[1], address: match[2] });
    }
    this.filters.push((r) => pairs.some((p) => r.chain === p.chain && r.address === p.address));
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

  async maybeSingle() {
    const rows = this.client.selectRows(this.filters);
    return { data: rows[0] ?? null, error: null };
  }

  async single() {
    if (this.mode === 'insert') {
      return this.client.insertRow(this.insertPayload as Row);
    }
    if (this.mode === 'update') {
      const target = this.client.selectRows(this.filters)[0];
      if (!target) return { data: null, error: { message: 'not found' } };
      const updated = this.client.updateRow(target.id as string, this.updatePatch as Row);
      return { data: updated, error: null };
    }
    const rows = this.client.selectRows(this.filters);
    if (rows.length === 0) return { data: null, error: { message: 'no row found' } };
    return { data: rows[0], error: null };
  }

  // Makes an un-terminated builder (e.g. `getVerifiedIdentityKeys`'s bare `await query`) awaitable directly, like real supabase-js.
  then(resolve: (v: { data: Row[]; error: null }) => void) {
    let rows = this.client.selectRows(this.filters);
    if (this.orderBy) {
      const { col, ascending } = this.orderBy;
      rows = [...rows].sort((a, b) => {
        const cmp = (a[col] as string) < (b[col] as string) ? -1 : 1;
        return ascending ? cmp : -cmp;
      });
    }
    if (this.limitN !== null) rows = rows.slice(0, this.limitN);
    resolve({ data: rows, error: null });
  }
}

function fakeAdmin() {
  // asset-repo.ts is typed against the real SupabaseClient — the fake only
  // needs to satisfy the subset of methods actually called.
  return new FakeAssetsClient() as unknown as import('@supabase/supabase-js').SupabaseClient;
}

describe('registerAsset', () => {
  let admin: ReturnType<typeof fakeAdmin>;
  beforeEach(() => {
    admin = fakeAdmin();
  });

  it('registers a new asset, defaulting to VERIFIED status', async () => {
    const result = await registerAsset(admin, {
      chain: 'ethereum',
      address: '0x1111111111111111111111111111111111111a',
      symbol: 'BTC',
      decimals: 18,
      name: 'Bitcoin (Wrapped)',
      assetType: 'crypto',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.asset.status).toBe('VERIFIED');
      expect(result.asset.address).toBe('0x1111111111111111111111111111111111111a');
    }
  });

  it('normalizes the address before storing (mixed-case EVM address is lowercased)', async () => {
    const result = await registerAsset(admin, {
      chain: 'ethereum',
      address: '0xAbCdEf1111111111111111111111111111111111',
      symbol: 'BTC',
      decimals: 18,
      name: 'Bitcoin (Wrapped)',
      assetType: 'crypto',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.asset.address).toBe('0xabcdef1111111111111111111111111111111111');
    }
  });

  it('same asset → cannot register twice', async () => {
    await registerAsset(admin, {
      chain: 'ethereum',
      address: '0x1111111111111111111111111111111111111a',
      symbol: 'BTC',
      decimals: 18,
      name: 'Bitcoin (Wrapped)',
      assetType: 'crypto',
    });
    const second = await registerAsset(admin, {
      chain: 'ethereum',
      address: '0x1111111111111111111111111111111111111a',
      symbol: 'BTC',
      decimals: 18,
      name: 'Bitcoin (Wrapped), dup',
      assetType: 'crypto',
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toBe('DUPLICATE_ASSET');
  });

  it('registering the same address on a different chain is allowed', async () => {
    const address = '0x1111111111111111111111111111111111111a';
    const first = await registerAsset(admin, { chain: 'ethereum', address, symbol: 'BTC', decimals: 18, name: 'BTC', assetType: 'crypto' });
    const second = await registerAsset(admin, { chain: 'base', address, symbol: 'BTC', decimals: 18, name: 'BTC', assetType: 'crypto' });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
  });

  it('duplicate protection catches casing-only collisions', async () => {
    await registerAsset(admin, {
      chain: 'ethereum',
      address: '0xabcdef1111111111111111111111111111111111',
      symbol: 'BTC',
      decimals: 18,
      name: 'BTC',
      assetType: 'crypto',
    });
    const dup = await registerAsset(admin, {
      chain: 'ethereum',
      address: '0xAbCdEf1111111111111111111111111111111111',
      symbol: 'BTC',
      decimals: 18,
      name: 'BTC dup',
      assetType: 'crypto',
    });
    expect(dup.ok).toBe(false);
  });
});

describe('getAssetByIdentity', () => {
  it('finds a registered asset regardless of address casing', async () => {
    const admin = fakeAdmin();
    await registerAsset(admin, {
      chain: 'ethereum',
      address: '0x1111111111111111111111111111111111111a',
      symbol: 'BTC',
      decimals: 18,
      name: 'BTC',
      assetType: 'crypto',
    });
    const found = await getAssetByIdentity(admin, {
      chain: 'ethereum',
      address: '0x1111111111111111111111111111111111111A'.toUpperCase(),
    });
    expect(found?.symbol).toBe('BTC');
  });

  it('returns null for an unregistered identity', async () => {
    const admin = fakeAdmin();
    const found = await getAssetByIdentity(admin, { chain: 'ethereum', address: '0xdead' });
    expect(found).toBeNull();
  });
});

describe('listAssets', () => {
  it('filters by status', async () => {
    const admin = fakeAdmin();
    await registerAsset(admin, {
      chain: 'ethereum',
      address: '0x1111111111111111111111111111111111111a',
      symbol: 'BTC',
      decimals: 18,
      name: 'BTC',
      assetType: 'crypto',
      status: 'VERIFIED',
    });
    await registerAsset(admin, {
      chain: 'ethereum',
      address: '0x2222222222222222222222222222222222222b',
      symbol: 'SCAM',
      decimals: 18,
      name: 'Scam Token',
      assetType: 'crypto',
      status: 'UNKNOWN',
    });

    const verified: ListAssetsOptions = { status: 'VERIFIED' };
    const verifiedAssets = await listAssets(admin, verified);
    expect(verifiedAssets).toHaveLength(1);
    expect(verifiedAssets[0].symbol).toBe('BTC');
  });
});

describe('setAssetStatus', () => {
  it('transitions VERIFIED -> DEPRECATED', async () => {
    const admin = fakeAdmin();
    const registered = await registerAsset(admin, {
      chain: 'ethereum',
      address: '0x1111111111111111111111111111111111111a',
      symbol: 'BTC',
      decimals: 18,
      name: 'BTC',
      assetType: 'crypto',
    });
    if (!registered.ok) throw new Error('setup failed');

    const updated = await setAssetStatus(admin, registered.asset.id, 'DEPRECATED');
    expect(updated.status).toBe('DEPRECATED');
  });
});

describe('updateAssetMultiplier', () => {
  it('updates only current_multiplier, as a decimal string, never a parsed number', async () => {
    const admin = fakeAdmin();
    const registered = await registerAsset(admin, {
      chain: 'robinhood',
      address: '0x1111111111111111111111111111111111111a',
      symbol: 'NVDA',
      decimals: 18,
      name: 'NVIDIA • Robinhood Token',
      assetType: 'crypto',
      currentMultiplier: '1.000000000000000000',
    });
    if (!registered.ok) throw new Error('setup failed');

    const updated = await updateAssetMultiplier(admin, registered.asset.id, '2.000000000000000000');
    expect(updated.currentMultiplier).toBe('2.000000000000000000');
    expect(typeof updated.currentMultiplier).toBe('string');
    // Everything else about the row is untouched.
    expect(updated.symbol).toBe('NVDA');
    expect(updated.status).toBe('VERIFIED');
  });

  it('is idempotent — re-applying the same value is a harmless no-op update', async () => {
    const admin = fakeAdmin();
    const registered = await registerAsset(admin, {
      chain: 'robinhood',
      address: '0x2222222222222222222222222222222222222b',
      symbol: 'AAPL',
      decimals: 18,
      name: 'Apple • Robinhood Token',
      assetType: 'crypto',
      currentMultiplier: '1.0',
    });
    if (!registered.ok) throw new Error('setup failed');

    await updateAssetMultiplier(admin, registered.asset.id, '1.0');
    const again = await updateAssetMultiplier(admin, registered.asset.id, '1.0');
    expect(again.currentMultiplier).toBe('1.0');
  });
});

describe('getVerifiedIdentityKeys', () => {
  it('includes only VERIFIED assets among the requested identities', async () => {
    const admin = fakeAdmin();
    await registerAsset(admin, {
      chain: 'ethereum',
      address: '0x1111111111111111111111111111111111111a',
      symbol: 'BTC',
      decimals: 18,
      name: 'BTC',
      assetType: 'crypto',
      status: 'VERIFIED',
    });
    await registerAsset(admin, {
      chain: 'ethereum',
      address: '0x2222222222222222222222222222222222222b',
      symbol: 'SCAM',
      decimals: 18,
      name: 'Scam Token',
      assetType: 'crypto',
      status: 'UNKNOWN',
    });

    const keys = await getVerifiedIdentityKeys(admin, [
      { chain: 'ethereum', address: '0x1111111111111111111111111111111111111a' },
      { chain: 'ethereum', address: '0x2222222222222222222222222222222222222b' },
      { chain: 'ethereum', address: '0x3333333333333333333333333333333333333c' }, // never registered
    ]);

    expect(keys.has('ethereum:0x1111111111111111111111111111111111111a')).toBe(true);
    expect(keys.has('ethereum:0x2222222222222222222222222222222222222b')).toBe(false);
    expect(keys.has('ethereum:0x3333333333333333333333333333333333333c')).toBe(false);
  });

  it('returns an empty set for an empty identity list without querying', async () => {
    const admin = fakeAdmin();
    const keys = await getVerifiedIdentityKeys(admin, []);
    expect(keys.size).toBe(0);
  });

  it('never cross-matches chain/address independently: requesting (base, A) + (ethereum, B) does not verify against a registry holding (base, B) + (ethereum, A)', async () => {
    const admin = fakeAdmin();
    const addressA = '0x1111111111111111111111111111111111111a';
    const addressB = '0x2222222222222222222222222222222222222b';

    // Registry has the CROSSED pairs, not the requested ones.
    await registerAsset(admin, { chain: 'base', address: addressB, symbol: 'X', decimals: 18, name: 'X', assetType: 'crypto', status: 'VERIFIED' });
    await registerAsset(admin, { chain: 'ethereum', address: addressA, symbol: 'Y', decimals: 18, name: 'Y', assetType: 'crypto', status: 'VERIFIED' });

    const keys = await getVerifiedIdentityKeys(admin, [
      { chain: 'base', address: addressA },
      { chain: 'ethereum', address: addressB },
    ]);

    // Neither requested (chain, address) PAIR was actually registered —
    // an independent chain-in/address-in filter would incorrectly report
    // both as verified here.
    expect(keys.has('base:' + addressA)).toBe(false);
    expect(keys.has('ethereum:' + addressB)).toBe(false);
    expect(keys.size).toBe(0);
  });

  it('verifies both pairs when the registry holds exactly the requested (chain, address) pairs', async () => {
    const admin = fakeAdmin();
    const addressA = '0x1111111111111111111111111111111111111a';
    const addressB = '0x2222222222222222222222222222222222222b';

    await registerAsset(admin, { chain: 'base', address: addressA, symbol: 'X', decimals: 18, name: 'X', assetType: 'crypto', status: 'VERIFIED' });
    await registerAsset(admin, { chain: 'ethereum', address: addressB, symbol: 'Y', decimals: 18, name: 'Y', assetType: 'crypto', status: 'VERIFIED' });

    const keys = await getVerifiedIdentityKeys(admin, [
      { chain: 'base', address: addressA },
      { chain: 'ethereum', address: addressB },
    ]);

    expect(keys.has('base:' + addressA)).toBe(true);
    expect(keys.has('ethereum:' + addressB)).toBe(true);
    expect(keys.size).toBe(2);
  });

  it('treats the same address on different chains as different identities', async () => {
    const admin = fakeAdmin();
    const sharedAddress = '0x1111111111111111111111111111111111111a';

    // Only the ethereum deployment is verified; base's is not registered at all.
    await registerAsset(admin, {
      chain: 'ethereum',
      address: sharedAddress,
      symbol: 'X',
      decimals: 18,
      name: 'X',
      assetType: 'crypto',
      status: 'VERIFIED',
    });

    const keys = await getVerifiedIdentityKeys(admin, [
      { chain: 'ethereum', address: sharedAddress },
      { chain: 'base', address: sharedAddress },
    ]);

    expect(keys.has('ethereum:' + sharedAddress)).toBe(true);
    expect(keys.has('base:' + sharedAddress)).toBe(false);
    expect(keys.size).toBe(1);
  });
});
