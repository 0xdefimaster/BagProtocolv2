import { SupabaseClient } from '@supabase/supabase-js';
import { BagRecord, BagStatus, BagVersionRecord, BasketRecipe, ValidationIssue } from '@/types/basket-protocol';
import { validateBasketRecipe } from '@/lib/domain/basket-protocol/validation';
import { computeCompositionHash, compositionsAreEqual } from '@/lib/domain/basket-protocol/version';

// -----------------------------------------------------------------------------
// Supabase-backed Bag registry — the Phase 3 persistence layer sitting
// underneath the mock `Bag`s in `lib/mock-data.ts`. Same shape/conventions
// as `lib/server/trading-repo.ts`: server-only, called with the
// service-role client (`lib/supabase/server.ts`), row<->domain mappers.
//
// `validateBasketRecipe()` (Phase 2) is the ONLY place recipe validation
// logic lives — this file never re-implements a single rule, it just
// decides what to do with an ERROR-containing result (reject, don't write).
//
// ---------------------------- Security boundary -----------------------------
//
// This is a deliberate, not accidental, split — matching how
// `app/api/trades` already trusts `requireSession()` rather than any
// client-supplied id:
//
//   PUBLIC (no session)
//     -> may SELECT bags where status = 'ACTIVE', either through the
//        `bags` RLS policy directly (anon key, `lib/supabase/browser.ts`)
//        or a future unauthenticated GET /api/bags route. Never sees
//        DRAFT/ARCHIVED rows either way.
//
//   CREATOR (owns the bag)
//     -> may call updateBagMetadata() / updateBagStatus() /
//        createBagVersion() for their own bag.
//
//   ANY OTHER AUTHENTICATED USER
//     -> must be rejected before reaching this file.
//
// This module CANNOT enforce "creator vs. other user" itself: it is called
// with the service-role client, which bypasses RLS entirely (same reason
// `trading-repo.ts` bypasses RLS for portfolios/trades). There is currently
// no `/api/bags/*` route wired up yet (Phase 3 is repository-only, per
// spec section 11/12) — so there is nothing to audit at that layer today.
// But whichever route calls updateBagMetadata()/updateBagStatus()/
// createBagVersion()/archiveBag() in Phase 4+ MUST, before calling any of
// them:
//   1. call requireSession() (lib/auth/require-session.ts),
//   2. load the bag via getBagById()/getBagBySlug(),
//   3. reject with 403 if session.userId !== bag.creatorId.
// This file trusts whatever id it's given — exactly like `trading-repo.ts`
// trusts the userId its caller already authenticated. That trust is only
// safe because the only caller with access to this file is server code
// that has already done the check above; nothing in this file should ever
// be reachable directly from a client request body.
// -----------------------------------------------------------------------------

interface BagRow {
  id: string;
  slug: string;
  name: string;
  symbol: string;
  description: string;
  creator_id: string;
  chain: string;
  strategy_type: string;
  mutability: string;
  status: string;
  current_version: number;
  current_version_id: string | null;
  registry_id: string | null;
  contract_address: string | null;
  parent_bag_id: string | null;
  root_bag_id: string | null;
  performance_fee_locked_at?: string | null;
  performance_fee_bps_locked?: number | null;
  created_at: string;
  updated_at: string;
}

interface BagVersionRow {
  id: string;
  bag_id: string;
  version: number;
  composition_hash: string;
  recipe: BasketRecipe;
  created_by: string;
  reason: string;
  created_at: string;
}

function bagFromRow(row: BagRow): BagRecord {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    symbol: row.symbol,
    description: row.description,
    creatorId: row.creator_id,
    chain: row.chain as BagRecord['chain'],
    // Row-level fallback mirrors the same default used everywhere else
    // (recipe.ts, bag-mapper.ts) — belt-and-suspenders in case a row was
    // ever written before the `not null default` migration landed.
    strategyType: (row.strategy_type as BagRecord['strategyType']) ?? 'STATIC_BASKET',
    mutability: row.mutability as BagRecord['mutability'],
    status: row.status as BagStatus,
    currentVersion: row.current_version,
    currentVersionId: row.current_version_id,
    registryId: row.registry_id,
    contractAddress: row.contract_address,
    parentBagId: row.parent_bag_id,
    rootBagId: row.root_bag_id,
    performanceFeeLockedAt: row.performance_fee_locked_at ?? null,
    performanceFeeBpsLocked: row.performance_fee_bps_locked ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function versionFromRow(row: BagVersionRow): BagVersionRecord {
  return {
    id: row.id,
    bagId: row.bag_id,
    version: row.version,
    compositionHash: row.composition_hash,
    recipe: row.recipe,
    createdBy: row.created_by,
    reason: row.reason,
    createdAt: row.created_at,
  };
}

// ----------------------------- Create -----------------------------------------

export interface CreateBagInput {
  slug: string;
  creatorId: string;
  mutability: BagRecord['mutability'];
  status?: BagStatus;
  /** Everything the initial `BasketRecipe` needs except identity fields the repo assigns itself (`id`, `bagId`, `version`, `createdAt`). */
  recipe: Omit<BasketRecipe, 'id' | 'bagId' | 'version' | 'createdAt'>;
  reason: string;
}

/**
 * Fork lineage. Never taken from a request: `createForkBag()` derives it from a source Bag the caller
 * loaded server-side. Lineage is economic state, not display: `root_bag_id` decides who is paid the fork
 * royalty (purchase-execution.ts), so a client-chosen value would let anyone pick the royalty recipient.
 * The database enforces the same rule at insert and keeps lineage immutable (0046_bag_lineage_integrity.sql).
 */
export interface ForkLineage {
  parentBagId: string;
  rootBagId: string;
}

/** The lineage a fork of `source` must have: parent = the source, root = the source's root (or the source itself). */
export function forkLineageOf(source: Pick<BagRecord, 'id' | 'rootBagId'>): ForkLineage {
  return { parentBagId: source.id, rootBagId: source.rootBagId ?? source.id };
}

export type CreateBagResult =
  | { ok: true; bag: BagRecord; version: BagVersionRecord }
  | { ok: false; error: 'VALIDATION_FAILED'; issues: ValidationIssue[] }
  | { ok: false; error: 'DUPLICATE_SLUG'; message: string }
  | { ok: false; error: 'DB_ERROR'; message: string };

/**
 * Creates a Bag and its initial (v1) version atomically — see
 * `create_bag_with_initial_version` in supabase/schema.sql. Rejects and
 * writes nothing if `validateBasketRecipe()` reports any ERROR-severity
 * issue; WARNINGs are returned to the caller for display but don't block
 * creation, matching Phase 2's error/warning split.
 */
export async function createBag(admin: SupabaseClient, input: CreateBagInput): Promise<CreateBagResult> {
  return insertBag(admin, input, null);
}

/** Creates a fork of `source` (a Bag the caller loaded server-side). Same validation as `createBag()`; lineage comes only from `source`. */
export async function createForkBag(admin: SupabaseClient, input: CreateBagInput, source: Pick<BagRecord, 'id' | 'rootBagId'>): Promise<CreateBagResult> {
  return insertBag(admin, input, forkLineageOf(source));
}

async function insertBag(admin: SupabaseClient, input: CreateBagInput, lineage: ForkLineage | null): Promise<CreateBagResult> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const recipe: BasketRecipe = {
    ...input.recipe,
    id: `recipe_${id}_v1`,
    bagId: id,
    version: 1,
    createdAt: now,
  };

  const validation = validateBasketRecipe(recipe);
  const errors = validation.issues.filter((i) => i.severity === 'ERROR');
  if (errors.length > 0) {
    return { ok: false, error: 'VALIDATION_FAILED', issues: validation.issues };
  }

  const compositionHash = computeCompositionHash(recipe.assets);

  const { data, error } = await admin.rpc('create_bag_with_initial_version', {
    p_id: id,
    p_slug: input.slug,
    p_name: recipe.name,
    p_symbol: recipe.symbol,
    p_description: recipe.description,
    p_creator_id: input.creatorId,
    p_chain: recipe.chain,
    p_strategy_type: recipe.strategyType,
    p_mutability: input.mutability,
    p_status: input.status ?? 'DRAFT',
    p_recipe: recipe,
    p_composition_hash: compositionHash,
    p_reason: input.reason,
    p_parent_bag_id: lineage?.parentBagId ?? null,
    p_root_bag_id: lineage?.rootBagId ?? null,
  });

  if (error) {
    // Postgres unique_violation — see `bags.slug unique` in schema.sql.
    if (error.code === '23505') {
      return { ok: false, error: 'DUPLICATE_SLUG', message: `Slug "${input.slug}" is already taken.` };
    }
    return { ok: false, error: 'DB_ERROR', message: error.message };
  }

  const result = data as { bag: BagRow; version: BagVersionRow };
  return { ok: true, bag: bagFromRow(result.bag), version: versionFromRow(result.version) };
}

// ----------------------------- Read -----------------------------------------

export async function getBagById(admin: SupabaseClient, id: string): Promise<BagRecord | null> {
  const { data, error } = await admin.from('bags').select().eq('id', id).maybeSingle<BagRow>();
  if (error) throw new Error(error.message);
  return data ? bagFromRow(data) : null;
}

export async function getBagBySlug(admin: SupabaseClient, slug: string): Promise<BagRecord | null> {
  const { data, error } = await admin.from('bags').select().eq('slug', slug).maybeSingle<BagRow>();
  if (error) throw new Error(error.message);
  return data ? bagFromRow(data) : null;
}

/**
 * How many DRAFT (never deployed) Bags this creator made since `sinceIso`.
 * Drafts cost nothing to create, so POST /api/bags and the fork route cap
 * them per wallet (see MAX_RECENT_DRAFTS) — a Bag only becomes public once
 * its creator pays the on-chain creation fee to deploy it.
 */
export async function countRecentDraftBags(admin: SupabaseClient, creatorId: string, sinceIso: string): Promise<number> {
  const { count, error } = await admin
    .from('bags')
    .select('id', { count: 'exact', head: true })
    .eq('creator_id', creatorId)
    .eq('status', 'DRAFT')
    .gte('created_at', sinceIso);
  if (error) throw new Error(error.message);
  return count ?? 0;
}

/** Undeployed drafts a wallet may create per rolling 24h (older abandoned drafts stop counting). */
export const MAX_RECENT_DRAFTS = 5;
export const DRAFT_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface ListBagsOptions {
  /** Defaults to `['ACTIVE']` when neither `status` nor `creatorId` is given — i.e. public/Explore semantics by default. */
  status?: BagStatus | BagStatus[];
  /** Owner viewing their own bags — when set without `status`, all statuses are returned (a creator sees their own drafts/archived bags). */
  creatorId?: string;
  limit?: number;
}

export async function listBags(admin: SupabaseClient, options: ListBagsOptions = {}): Promise<BagRecord[]> {
  let query = admin.from('bags').select().order('created_at', { ascending: false });

  if (options.status) {
    const statuses = Array.isArray(options.status) ? options.status : [options.status];
    query = query.in('status', statuses);
  } else if (!options.creatorId) {
    // No explicit status filter and no creator scoping: this is a public
    // listing (Explore) — default to ACTIVE only, mirroring the `bags`
    // public-read RLS policy so app-level behavior matches what an
    // unauthenticated direct read would also return.
    query = query.eq('status', 'ACTIVE');
  }

  if (options.creatorId) {
    query = query.eq('creator_id', options.creatorId);
  }

  query = query.limit(options.limit ?? 100);

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data ?? []).map((row: BagRow) => bagFromRow(row));
}

// ----------------------------- Update -----------------------------------------
//
// Deliberately THREE separate functions, not one generic patch — they are
// not the same security boundary. Creator metadata is something the bag's
// owner should be able to edit freely (once the ownership check above is in
// place); protocol deployment identity (`registryId`/`contractAddress`) is
// something only a Phase 4+ deployment pipeline should ever be able to
// write, and must never be reachable from a creator-facing "edit my bag"
// route. Splitting the type signature is what makes that mistake
// impossible to make by accident, without adding runtime ownership logic
// this file can't actually enforce (see the security boundary note above).

async function patchBagRow(admin: SupabaseClient, id: string, row: Record<string, unknown>): Promise<BagRecord> {
  const { data, error } = await admin
    .from('bags')
    .update({ ...row, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single<BagRow>();
  if (error) throw new Error(error.message);
  return bagFromRow(data);
}

export interface UpdateBagMetadataPatch {
  name?: string;
  symbol?: string;
  description?: string;
}

/** Creator-editable display fields only. Never touches `status`, `registryId`, `contractAddress`, or composition/version — use `updateBagStatus()`, `setProtocolDeployment()`, or `createBagVersion()` for those. */
export async function updateBagMetadata(
  admin: SupabaseClient,
  id: string,
  patch: UpdateBagMetadataPatch
): Promise<BagRecord> {
  const row: Record<string, unknown> = {};
  if (patch.name !== undefined) row.name = patch.name;
  if (patch.symbol !== undefined) row.symbol = patch.symbol;
  if (patch.description !== undefined) row.description = patch.description;
  return patchBagRow(admin, id, row);
}

/** Bag lifecycle transition (DRAFT / ACTIVE / ARCHIVED). Same creator-ownership trust contract as `updateBagMetadata()` — see the security boundary note above. */
export async function updateBagStatus(admin: SupabaseClient, id: string, status: BagStatus): Promise<BagRecord> {
  return patchBagRow(admin, id, { status });
}

export async function archiveBag(admin: SupabaseClient, id: string): Promise<BagRecord> {
  return updateBagStatus(admin, id, 'ARCHIVED');
}

export interface ProtocolDeployment {
  registryId?: string;
  contractAddress?: string;
}

/**
 * Populates the on-chain identity of an already-created Bag once it has
 * been deployed. NOT part of the Phase 3 scope to call yet — nothing
 * deploys anything on-chain until the Bag Factory (Phase 4+). Kept as a
 * separate, narrowly-typed function now specifically so that whichever
 * route calls `updateBagMetadata()` for a creator's "edit my bag" form can
 * never accidentally also let them set their own `contractAddress` — the
 * two are different trust levels even though they'd otherwise be "just
 * more columns on the same row". Only a server-side deployment pipeline
 * (itself never triggered directly by a client request) should call this.
 */
export async function setProtocolDeployment(
  admin: SupabaseClient,
  id: string,
  deployment: ProtocolDeployment
): Promise<BagRecord> {
  const row: Record<string, unknown> = {};
  if (deployment.registryId !== undefined) row.registry_id = deployment.registryId;
  if (deployment.contractAddress !== undefined) row.contract_address = deployment.contractAddress;
  return patchBagRow(admin, id, row);
}

// ----------------------------- Versions -----------------------------------------

export interface CreateBagVersionInput {
  bagId: string;
  /** Full recipe for the new version — `id`/`bagId`/`version`/`createdAt` are re-stamped by the repo, same as `createBag()`. */
  recipe: Omit<BasketRecipe, 'id' | 'bagId' | 'version' | 'createdAt'>;
  createdBy: string;
  reason: string;
}

export type CreateBagVersionResult =
  | { ok: true; bag: BagRecord; version: BagVersionRecord }
  | { ok: false; error: 'VALIDATION_FAILED'; issues: ValidationIssue[] }
  | { ok: false; error: 'BAG_NOT_FOUND' }
  | { ok: false; error: 'BAG_ARCHIVED' }
  | { ok: false; error: 'IMMUTABLE_BAG' }
  | { ok: false; error: 'NO_COMPOSITION_CHANGE' }
  /** The Bag has an external investor, so its performance fee is immutable (migration 0033) and this version carries a different one. */
  | { ok: false; error: 'PERFORMANCE_FEE_LOCKED'; lockedBps: number }
  /** The Bag is deployed on-chain: its versions must be recorded on-chain first (lib/server/bag-versioning.ts, migration 0035). */
  | { ok: false; error: 'DEPLOYED_BAG_REQUIRES_ONCHAIN_VERSION' }
  | { ok: false; error: 'DB_ERROR'; message: string };

/**
 * Publishes a new composition version for an existing Bag. Rejects
 * (writes nothing) if: the bag doesn't exist, is archived, is IMMUTABLE
 * (spec section 9 — "composition cannot be changed after creation"), the
 * new composition validates with any ERROR, or the composition is
 * byte-for-byte identical to the current version (no point versioning a
 * no-op — see `compositionsAreEqual`).
 *
 * The version NUMBER is never decided here. `nextVersion` below is only a
 * local best-effort guess used to stamp this recipe payload's own `id`/
 * `version` fields before validation — under concurrent version creation
 * on the same bag, two callers could compute the same guess. The real
 * number is decided atomically inside `create_bag_version` (schema.sql),
 * which row-locks `bags` with `for update`, computes `current_version + 1`
 * itself, and overwrites `recipe.version`/`recipe.id` to match before
 * insert — so what's actually persisted is always correct even if this
 * function's guess wasn't. Trust `result.version.version` (and
 * `result.version.recipe`, which the DB already reconciled), not any
 * version number computed before this function called the RPC.
 */
export async function createBagVersion(
  admin: SupabaseClient,
  input: CreateBagVersionInput
): Promise<CreateBagVersionResult> {
  const bag = await getBagById(admin, input.bagId);
  if (!bag) return { ok: false, error: 'BAG_NOT_FOUND' };
  if (bag.status === 'ARCHIVED') return { ok: false, error: 'BAG_ARCHIVED' };
  if (bag.mutability === 'IMMUTABLE') return { ok: false, error: 'IMMUTABLE_BAG' };

  const optimisticNextVersion = bag.currentVersion + 1;
  const now = new Date().toISOString();
  const recipe: BasketRecipe = {
    ...input.recipe,
    id: `recipe_${bag.id}_v${optimisticNextVersion}`,
    bagId: bag.id,
    version: optimisticNextVersion,
    createdAt: now,
  };

  const validation = validateBasketRecipe(recipe);
  const errors = validation.issues.filter((i) => i.severity === 'ERROR');
  if (errors.length > 0) {
    return { ok: false, error: 'VALIDATION_FAILED', issues: validation.issues };
  }

  if (bag.currentVersionId) {
    // Best-effort no-op guard, not a hard uniqueness guarantee (unlike the
    // version number above, which the DB fully serializes) — under a tight
    // race between two *different* composition changes this read could be
    // stale, but the worst case is one extra (still valid, still correctly
    // numbered) version, never a data-integrity problem.
    const current = await getBagVersion(admin, bag.currentVersionId);
    // A fee-only change is a real change (allowed until the fee locks), so
    // "no-op" means same composition AND same fee.
    if (
      current &&
      compositionsAreEqual(current.recipe.assets, recipe.assets) &&
      (current.recipe.performanceFeeBps ?? 0) === (recipe.performanceFeeBps ?? 0)
    ) {
      return { ok: false, error: 'NO_COMPOSITION_CHANGE' };
    }
  }

  // Fast path only — the database triggers (0033) are what actually enforce this.
  const lockedBps = bag.performanceFeeBpsLocked ?? null;
  if (lockedBps !== null && (recipe.performanceFeeBps ?? 0) !== lockedBps) {
    return { ok: false, error: 'PERFORMANCE_FEE_LOCKED', lockedBps };
  }

  const compositionHash = computeCompositionHash(recipe.assets);

  const { data, error } = await admin.rpc('create_bag_version', {
    p_bag_id: bag.id,
    p_composition_hash: compositionHash,
    p_recipe: recipe,
    p_created_by: input.createdBy,
    p_reason: input.reason,
  });

  if (error) {
    // Lost a race with the first external purchase: the DB trigger is authoritative.
    if (error.message.includes('PERFORMANCE_FEE_LOCKED')) {
      const fresh = await getBagById(admin, bag.id);
      return { ok: false, error: 'PERFORMANCE_FEE_LOCKED', lockedBps: fresh?.performanceFeeBpsLocked ?? 0 };
    }
    if (error.message.includes('DEPLOYED_BAG_REQUIRES_ONCHAIN_VERSION')) return { ok: false, error: 'DEPLOYED_BAG_REQUIRES_ONCHAIN_VERSION' };
    if (error.message.includes('IMMUTABLE_BAG')) return { ok: false, error: 'IMMUTABLE_BAG' };
    return { ok: false, error: 'DB_ERROR', message: error.message };
  }

  const result = data as { bag: BagRow; version: BagVersionRow };
  return { ok: true, bag: bagFromRow(result.bag), version: versionFromRow(result.version) };
}

export async function getBagVersion(admin: SupabaseClient, versionId: string): Promise<BagVersionRecord | null> {
  const { data, error } = await admin.from('bag_versions').select().eq('id', versionId).maybeSingle<BagVersionRow>();
  if (error) throw new Error(error.message);
  return data ? versionFromRow(data) : null;
}

export async function getBagVersions(admin: SupabaseClient, bagId: string): Promise<BagVersionRecord[]> {
  const { data, error } = await admin
    .from('bag_versions')
    .select()
    .eq('bag_id', bagId)
    .order('version', { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []).map((row: BagVersionRow) => versionFromRow(row));
}

export async function getCurrentBagVersion(admin: SupabaseClient, bagId: string): Promise<BagVersionRecord | null> {
  const bag = await getBagById(admin, bagId);
  if (!bag || !bag.currentVersionId) return null;
  return getBagVersion(admin, bag.currentVersionId);
}
