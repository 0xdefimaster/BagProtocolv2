import type { SupabaseClient } from '@supabase/supabase-js';
import type { AssetIdentity, AssetPrice } from '@/types/basket-protocol';
import {
  buildFeeSaleCoverage,
  classifyProbe,
  gateExitCode,
  requiredPricedLegs,
  type CoverageReport,
  type InventoryBag,
  type InventoryHolding,
  type ProbeOutcome,
} from '@/lib/domain/basket-protocol/redeem/fee-sale-feed-coverage';
import { salePriceDeviationLimit, type SalePricePolicy } from '@/lib/domain/basket-protocol/redeem/sale-price-confidence';

// -----------------------------------------------------------------------------
// The I/O half of the fee-sale feed-coverage release gate
// (scripts/check-fee-sale-feed-coverage.ts). READ-ONLY: selects only.
//
// Inventory integrity: every table is read in deterministic pages (ordered by
// its primary key) with an exact total count. The scan is accepted only when
// every page succeeded, the count never changed between pages, no key was
// seen twice and the rows read equal the count. Anything else — an error, a
// missing count, a page cap (PostgREST max-rows), concurrent writes — makes
// the inventory INCOMPLETE: exit 2, never a partial "success".
// -----------------------------------------------------------------------------

export interface Page<T> {
  rows: T[];
  count: number | null;
  error: { message: string } | null;
}
export type PagedResult<T> = { ok: true; rows: T[]; count: number } | { ok: false; reason: string };

export const COVERAGE_PAGE_SIZE = 500;

export async function readAllPages<T>(fetchPage: (from: number, to: number) => Promise<Page<T>>, keyOf: (row: T) => string, pageSize = COVERAGE_PAGE_SIZE): Promise<PagedResult<T>> {
  const rows: T[] = [];
  const seen = new Set<string>();
  let expected: number | null = null;
  for (let from = 0; ; from += pageSize) {
    let page: Page<T>;
    try {
      page = await fetchPage(from, from + pageSize - 1);
    } catch (e) {
      return { ok: false, reason: `READ_FAILED (${(e as Error)?.name ?? 'error'})` };
    }
    if (page.error) return { ok: false, reason: 'READ_FAILED' };
    if (page.count === null || !Number.isInteger(page.count) || page.count < 0) return { ok: false, reason: 'TOTAL_COUNT_UNAVAILABLE' };
    if (expected === null) expected = page.count;
    else if (page.count !== expected) return { ok: false, reason: `COUNT_CHANGED_DURING_SCAN (${expected} → ${page.count})` };
    if (page.rows.length > pageSize) return { ok: false, reason: 'PAGE_LARGER_THAN_REQUESTED' };
    for (const r of page.rows) {
      const k = keyOf(r);
      if (seen.has(k)) return { ok: false, reason: `DUPLICATE_ROW (${k})` };
      seen.add(k);
      rows.push(r);
    }
    if (page.rows.length < pageSize || rows.length >= expected) break;
  }
  if (rows.length !== expected) return { ok: false, reason: `ROW_COUNT_MISMATCH (read ${rows.length} of ${expected})` };
  return { ok: true, rows, count: expected };
}

export interface FeeSaleInventory {
  bags: InventoryBag[];
  holdings: InventoryHolding[];
  /** Robinhood registry: lowercase address → asset type. */
  assetTypes: Map<string, 'stock' | 'crypto'>;
}
export type InventoryResult = { ok: true; inventory: FeeSaleInventory } | { ok: false; reason: string };

type BagRow = { id: string; name: string; chain: string; creator_id: string; performance_fee_bps_locked: number | null; current_version_id: string | null };
type VersionRow = { id: string; bag_id: string; recipe: { performanceFeeBps?: number; assets?: { address: string; symbol: string }[] } };
type HoldingRow = { user_id: string; bag_id: string; chain: string; address: string; quantity_raw: string };
type AssetRow = { id: string; address: string; asset_type: string };

function supabasePage<T>(admin: SupabaseClient, table: string, columns: string, order: string[], eq?: [string, string]) {
  return async (from: number, to: number): Promise<Page<T>> => {
    let q = admin.from(table).select(columns, { count: 'exact' });
    if (eq) q = q.eq(eq[0], eq[1]);
    for (const o of order) q = q.order(o, { ascending: true });
    const { data, error, count } = await q.range(from, to);
    return { rows: (data ?? []) as T[], count: count ?? null, error: error ? { message: error.message } : null };
  };
}

/** Reads bags (+ current recipes), every holding row and the Robinhood asset registry, completely or not at all. */
export async function loadFeeSaleInventory(admin: SupabaseClient): Promise<InventoryResult> {
  const bags = await readAllPages<BagRow>(supabasePage(admin, 'bags', 'id, name, chain, creator_id, performance_fee_bps_locked, current_version_id', ['id']), (r) => r.id);
  if (!bags.ok) return { ok: false, reason: `bags: ${bags.reason}` };
  const holdings = await readAllPages<HoldingRow>(
    supabasePage(admin, 'bag_investor_holdings', 'user_id, bag_id, chain, address, quantity_raw', ['bag_id', 'user_id', 'chain', 'address']),
    (r) => `${r.user_id}|${r.bag_id}|${r.chain}|${r.address}`
  );
  if (!holdings.ok) return { ok: false, reason: `bag_investor_holdings: ${holdings.reason}` };
  const assets = await readAllPages<AssetRow>(
    supabasePage(admin, 'assets', 'id, address, asset_type', ['id'], ['chain', 'robinhood']),
    (r) => r.id
  );
  if (!assets.ok) return { ok: false, reason: `assets: ${assets.reason}` };

  // Current versions, by id, in chunks; every requested id must come back exactly once.
  const versionIds = [...new Set(bags.rows.map((b) => b.current_version_id).filter((v): v is string => typeof v === 'string'))];
  const versions = new Map<string, VersionRow>();
  for (let i = 0; i < versionIds.length; i += 200) {
    const chunk = versionIds.slice(i, i + 200);
    const { data, error } = await admin.from('bag_versions').select('id, bag_id, recipe').in('id', chunk);
    if (error) return { ok: false, reason: 'bag_versions: READ_FAILED' };
    for (const v of (data ?? []) as VersionRow[]) {
      if (versions.has(v.id)) return { ok: false, reason: `bag_versions: DUPLICATE_ROW (${v.id})` };
      versions.set(v.id, v);
    }
  }
  const missing = versionIds.filter((id) => !versions.has(id));
  if (missing.length > 0) return { ok: false, reason: `bag_versions: ${missing.length} current version(s) not found` };

  return { ok: true, inventory: inventoryFromRows(bags.rows, versions, holdings.rows, assets.rows) };
}

export function inventoryFromRows(bagRows: BagRow[], versions: Map<string, VersionRow>, holdingRows: HoldingRow[], assetRows: AssetRow[]): FeeSaleInventory {
  return {
    bags: bagRows.map((b) => {
      const v = b.current_version_id ? versions.get(b.current_version_id) : undefined;
      return {
        id: b.id,
        name: b.name,
        chain: b.chain,
        creatorId: b.creator_id,
        performanceFeeBpsLocked: b.performance_fee_bps_locked,
        currentRecipe: v ? { performanceFeeBps: v.recipe.performanceFeeBps, assets: (v.recipe.assets ?? []).map((a) => ({ address: a.address, symbol: a.symbol })) } : null,
      };
    }),
    holdings: holdingRows.map((h) => ({ userId: h.user_id, bagId: h.bag_id, chain: h.chain, address: h.address, quantityRaw: h.quantity_raw })),
    assetTypes: new Map(assetRows.filter((a) => a.asset_type === 'stock' || a.asset_type === 'crypto').map((a) => [a.address.toLowerCase(), a.asset_type as 'stock' | 'crypto'])),
  };
}

export interface GateRun {
  report: CoverageReport | null;
  inventoryError: string | null;
  probe: Map<string, ProbeOutcome> | null;
  exitCode: 0 | 1 | 2;
}

/** The whole gate. `probe` absent = static coverage only. Never throws for data/probe problems: they become exit 2. */
export async function runFeeSaleCoverageGate(deps: {
  loadInventory: () => Promise<InventoryResult>;
  feeds: Record<string, string>;
  settlementTokenAddress: string;
  probe?: { getPrice: (asset: AssetIdentity) => Promise<AssetPrice>; policy: SalePricePolicy; now?: () => Date };
}): Promise<GateRun> {
  let inv: InventoryResult;
  try {
    inv = await deps.loadInventory();
  } catch (e) {
    inv = { ok: false, reason: `READ_FAILED (${(e as Error)?.name ?? 'error'})` };
  }
  if (!inv.ok) return { report: null, inventoryError: inv.reason, probe: null, exitCode: 2 };
  const report = buildFeeSaleCoverage({ ...inv.inventory, feeds: deps.feeds, settlementTokenAddress: deps.settlementTokenAddress });

  let probe: Map<string, ProbeOutcome> | null = null;
  if (deps.probe) {
    probe = new Map();
    for (const leg of requiredPricedLegs(report)) {
      let outcome: ProbeOutcome;
      try {
        const price = await deps.probe.getPrice({ chain: leg.chain as AssetIdentity['chain'], address: leg.address });
        outcome = classifyProbe({ decision: salePriceDeviationLimit(price, deps.probe.policy, deps.probe.now ? deps.probe.now() : new Date()) });
      } catch (e) {
        outcome = classifyProbe({ error: e });
      }
      probe.set(`${leg.chain}:${leg.address}`, outcome);
    }
  }
  return { report, inventoryError: null, probe, exitCode: gateExitCode(report, probe) };
}
