import { SupabaseClient } from '@supabase/supabase-js';
import { AssetIdentity, AssetType, AssetVerificationStatus, CanonicalAsset, ChainId } from '@/types/basket-protocol';
import {
  assetIdentityKey,
  normalizeAssetAddress,
  normalizeAssetIdentity,
} from '@/lib/domain/basket-protocol/asset-identity';

// -----------------------------------------------------------------------------
// Supabase-backed Asset Registry — the Phase 5 persistence layer for
// `CanonicalAsset` (types/basket-protocol.ts). Same conventions as
// `lib/server/bag-repo.ts`: server-only, called with the service-role
// client (`lib/supabase/server.ts`), row<->domain mappers. `unique(chain,
// address)` (supabase/schema.sql) is what makes "same asset → cannot
// register twice" a database guarantee rather than an application-level
// check alone — same pattern as `bags.slug unique`.
//
// ---------------------------- Security boundary -----------------------------
// Every write here (`registerAsset` / `setAssetStatus`) is meant to be
// reachable only from an admin/service-role code path (spec section 14 —
// "admin/service role ile registration yeterli"). There is no
// creator-facing route wired up to this file's write functions yet; when
// one is added, it MUST gate on an admin check the same way
// `bag-repo.ts`'s write functions are documented to require a
// creator-ownership check before being reached — this file trusts
// whatever it's given, exactly like `bag-repo.ts` trusts its caller.
// -----------------------------------------------------------------------------

interface AssetRow {
  id: string;
  chain: string;
  address: string;
  symbol: string;
  decimals: number;
  name: string;
  status: string;
  asset_type: string;
  current_multiplier: string | null;
  /** Absent until 0037_asset_logo_url.sql has run. */
  logo_url?: string | null;
  /** Absent until 0043_asset_route_status.sql has run. */
  route_status?: string | null;
  route_checked_at?: string | null;
  created_at: string;
  updated_at: string;
}

function fromRow(row: AssetRow): CanonicalAsset {
  return {
    id: row.id,
    chain: row.chain as ChainId,
    address: row.address,
    symbol: row.symbol,
    decimals: row.decimals,
    name: row.name,
    status: row.status as AssetVerificationStatus,
    assetType: row.asset_type as AssetType,
    currentMultiplier: row.current_multiplier ?? undefined,
    logoUrl: row.logo_url ?? undefined,
    routeStatus: row.route_status === 'ROUTABLE' || row.route_status === 'NO_ROUTE' ? row.route_status : undefined,
    routeCheckedAt: row.route_checked_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ----------------------------- Create -----------------------------------------

export interface RegisterAssetInput {
  chain: ChainId;
  address: string;
  symbol: string;
  decimals: number;
  name: string;
  /** No default on purpose — unlike `status` below, mis-tagging this silently would show a coin under the "Stocks" filter tab (or vice versa), so every importer must say explicitly which it's registering. */
  assetType: AssetType;
  /**
   * Defaults to VERIFIED — registration through this function IS the act
   * of the registry vouching for an asset (only an admin/service-role
   * caller reaches this at all, per the security boundary above). Pass
   * 'UNKNOWN' explicitly if a future flow wants to record an asset without
   * vouching for it yet.
   */
  status?: AssetVerificationStatus;
  /** See `CanonicalAsset.currentMultiplier` — pass through as-received (decimal string), never parsed to a JS number. Optional: most chains' assets don't have one. */
  currentMultiplier?: string;
  /** Already sanitized by the importer (`sanitizeLogoUrl`). Only written when set, so imports without logos keep working before 0037 has run. */
  logoUrl?: string;
}

export type RegisterAssetResult =
  | { ok: true; asset: CanonicalAsset }
  | { ok: false; error: 'DUPLICATE_ASSET'; message: string }
  | { ok: false; error: 'DB_ERROR'; message: string };

/** Registers a new canonical asset. Rejects (writes nothing) if `(chain, address)` is already registered — see the `unique(chain, address)` constraint in supabase/schema.sql. Address is normalized before insert, so registering `0xAbC...` after `0xabc...` is already registered correctly hits the same DUPLICATE_ASSET rejection rather than silently creating a second row for the same identity. */
export async function registerAsset(
  admin: SupabaseClient,
  input: RegisterAssetInput
): Promise<RegisterAssetResult> {
  const address = normalizeAssetAddress(input.chain, input.address);
  const now = new Date().toISOString();

  const { data, error } = await admin
    .from('assets')
    .insert({
      chain: input.chain,
      address,
      symbol: input.symbol,
      decimals: input.decimals,
      name: input.name,
      status: input.status ?? 'VERIFIED',
      asset_type: input.assetType,
      current_multiplier: input.currentMultiplier ?? null,
      ...(input.logoUrl ? { logo_url: input.logoUrl } : {}),
      created_at: now,
      updated_at: now,
    })
    .select()
    .single<AssetRow>();

  if (error) {
    // Postgres unique_violation — see `assets` unique(chain, address) in schema.sql.
    if (error.code === '23505') {
      return {
        ok: false,
        error: 'DUPLICATE_ASSET',
        message: `Asset ${input.chain}:${address} is already registered.`,
      };
    }
    return { ok: false, error: 'DB_ERROR', message: error.message };
  }

  return { ok: true, asset: fromRow(data) };
}

// ----------------------------- Read -----------------------------------------

export async function getAssetByIdentity(
  admin: SupabaseClient,
  identity: AssetIdentity
): Promise<CanonicalAsset | null> {
  const address = normalizeAssetAddress(identity.chain, identity.address);
  const { data, error } = await admin
    .from('assets')
    .select()
    .eq('chain', identity.chain)
    .eq('address', address)
    .maybeSingle<AssetRow>();
  if (error) throw new Error(error.message);
  return data ? fromRow(data) : null;
}

export interface ListAssetsOptions {
  status?: AssetVerificationStatus | AssetVerificationStatus[];
  chain?: ChainId;
  assetType?: AssetType;
  limit?: number;
}

export async function listAssets(admin: SupabaseClient, options: ListAssetsOptions = {}): Promise<CanonicalAsset[]> {
  let query = admin.from('assets').select().order('created_at', { ascending: false });

  if (options.status) {
    const statuses = Array.isArray(options.status) ? options.status : [options.status];
    query = query.in('status', statuses);
  }
  if (options.chain) {
    query = query.eq('chain', options.chain);
  }
  if (options.assetType) {
    query = query.eq('asset_type', options.assetType);
  }
  // Callers treat the result as the whole registry (stock-token guard, input
  // asset lookup), so the default must exceed its size — it passed 200 once
  // crypto on four chains joined the 195 Robinhood Stock Tokens.
  query = query.limit(options.limit ?? 5000);

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data ?? []).map((row: AssetRow) => fromRow(row));
}

/**
 * Builds the `verifiedIdentityKeys` set that
 * `validateRecipeAssetsAgainstRegistry()`
 * (lib/domain/basket-protocol/validation/registry-validation.ts) needs,
 * scoped to just the identities a specific recipe references — never a
 * full-table scan, so this stays cheap regardless of registry size. Only
 * VERIFIED assets are ever included, so an asset the registry has marked
 * UNKNOWN or DEPRECATED correctly still fails registry validation.
 *
 * Filters on the exact `(chain, address)` PAIRS requested, not on `chain`
 * and `address` independently. `.in('chain', chains).in('address',
 * addresses)` would match any row whose chain is in the requested chain
 * set AND whose address is in the requested address set — e.g. asking for
 * (base, A) and (ethereum, B) would also match a registered (base, B) or
 * (ethereum, A), neither of which was ever asked for. An `.or()` of
 * per-identity `and(chain.eq.X,address.eq.Y)` clauses keeps each pair
 * intact instead.
 */
export async function getVerifiedIdentityKeys(
  admin: SupabaseClient,
  identities: AssetIdentity[]
): Promise<Set<string>> {
  if (identities.length === 0) return new Set();

  // De-duplicate normalized identities first — each becomes one
  // `and(chain.eq.X,address.eq.Y)` clause below.
  const normalized = Array.from(
    new Map(identities.map((i) => [assetIdentityKey(i), normalizeAssetIdentity(i)])).values()
  );

  const orFilter = normalized.map((i) => `and(chain.eq.${i.chain},address.eq.${i.address})`).join(',');

  const { data, error } = await admin.from('assets').select().or(orFilter).eq('status', 'VERIFIED');
  if (error) throw new Error(error.message);

  const rows = (data ?? []) as AssetRow[];
  return new Set(rows.map((row) => assetIdentityKey({ chain: row.chain as ChainId, address: row.address })));
}

/**
 * Registry rows for the exact `(chain, address)` pairs asked for, any
 * status — used to show what a Bag's assets ARE (type, logo), not to decide
 * whether they may be traded (that stays `getVerifiedIdentityKeys`).
 */
export async function getAssetsByIdentities(
  admin: SupabaseClient,
  identities: AssetIdentity[]
): Promise<CanonicalAsset[]> {
  const normalized = Array.from(
    new Map(identities.map((i) => [assetIdentityKey(i), normalizeAssetIdentity(i)])).values()
  );
  if (normalized.length === 0) return [];

  const orFilter = normalized.map((i) => `and(chain.eq.${i.chain},address.eq.${i.address})`).join(',');
  const { data, error } = await admin.from('assets').select().or(orFilter);
  if (error) throw new Error(error.message);
  return ((data ?? []) as AssetRow[]).map(fromRow);
}

// ----------------------------- Update -----------------------------------------

/** Updates only `status` (UNKNOWN / VERIFIED / DEPRECATED) — admin action, same narrow-function-per-trust-boundary pattern as `bag-repo.ts`'s `setProtocolDeployment()`. */
export async function setAssetStatus(
  admin: SupabaseClient,
  id: string,
  status: AssetVerificationStatus
): Promise<CanonicalAsset> {
  const { data, error } = await admin
    .from('assets')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single<AssetRow>();
  if (error) throw new Error(error.message);
  return fromRow(data);
}

/** Updates only `logo_url` — same admin-only trust boundary as `setAssetStatus`. */
export async function updateAssetLogoUrl(admin: SupabaseClient, id: string, logoUrl: string): Promise<CanonicalAsset> {
  const { data, error } = await admin
    .from('assets')
    .update({ logo_url: logoUrl, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single<AssetRow>();
  if (error) throw new Error(error.message);
  return fromRow(data);
}

/**
 * Phase 16 — updates only `current_multiplier` on an already-registered
 * asset. Added for the gap `robinhood-import.ts`'s Phase 15 module doc
 * flagged: `planRobinhoodImport()`'s `alreadyRegistered` bucket compares
 * remote vs. local by `(chain, address)` identity only, so a Stock Token
 * whose `currentMultiplier` changes on the remote feed (a split/reverse
 * split) — but keeps the same contract — was silently never synced. This
 * is the narrow admin-write half of that fix (same trust boundary as
 * `setAssetStatus` above: never called from a non-admin path); the other
 * half, deciding WHICH assets need it, lives in
 * `planMultiplierSync()`/`RobinhoodImportPlan.multiplierUpdates` in
 * robinhood-import.ts, not here. Pass-through, decimal-string only — same
 * "never parsed to a JS number" rule as `RegisterAssetInput.currentMultiplier`.
 * Idempotent: re-applying the same value is a harmless no-op update.
 */
export async function updateAssetMultiplier(
  admin: SupabaseClient,
  id: string,
  currentMultiplier: string
): Promise<CanonicalAsset> {
  const { data, error } = await admin
    .from('assets')
    .update({ current_multiplier: currentMultiplier, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single<AssetRow>();
  if (error) throw new Error(error.message);
  return fromRow(data);
}

/** Records a background liquidity check (0043). Admin-only, same trust boundary as the other writers here. */
export async function updateAssetRouteStatus(admin: SupabaseClient, id: string, status: 'ROUTABLE' | 'NO_ROUTE'): Promise<void> {
  const { error } = await admin
    .from('assets')
    .update({ route_status: status, route_checked_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw new Error(error.message);
}
