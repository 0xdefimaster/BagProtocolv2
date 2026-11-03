import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AssetIdentity, AssetPrice } from '@/types/basket-protocol';
import { PriceUnavailableError } from '@/lib/domain/basket-protocol/pricing/provider';
import { PriceSourceDisagreementError } from '@/lib/domain/basket-protocol/pricing/bag-price-router';
import { DEFAULT_SALE_PRICE_POLICY } from '@/lib/domain/basket-protocol/redeem/sale-price-confidence';
import { loadFeeSaleInventory, readAllPages, runFeeSaleCoverageGate, type InventoryResult } from '../fee-sale-coverage-gate';

// The fee-sale feed-coverage release gate (scripts/check-fee-sale-feed-coverage.ts), end to end over a scripted
// Supabase and a scripted price router. Synthetic ids and addresses only; no credentials.

const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const A = '0x00000000000000000000000000000000000000a1'; // stock, current recipe
const B = '0x00000000000000000000000000000000000000b2'; // stock, current recipe
const OLD = '0x00000000000000000000000000000000000000c3'; // stock, earlier version only
const WETH = '0x00000000000000000000000000000000000000e7'; // crypto
const FEED = '0x000000000000000000000000000000000000f00d';
const NOW = new Date('2026-11-03T12:00:00Z');
const CREATOR = 'u-creator';

// ------------------------------- scripted Supabase ------------------------------

type Row = Record<string, unknown>;
interface Tables {
  bags: Row[];
  bag_versions: Row[];
  bag_investor_holdings: Row[];
  assets: Row[];
}
/** A minimal PostgREST-like client: select(count) · eq · order · range, and select · in for bag_versions. */
function fakeSupabase(t: Tables, o: { maxRows?: number; failTable?: string; growDuringScan?: string } = {}): SupabaseClient {
  const reads: Record<string, number> = {};
  const from = (table: keyof Tables) => {
    let rows = [...t[table]];
    const q = {
      select: () => q,
      eq: (c: string, v: unknown) => ((rows = rows.filter((r) => r[c] === v)), q),
      in: async (c: string, vs: unknown[]) => ({ data: rows.filter((r) => vs.includes(r[c])), error: o.failTable === table ? { message: 'boom' } : null }),
      order: (c: string) => ((rows = [...rows].sort((x, y) => String(x[c]).localeCompare(String(y[c])))), q),
      range: async (fromIdx: number, toIdx: number) => {
        reads[table] = (reads[table] ?? 0) + 1;
        if (o.failTable === table) return { data: null, error: { message: 'connection refused' }, count: null };
        const count = rows.length + (o.growDuringScan === table && reads[table] > 1 ? 1 : 0);
        const end = Math.min(toIdx, fromIdx + (o.maxRows ?? Infinity) - 1);
        return { data: rows.slice(fromIdx, end + 1), error: null, count };
      },
    };
    return q;
  };
  return { from } as unknown as SupabaseClient;
}

const bag = (id: string, o: Partial<{ fee: number | null; locked: number | null; assets: string[]; chain: string; version: string | null }> = {}) => ({
  bagRow: { id, name: `Bag ${id}`, chain: o.chain ?? 'robinhood', creator_id: CREATOR, performance_fee_bps_locked: o.locked ?? null, current_version_id: o.version === undefined ? `v-${id}` : o.version },
  versionRow: { id: `v-${id}`, bag_id: id, recipe: { performanceFeeBps: o.fee ?? 1000, assets: (o.assets ?? [A]).map((a) => ({ address: a, symbol: a.slice(-2).toUpperCase() })) } },
});
const holding = (bagId: string, userId: string, address: string, qty = '100') => ({ user_id: userId, bag_id: bagId, chain: 'robinhood', address, quantity_raw: qty });
const assetsTable = [
  { id: 'as-a', address: A, asset_type: 'stock', chain: 'robinhood' },
  { id: 'as-b', address: B, asset_type: 'stock', chain: 'robinhood' },
  { id: 'as-old', address: OLD, asset_type: 'stock', chain: 'robinhood' },
  { id: 'as-weth', address: WETH, asset_type: 'crypto', chain: 'robinhood' },
  { id: 'as-usdg', address: USDG, asset_type: 'crypto', chain: 'robinhood' },
];
function tables(bags: ReturnType<typeof bag>[], holdings: Row[]): Tables {
  return { bags: bags.map((b) => b.bagRow), bag_versions: bags.map((b) => b.versionRow), bag_investor_holdings: holdings, assets: assetsTable };
}

// ------------------------------- scripted prices --------------------------------

const verified = (a: AssetIdentity): AssetPrice => ({
  asset: a,
  price: '10',
  quoteCurrency: 'USD',
  timestamp: new Date(NOW.getTime() - 5_000).toISOString(),
  source: `robinhood-api:prices:X:mid×1.000000000000000000|verify:chainlink:${FEED}:4bps`,
  confidence: 1,
});
type PriceScript = Record<string, (a: AssetIdentity) => AssetPrice>;
const prices = (overrides: PriceScript = {}) => async (a: AssetIdentity) => (overrides[a.address.toLowerCase()] ?? verified)(a);

async function gate(t: Tables, o: { feeds?: Record<string, string>; probe?: PriceScript | null; supa?: Parameters<typeof fakeSupabase>[1] } = {}) {
  const admin = fakeSupabase(t, o.supa);
  return runFeeSaleCoverageGate({
    loadInventory: () => loadFeeSaleInventory(admin),
    feeds: o.feeds ?? { [A]: FEED, [B]: FEED, [OLD]: FEED },
    settlementTokenAddress: USDG,
    probe: o.probe === null ? undefined : { getPrice: prices(o.probe ?? {}), policy: DEFAULT_SALE_PRICE_POLICY, now: () => NOW },
  });
}

const oneBag = () => tables([bag('b1', { assets: [A, B] })], [holding('b1', 'investor', A), holding('b1', 'investor', B)]);

describe('fee-sale coverage gate — exit codes', () => {
  it('(1) complete inventory, feeds present, probe verifies every leg → exit 0', async () => {
    const r = await gate(oneBag());
    expect(r.exitCode).toBe(0);
    expect(r.report?.status).toBe('STATIC_COMPLETE');
    expect([...r.probe!.values()].map((o) => o.status)).toEqual(['VERIFIED_NOW', 'VERIFIED_NOW']);
  });

  it('(2) a required feed is missing → exit 1 (static), with or without probe', async () => {
    for (const probe of [null, {}] as const) {
      const r = await gate(oneBag(), { feeds: { [A]: FEED }, probe });
      expect(r.exitCode).toBe(1);
      expect(r.report?.bags[0].legs.find((l) => l.address === B)?.coverage).toBe('MISSING_FEED');
    }
  });

  it('(3) feed configured but unreadable (router: CHAINLINK_UNAVAILABLE, confidence 0.5) → NOT_VERIFIED_NOW, exit 1', async () => {
    const unavailable = (a: AssetIdentity): AssetPrice => ({ ...verified(a), confidence: 0.5, source: 'robinhood-api:prices:X:mid×1.000000000000000000|verify:chainlink-unavailable' });
    const r = await gate(oneBag(), { probe: { [B]: unavailable } });
    expect(r.report?.status).toBe('STATIC_COMPLETE'); // configuration alone says nothing about this
    expect(r.probe!.get(`robinhood:${B}`)).toMatchObject({ status: 'NOT_VERIFIED_NOW', reason: expect.stringContaining('CHAINLINK_UNAVAILABLE') });
    expect(r.exitCode).toBe(1);
  });

  it('(4) API and Chainlink disagree → NOT_VERIFIED_NOW SOURCES_DISAGREE, exit 1', async () => {
    const r = await gate(oneBag(), {
      probe: {
        [A]: (a) => {
          throw new PriceSourceDisagreementError(a, BigInt(350), 'robinhood-api', 'chainlink');
        },
      },
    });
    expect(r.probe!.get(`robinhood:${A}`)).toEqual({ status: 'NOT_VERIFIED_NOW', reason: 'SOURCES_DISAGREE' });
    expect(r.exitCode).toBe(1);
  });

  it('(5) a stale price (policy PRICE_STALE, or the API refusing a stale quote) → exit 1', async () => {
    const stale = (a: AssetIdentity): AssetPrice => ({ ...verified(a), timestamp: new Date(NOW.getTime() - 10 * 60_000).toISOString() });
    let r = await gate(oneBag(), { probe: { [A]: stale } });
    expect(r.probe!.get(`robinhood:${A}`)).toEqual({ status: 'NOT_VERIFIED_NOW', reason: 'POLICY_PRICE_STALE' });
    expect(r.exitCode).toBe(1);
    r = await gate(oneBag(), {
      probe: {
        [A]: (a) => {
          throw new PriceUnavailableError(a, 'STALE_QUOTE');
        },
      },
    });
    expect(r.probe!.get(`robinhood:${A}`)).toEqual({ status: 'NOT_VERIFIED_NOW', reason: 'STALE_QUOTE' });
    expect(r.exitCode).toBe(1);
  });

  it('(6) a confidence/source pair the policy does not accept → exit 1', async () => {
    const mislabelled = (a: AssetIdentity): AssetPrice => ({ ...verified(a), source: 'robinhood-api:prices:X:mid×1.000000000000000000' });
    const r = await gate(oneBag(), { probe: { [A]: mislabelled } });
    expect(r.probe!.get(`robinhood:${A}`)).toEqual({ status: 'NOT_VERIFIED_NOW', reason: 'POLICY_SOURCE_NOT_QUALIFIED' });
    expect(r.exitCode).toBe(1);
  });

  it('(7) RPC / source outage during the probe → PROBE_ERROR, exit 2 (never a pass, never skipped)', async () => {
    for (const thrower of [
      (a: AssetIdentity): AssetPrice => {
        throw new PriceUnavailableError(a, 'SOURCE_UNAVAILABLE');
      },
      (): AssetPrice => {
        throw new Error('HTTP request failed');
      },
    ]) {
      const r = await gate(oneBag(), { probe: { [A]: thrower } });
      expect(r.probe!.get(`robinhood:${A}`)?.status).toBe('PROBE_ERROR');
      expect(r.exitCode).toBe(2);
    }
  });

  it('(8) Supabase error → INCOMPLETE, exit 2, no report', async () => {
    for (const failTable of ['bags', 'bag_investor_holdings', 'assets', 'bag_versions']) {
      const r = await gate(oneBag(), { supa: { failTable } });
      expect(r.exitCode).toBe(2);
      expect(r.report).toBeNull();
      expect(r.inventoryError).toMatch(failTable);
    }
  });

  it('(9) pagination cannot be completed (page cap below page size, or rows added mid-scan) → exit 2', async () => {
    const many = tables(
      Array.from({ length: 1203 }, (_, i) => bag(`b${String(i).padStart(4, '0')}`, { fee: 0 })),
      []
    );
    let r = await gate(many, { supa: { maxRows: 100 } }); // PostgREST max-rows smaller than the requested page
    expect(r.exitCode).toBe(2);
    expect(r.inventoryError).toMatch(/ROW_COUNT_MISMATCH/);
    r = await gate(many, { supa: { growDuringScan: 'bags' } });
    expect(r.exitCode).toBe(2);
    expect(r.inventoryError).toMatch(/COUNT_CHANGED_DURING_SCAN/);
  });

  it('(10) more than 1,000 Bags: every one is scanned (and a fee Bag on the last page is gated)', async () => {
    const list = Array.from({ length: 1203 }, (_, i) => bag(`b${String(i).padStart(4, '0')}`, { fee: 0 }));
    list.push(bag('zz-last', { fee: 500, assets: [B] }));
    const r = await gate(tables(list, [holding('zz-last', 'investor', B)]), { feeds: { [A]: FEED } });
    expect(r.report?.totals.bagsScanned).toBe(1204);
    expect(r.report?.bags.map((b) => b.id)).toEqual(['zz-last']);
    expect(r.exitCode).toBe(1); // B has no feed: the Bag beyond row 1000 was not missed
  });
});

describe('fee-sale coverage gate — which assets are required', () => {
  it('(11) a token from an earlier version still held by an investor is required (HELD_FROM_EARLIER_VERSION)', async () => {
    const t = tables([bag('b1', { assets: [A] })], [holding('b1', 'investor', A), holding('b1', 'investor', OLD)]);
    let r = await gate(t, { feeds: { [A]: FEED } });
    const old = r.report!.bags[0].legs.find((l) => l.address === OLD)!;
    expect(old).toMatchObject({ origin: 'HELD_FROM_EARLIER_VERSION', coverage: 'MISSING_FEED', feeHolders: 1 });
    expect(r.exitCode).toBe(1);
    r = await gate(t, { feeds: { [A]: FEED, [OLD]: FEED } });
    expect(r.exitCode).toBe(0);
    expect(r.probe!.has(`robinhood:${OLD}`)).toBe(true); // probed like any other required leg
  });

  it('(12) an earlier-version token no longer held anywhere is not shown as a sale asset', async () => {
    // OLD was in an earlier recipe, but every holding of it is 0 now.
    const t = tables([bag('b1', { assets: [A] })], [holding('b1', 'investor', A), holding('b1', 'investor', OLD, '0')]);
    const r = await gate(t, { feeds: { [A]: FEED } });
    expect(r.report!.bags[0].legs.map((l) => l.address)).toEqual([A]);
    expect(r.probe!.has(`robinhood:${OLD}`)).toBe(false);
    expect(r.exitCode).toBe(0);
  });

  it('(13) the creator’s own holdings take the free path: counted, not gated; investors’ are gated', async () => {
    // Only the creator holds WETH (crypto, no qualified source): not a fee-sale leg. The investor holds A.
    const t = tables([bag('b1', { assets: [A] })], [holding('b1', CREATOR, WETH), holding('b1', CREATOR, A), holding('b1', 'investor', A)]);
    const r = await gate(t, { feeds: { [A]: FEED } });
    expect(r.report!.bags[0]).toMatchObject({ feePositions: 1, creatorPositions: 1 });
    expect(r.report!.bags[0].legs.map((l) => l.address)).toEqual([A]);
    expect(r.exitCode).toBe(0);
    // The same WETH held by an investor IS a fee-sale leg, and it cannot be priced under the policy.
    const t2 = tables([bag('b1', { assets: [A] })], [holding('b1', 'investor', WETH), holding('b1', 'investor', A)]);
    const r2 = await gate(t2, { feeds: { [A]: FEED } });
    expect(r2.report!.bags[0].legs.find((l) => l.address === WETH)?.coverage).toBe('NO_QUALIFIED_SOURCE');
    expect(r2.exitCode).toBe(1);
  });

  it('(14) no fee-bearing Bag → explicit NO_FEE_BEARING_POSITIONS, exit 0, nothing probed', async () => {
    const t = tables([bag('b1', { fee: 0 }), bag('b2', { fee: 0, locked: 0 })], [holding('b1', 'investor', WETH)]);
    const r = await gate(t);
    expect(r.report?.status).toBe('NO_FEE_BEARING_POSITIONS');
    expect(r.probe!.size).toBe(0);
    expect(r.exitCode).toBe(0);
  });

  it('the locked rate wins over the recipe (an external investor locked it), as in the settlement path', async () => {
    const t = tables([bag('b1', { fee: 0, locked: 800, assets: [A] })], [holding('b1', 'investor', A)]);
    const r = await gate(t, { feeds: {} });
    expect(r.report!.bags[0]).toMatchObject({ feeBps: 800, feeSource: 'LOCKED', status: 'FEE_SALE_REFUSED' });
    expect(r.exitCode).toBe(1);
  });

  it('current-recipe assets nobody holds yet are still required (future buyers sell them)', async () => {
    const t = tables([bag('b1', { assets: [A, B] })], []);
    const r = await gate(t, { feeds: { [A]: FEED } });
    expect(r.report!.bags[0].legs.map((l) => [l.address, l.origin, l.coverage])).toEqual([
      [A, 'CURRENT_RECIPE_NOT_HELD', 'FEED_CONFIGURED'],
      [B, 'CURRENT_RECIPE_NOT_HELD', 'MISSING_FEED'],
    ]);
    expect(r.exitCode).toBe(1);
  });

  it('a held Bag whose fee cannot be determined (no version, no locked rate) makes the run INCOMPLETE', async () => {
    const t = tables([bag('b1', { version: null })], [holding('b1', 'investor', A)]);
    t.bag_versions = [];
    const r = await gate(t);
    expect(r.report?.status).toBe('INCOMPLETE');
    expect(r.exitCode).toBe(2);
  });

  it('a fee-bearing Bag on another chain cannot settle a fee sale → CHAIN_NOT_SUPPORTED, exit 1', async () => {
    const t = tables([bag('b1', { chain: 'base' })], [holding('b1', 'investor', A)]);
    const r = await gate(t);
    expect(r.report!.bags[0].status).toBe('CHAIN_NOT_SUPPORTED');
    expect(r.exitCode).toBe(1);
  });
});

describe('readAllPages', () => {
  const pages = (rows: string[], count: number | null, pageCap = Infinity) => async (from: number, to: number) => ({
    rows: rows.slice(from, Math.min(to, from + pageCap - 1) + 1),
    count,
    error: null,
  });

  it('reads exactly count rows across pages, including an exact multiple of the page size', async () => {
    const rows = Array.from({ length: 1000 }, (_, i) => `r${i}`);
    const r = await readAllPages(pages(rows, 1000), (x) => x, 500);
    expect(r).toMatchObject({ ok: true, count: 1000 });
    if (r.ok) expect(r.rows).toHaveLength(1000);
  });

  it('refuses a missing count, a duplicate row, a short read, or a thrown error', async () => {
    expect(await readAllPages(pages(['a'], null), (x) => x, 10)).toEqual({ ok: false, reason: 'TOTAL_COUNT_UNAVAILABLE' });
    expect(await readAllPages(pages(['a', 'a'], 2), (x) => x, 10)).toMatchObject({ ok: false, reason: expect.stringMatching(/DUPLICATE_ROW/) });
    expect(await readAllPages(pages(['a', 'b', 'c'], 5), (x) => x, 10)).toMatchObject({ ok: false, reason: expect.stringMatching(/ROW_COUNT_MISMATCH/) });
    expect(
      await readAllPages(
        async () => {
          throw new Error('network');
        },
        (x: string) => x,
        10
      )
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/READ_FAILED/) });
  });

  it('a loadInventory that throws is an incomplete run, not a crash', async () => {
    const r = await runFeeSaleCoverageGate({
      loadInventory: (): Promise<InventoryResult> => Promise.reject(new Error('socket hang up')),
      feeds: {},
      settlementTokenAddress: USDG,
    });
    expect(r).toMatchObject({ exitCode: 2, report: null });
  });
});
