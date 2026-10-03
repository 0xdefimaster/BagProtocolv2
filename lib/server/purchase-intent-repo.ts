import { SupabaseClient } from '@supabase/supabase-js';
import { AssetIdentity, ChainId } from '@/types/basket-protocol';
import { PurchaseIntent, PurchaseIntentFailureCode, PurchaseIntentFallback, PurchaseIntentStatus, PurchaseIntentStepRecord } from '@/types/purchase-intent';
import type { ExecutionMode } from '@/lib/execution/types';
import { assertValidPurchaseIntentTransition } from '@/lib/domain/basket-protocol/purchase-intent/state-machine';

// -----------------------------------------------------------------------------
// Phase 17 — Supabase-backed persistence for `PurchaseIntent`
// (`purchase_intents` table, supabase/migrations/0004_add_purchase_intents.sql).
// Same conventions as every other *-repo.ts file: server-only, called with
// the service-role client, row<->domain mappers.
//
// ---------------------------- Security boundary -----------------------------
// This file CANNOT enforce "this intent belongs to this session" itself —
// it's called with the service-role client, which bypasses RLS entirely.
// Every read/write MUST be reached only through a route handler that has
// already called `requireSession()` and checked `intent.userId ===
// session.userId` — `getPurchaseIntentForUser()` below does that check
// in one place so route handlers don't each reimplement it, but the
// underlying `getPurchaseIntentById()` (no ownership check) is exported
// only for the one caller that legitimately needs it (a future admin/
// support tool) — no route handler should call it directly.
//
// ---------------------------- Transition enforcement -------------------------
// `updatePurchaseIntentStatus()` is the ONLY function in this file that
// changes `status` (spec Aşama 2: "Invalid transition engellensin") — it
// calls `assertValidPurchaseIntentTransition()` before writing, so an
// invalid transition throws before any row is touched, never silently
// clamped or ignored.
// -----------------------------------------------------------------------------

interface PurchaseIntentRow {
  id: string;
  user_id: string;
  wallet_address: string;
  bag_id: string;
  input_asset_chain: string;
  input_asset_address: string;
  input_amount_raw: string;
  shares_raw: string;
  share_decimals: number;
  route_fingerprint: string;
  recipe_version: number;
  composition_hash: string;
  nav_gross: string;
  nav_quote_currency: string;
  nav_as_of: string;
  share_price_at_quote: string | null;
  deposit_amount: string;
  steps: PurchaseIntentStepRecord[];
  composer_transaction: { to: string; data: string; value: string; chainId: number; userProxy: string } | null;
  bag_router_transaction: { to: string; data: string; value: string; chainId: number; inputToken: string; inputAmountRaw: string; bagOnChainId: string } | null;
  provider_id: string | null;
  execution_plan_hash: string | null;
  execution_mode: ExecutionMode | null;
  fallback?: PurchaseIntentFallback | null;
  status: PurchaseIntentStatus;
  failure_code: PurchaseIntentFailureCode | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
  executed_at: string | null;
  accounting_applied_at: string | null;
  reconciliation_applied_at: string | null;
}

function fromRow(row: PurchaseIntentRow): PurchaseIntent {
  return {
    id: row.id,
    userId: row.user_id,
    walletAddress: row.wallet_address,
    bagId: row.bag_id,
    inputAsset: { chain: row.input_asset_chain as ChainId, address: row.input_asset_address },
    inputAmountRaw: row.input_amount_raw,
    sharesRaw: row.shares_raw,
    shareDecimals: row.share_decimals,
    routeFingerprint: row.route_fingerprint,
    recipeVersion: row.recipe_version,
    compositionHash: row.composition_hash,
    navSnapshot: { grossNav: row.nav_gross, quoteCurrency: row.nav_quote_currency, asOf: row.nav_as_of },
    sharePriceAtQuote: row.share_price_at_quote,
    depositAmount: row.deposit_amount,
    steps: row.steps,
    composerTransaction: row.composer_transaction,
    bagRouterTransaction: row.bag_router_transaction,
    providerId: row.provider_id,
    executionPlanHash: row.execution_plan_hash,
    executionMode: row.execution_mode,
    fallback: row.fallback ?? null,
    status: row.status,
    failureCode: row.failure_code,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    executedAt: row.executed_at,
    accountingAppliedAt: row.accounting_applied_at,
    reconciliationAppliedAt: row.reconciliation_applied_at,
  };
}

export interface CreatePurchaseIntentInput {
  userId: string;
  walletAddress: string;
  bagId: string;
  inputAsset: AssetIdentity;
  inputAmountRaw: string;
  sharesRaw: string;
  shareDecimals: number;
  routeFingerprint: string;
  recipeVersion: number;
  compositionHash: string;
  navSnapshot: { grossNav: string; quoteCurrency: string; asOf: string };
  sharePriceAtQuote: string | null;
  depositAmount: string;
  steps: PurchaseIntentStepRecord[];
  composerTransaction: { to: string; data: string; value: string; chainId: number; userProxy: string } | null;
  /** See `PurchaseIntent.bagRouterTransaction`'s own doc — `null` for a legacy (flag-off) intent creation or any intent not compiled by `bag-router`. */
  bagRouterTransaction: { to: string; data: string; value: string; chainId: number; inputToken: string; inputAmountRaw: string; bagOnChainId: string } | null;
  /** See `PurchaseIntent.providerId`'s own doc — `null` for a legacy (flag-off) intent creation. */
  providerId: string | null;
  /** See `PurchaseIntent.executionPlanHash`'s own doc — `null` for a legacy (flag-off) intent creation. */
  executionPlanHash: string | null;
  /** See `PurchaseIntent.executionMode`'s own doc — `null` for a legacy (flag-off) intent creation. */
  executionMode: ExecutionMode | null;
  /** See `PurchaseIntent.fallback` — omitted/null when every asset was routable. */
  fallback?: PurchaseIntentFallback | null;
  status: PurchaseIntentStatus;
  failureCode: PurchaseIntentFailureCode | null;
  expiresAt: string;
}

/** Inserts a new PurchaseIntent row. `status` is whatever the caller already validated as the initial state (`DRAFT` normally reaches this as `QUOTED`/`READY`/`FAILED` depending on whether real quoting succeeded — see lib/server/purchase-execution.ts) — insert itself does no transition check, since there is no prior status to transition FROM. */
export async function createPurchaseIntent(admin: SupabaseClient, input: CreatePurchaseIntentInput): Promise<PurchaseIntent> {
  const { data, error } = await admin
    .from('purchase_intents')
    .insert({
      user_id: input.userId,
      wallet_address: input.walletAddress,
      bag_id: input.bagId,
      input_asset_chain: input.inputAsset.chain,
      input_asset_address: input.inputAsset.address,
      input_amount_raw: input.inputAmountRaw,
      shares_raw: input.sharesRaw,
      share_decimals: input.shareDecimals,
      route_fingerprint: input.routeFingerprint,
      recipe_version: input.recipeVersion,
      composition_hash: input.compositionHash,
      nav_gross: input.navSnapshot.grossNav,
      nav_quote_currency: input.navSnapshot.quoteCurrency,
      nav_as_of: input.navSnapshot.asOf,
      share_price_at_quote: input.sharePriceAtQuote,
      deposit_amount: input.depositAmount,
      steps: input.steps,
      composer_transaction: input.composerTransaction,
      bag_router_transaction: input.bagRouterTransaction,
      provider_id: input.providerId,
      execution_plan_hash: input.executionPlanHash,
      execution_mode: input.executionMode,
      // Only sent when set, so a deployment that hasn't run migration 0041
      // keeps working for every fully-routable purchase.
      ...(input.fallback ? { fallback: input.fallback } : {}),
      status: input.status,
      failure_code: input.failureCode,
      expires_at: input.expiresAt,
    })
    .select()
    .single<PurchaseIntentRow>();

  if (error) throw new Error(error.message);
  return fromRow(data);
}

export async function getPurchaseIntentById(admin: SupabaseClient, id: string): Promise<PurchaseIntent | null> {
  const { data, error } = await admin.from('purchase_intents').select().eq('id', id).maybeSingle<PurchaseIntentRow>();
  if (error) throw new Error(error.message);
  return data ? fromRow(data) : null;
}

export type PurchaseIntentAccessError = 'NOT_FOUND' | 'FORBIDDEN';

/** The one function route handlers should call to read a specific user's intent — folds the "does it exist" and "does it belong to this session" checks into a single typed result so a caller can't accidentally skip the ownership check (spec Aşama 12: "user başka user'ın PurchaseIntent'ini execute edemiyor"). */
export async function getPurchaseIntentForUser(
  admin: SupabaseClient,
  id: string,
  userId: string
): Promise<{ ok: true; intent: PurchaseIntent } | { ok: false; error: PurchaseIntentAccessError }> {
  const intent = await getPurchaseIntentById(admin, id);
  if (!intent) return { ok: false, error: 'NOT_FOUND' };
  if (intent.userId !== userId) return { ok: false, error: 'FORBIDDEN' };
  return { ok: true, intent };
}

/** Finds any of this user's intents for this bag that are still "in flight" (not yet terminal) — used to reject opening a second concurrent purchase intent for the same (user, bag) while one is already mid-execution. */
export async function findActivePurchaseIntentForBag(
  admin: SupabaseClient,
  userId: string,
  bagId: string
): Promise<PurchaseIntent | null> {
  const { data, error } = await admin
    .from('purchase_intents')
    .select()
    .eq('user_id', userId)
    .eq('bag_id', bagId)
    .in('status', ['DRAFT', 'QUOTED', 'READY', 'AWAITING_SIGNATURE', 'SUBMITTED', 'CONFIRMING'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle<PurchaseIntentRow>();
  if (error) throw new Error(error.message);
  return data ? fromRow(data) : null;
}

export interface UpdatePurchaseIntentStatusInput {
  id: string;
  from: PurchaseIntentStatus;
  to: PurchaseIntentStatus;
  failureCode?: PurchaseIntentFailureCode | null;
  steps?: PurchaseIntentStepRecord[];
  executedAt?: string | null;
}

/**
 * The ONLY function that changes `purchase_intents.status`. Enforces the
 * transition (throws `InvalidPurchaseIntentTransitionError` before writing
 * anything if `from -> to` isn't allowed — spec Aşama 2), and additionally
 * guards against a lost-update race with `.eq('status', input.from)`: if
 * two requests race to advance the same intent, only the first one whose
 * WHERE clause still matches the row's current status actually updates it
 * — the second gets zero affected rows back (`data` empty) rather than
 * silently overwriting a status another request already moved past. This
 * is the same idempotency guarantee spec Aşama 9 asks for at the row level,
 * beneath whatever the route handler's own idempotency check already does.
 */
export async function updatePurchaseIntentStatus(
  admin: SupabaseClient,
  input: UpdatePurchaseIntentStatusInput
): Promise<PurchaseIntent | null> {
  assertValidPurchaseIntentTransition(input.from, input.to);

  const patch: Record<string, unknown> = {
    status: input.to,
    updated_at: new Date().toISOString(),
  };
  if (input.failureCode !== undefined) patch.failure_code = input.failureCode;
  if (input.steps !== undefined) patch.steps = input.steps;
  if (input.executedAt !== undefined) patch.executed_at = input.executedAt;

  const { data, error } = await admin
    .from('purchase_intents')
    .update(patch)
    .eq('id', input.id)
    .eq('status', input.from)
    .select()
    .maybeSingle<PurchaseIntentRow>();

  if (error) throw new Error(error.message);
  return data ? fromRow(data) : null;
}

/** Updates only `steps` (no status change) — used for per-step progress (approval submitted, tx hash recorded) that doesn't itself move the intent's overall status. Still goes through the same `.eq('status', expectedStatus)` race guard as `updatePurchaseIntentStatus()`. */
export async function updatePurchaseIntentSteps(
  admin: SupabaseClient,
  id: string,
  expectedStatus: PurchaseIntentStatus,
  steps: PurchaseIntentStepRecord[]
): Promise<PurchaseIntent | null> {
  const { data, error } = await admin
    .from('purchase_intents')
    .update({ steps, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('status', expectedStatus)
    .select()
    .maybeSingle<PurchaseIntentRow>();

  if (error) throw new Error(error.message);
  return data ? fromRow(data) : null;
}

/** Marks accounting as applied — idempotency guard for spec Aşama 11. Only ever set once per intent; the caller (purchase-execution.ts) checks `accountingAppliedAt === null` BEFORE calling this and before calling `apply_purchase_execution()`, so this is belt-and-suspenders against a retried/racing verify call, not the only guard. */
export async function markAccountingApplied(admin: SupabaseClient, id: string): Promise<void> {
  const { error } = await admin
    .from('purchase_intents')
    .update({ accounting_applied_at: new Date().toISOString() })
    .eq('id', id)
    .is('accounting_applied_at', null);
  if (error) throw new Error(error.message);
}

/** Phase 18 — same belt-and-suspenders role as `markAccountingApplied()` above, for the PARTIAL_SUCCESS/RECONCILIATION_REQUIRED path: `apply_partial_purchase_execution()` is the actual idempotency guard (row-locked, checks+sets `reconciliation_applied_at` itself); this just keeps the in-process record consistent without a second round trip. */
export async function markReconciliationApplied(admin: SupabaseClient, id: string): Promise<void> {
  const { error } = await admin
    .from('purchase_intents')
    .update({ reconciliation_applied_at: new Date().toISOString() })
    .eq('id', id)
    .is('reconciliation_applied_at', null);
  if (error) throw new Error(error.message);
}
