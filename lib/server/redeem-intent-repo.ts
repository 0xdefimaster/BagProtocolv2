import { SupabaseClient } from '@supabase/supabase-js';
import { AssetIdentity, ChainId } from '@/types/basket-protocol';
import { RedeemIntent, RedeemIntentFailureCode, RedeemIntentStatus, RedeemIntentStepRecord } from '@/types/redeem-intent';
import { assertValidPurchaseIntentTransition } from '@/lib/domain/basket-protocol/purchase-intent/state-machine';

// -----------------------------------------------------------------------------
// Phase 21 — Supabase-backed persistence for `RedeemIntent`
// (`redeem_intents` table, supabase/migrations/0012_add_redeem_execution.sql).
// Structurally identical to purchase-intent-repo.ts (same security
// boundary, same transition-enforcement rule, same idempotency guards) —
// see that file's own module doc for the reasoning, which applies here
// unchanged. Reuses `assertValidPurchaseIntentTransition()` directly
// rather than a redeem-specific copy: `RedeemIntentStatus` IS
// `PurchaseIntentStatus` (types/redeem-intent.ts), so the same adjacency
// table already describes both lifecycles.
// -----------------------------------------------------------------------------

interface RedeemIntentRow {
  id: string;
  user_id: string;
  wallet_address: string;
  bag_id: string;
  shares_raw: string;
  share_decimals: number;
  output_asset_chain: string;
  output_asset_address: string;
  output_decimals: number;
  route_fingerprint: string;
  share_price_at_quote: string;
  redeem_value_quote: string;
  steps: RedeemIntentStepRecord[];
  status: RedeemIntentStatus;
  failure_code: RedeemIntentFailureCode | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
  executed_at: string | null;
  accounting_applied_at: string | null;
  reconciliation_applied_at: string | null;
}

function fromRow(row: RedeemIntentRow): RedeemIntent {
  return {
    id: row.id,
    userId: row.user_id,
    walletAddress: row.wallet_address,
    bagId: row.bag_id,
    sharesRaw: row.shares_raw,
    shareDecimals: row.share_decimals,
    outputAsset: { chain: row.output_asset_chain as ChainId, address: row.output_asset_address },
    outputDecimals: row.output_decimals,
    routeFingerprint: row.route_fingerprint,
    sharePriceAtQuote: row.share_price_at_quote,
    redeemValueQuote: row.redeem_value_quote,
    steps: row.steps,
    status: row.status,
    failureCode: row.failure_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
    executedAt: row.executed_at,
    accountingAppliedAt: row.accounting_applied_at,
    reconciliationAppliedAt: row.reconciliation_applied_at,
  };
}

export interface CreateRedeemIntentInput {
  userId: string;
  walletAddress: string;
  bagId: string;
  sharesRaw: string;
  shareDecimals: number;
  outputAsset: AssetIdentity;
  outputDecimals: number;
  routeFingerprint: string;
  sharePriceAtQuote: string;
  redeemValueQuote: string;
  steps: RedeemIntentStepRecord[];
  status: RedeemIntentStatus;
  failureCode: RedeemIntentFailureCode | null;
  expiresAt: string;
}

/** Inserts a new RedeemIntent row — no transition check, same reasoning `createPurchaseIntent()` documents (there is no prior status to transition FROM). */
export async function createRedeemIntent(admin: SupabaseClient, input: CreateRedeemIntentInput): Promise<RedeemIntent> {
  const { data, error } = await admin
    .from('redeem_intents')
    .insert({
      user_id: input.userId,
      wallet_address: input.walletAddress,
      bag_id: input.bagId,
      shares_raw: input.sharesRaw,
      share_decimals: input.shareDecimals,
      output_asset_chain: input.outputAsset.chain,
      output_asset_address: input.outputAsset.address,
      output_decimals: input.outputDecimals,
      route_fingerprint: input.routeFingerprint,
      share_price_at_quote: input.sharePriceAtQuote,
      redeem_value_quote: input.redeemValueQuote,
      steps: input.steps,
      status: input.status,
      failure_code: input.failureCode,
      expires_at: input.expiresAt,
    })
    .select()
    .single<RedeemIntentRow>();

  if (error) throw new Error(error.message);
  return fromRow(data);
}

export async function getRedeemIntentById(admin: SupabaseClient, id: string): Promise<RedeemIntent | null> {
  const { data, error } = await admin.from('redeem_intents').select().eq('id', id).maybeSingle<RedeemIntentRow>();
  if (error) throw new Error(error.message);
  return data ? fromRow(data) : null;
}

export type RedeemIntentAccessError = 'NOT_FOUND' | 'FORBIDDEN';

/** Same role as `getPurchaseIntentForUser()` — folds "exists" + "belongs to this session" into one typed result so a route handler can't skip the ownership check. */
export async function getRedeemIntentForUser(
  admin: SupabaseClient,
  id: string,
  userId: string
): Promise<{ ok: true; intent: RedeemIntent } | { ok: false; error: RedeemIntentAccessError }> {
  const intent = await getRedeemIntentById(admin, id);
  if (!intent) return { ok: false, error: 'NOT_FOUND' };
  if (intent.userId !== userId) return { ok: false, error: 'FORBIDDEN' };
  return { ok: true, intent };
}

/** Finds any non-terminal redeem intent this user already has open for this bag — same "don't let two redemptions race" guard `findActivePurchaseIntentForBag()` gives deposits. */
export async function findActiveRedeemIntentForBag(admin: SupabaseClient, userId: string, bagId: string): Promise<RedeemIntent | null> {
  const { data, error } = await admin
    .from('redeem_intents')
    .select()
    .eq('user_id', userId)
    .eq('bag_id', bagId)
    .in('status', ['DRAFT', 'QUOTED', 'READY', 'AWAITING_SIGNATURE', 'SUBMITTED', 'CONFIRMING'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle<RedeemIntentRow>();
  if (error) throw new Error(error.message);
  return data ? fromRow(data) : null;
}

export interface UpdateRedeemIntentStatusInput {
  id: string;
  from: RedeemIntentStatus;
  to: RedeemIntentStatus;
  failureCode?: RedeemIntentFailureCode | null;
  steps?: RedeemIntentStepRecord[];
  executedAt?: string | null;
}

/** The ONLY function that changes `redeem_intents.status` — same transition-enforcement + lost-update race guard (`.eq('status', input.from)`) as `updatePurchaseIntentStatus()`. */
export async function updateRedeemIntentStatus(admin: SupabaseClient, input: UpdateRedeemIntentStatusInput): Promise<RedeemIntent | null> {
  assertValidPurchaseIntentTransition(input.from, input.to);

  const patch: Record<string, unknown> = {
    status: input.to,
    updated_at: new Date().toISOString(),
  };
  if (input.failureCode !== undefined) patch.failure_code = input.failureCode;
  if (input.steps !== undefined) patch.steps = input.steps;
  if (input.executedAt !== undefined) patch.executed_at = input.executedAt;

  const { data, error } = await admin
    .from('redeem_intents')
    .update(patch)
    .eq('id', input.id)
    .eq('status', input.from)
    .select()
    .maybeSingle<RedeemIntentRow>();

  if (error) throw new Error(error.message);
  return data ? fromRow(data) : null;
}

/** Updates only `steps` — same race guard as `updatePurchaseIntentSteps()`. */
export async function updateRedeemIntentSteps(
  admin: SupabaseClient,
  id: string,
  expectedStatus: RedeemIntentStatus,
  steps: RedeemIntentStepRecord[]
): Promise<RedeemIntent | null> {
  const { data, error } = await admin
    .from('redeem_intents')
    .update({ steps, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('status', expectedStatus)
    .select()
    .maybeSingle<RedeemIntentRow>();

  if (error) throw new Error(error.message);
  return data ? fromRow(data) : null;
}

/** Belt-and-suspenders idempotency marker — `apply_redeem_execution()` itself is the real guard (row-locked, checks+sets `accounting_applied_at`). */
export async function markRedeemAccountingApplied(admin: SupabaseClient, id: string): Promise<void> {
  const { error } = await admin.from('redeem_intents').update({ accounting_applied_at: new Date().toISOString() }).eq('id', id).is('accounting_applied_at', null);
  if (error) throw new Error(error.message);
}

/** Belt-and-suspenders idempotency marker for the PARTIAL_SUCCESS path — `apply_partial_redeem_execution()` is the real guard. */
export async function markRedeemReconciliationApplied(admin: SupabaseClient, id: string): Promise<void> {
  const { error } = await admin
    .from('redeem_intents')
    .update({ reconciliation_applied_at: new Date().toISOString() })
    .eq('id', id)
    .is('reconciliation_applied_at', null);
  if (error) throw new Error(error.message);
}
