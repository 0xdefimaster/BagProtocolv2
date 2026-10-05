import { SupabaseClient } from '@supabase/supabase-js';
import { AssetIdentity, ChainId } from '@/types/basket-protocol';
import { RedeemIntent, RedeemIntentFailureCode, RedeemIntentStatus, RedeemIntentStepRecord, RedeemSettlementPlan } from '@/types/redeem-intent';
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
  /** 0047; absent on a database without that migration. */
  composer_transaction?: RedeemIntent['composerTransaction'];
  /** 0053; absent on a database without that migration. */
  settlement_plan?: RedeemSettlementPlan | null;
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
    composerTransaction: row.composer_transaction ?? null,
    settlementPlan: row.settlement_plan ?? null,
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
  composerTransaction?: RedeemIntent['composerTransaction'];
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
      // Only written when set, so per-asset redemptions keep working on a database without migration 0047.
      ...(input.composerTransaction ? { composer_transaction: input.composerTransaction } : {}),
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

/** One user's redemptions with a transaction on chain that are not final yet (SUBMITTED/CONFIRMING), newest first. */
export async function listUnsettledRedeemIntentsForUser(admin: SupabaseClient, userId: string, limit: number): Promise<RedeemIntent[]> {
  const { data, error } = await admin
    .from('redeem_intents')
    .select()
    .eq('user_id', userId)
    .in('status', ['SUBMITTED', 'CONFIRMING'])
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return ((data ?? []) as RedeemIntentRow[]).map(fromRow);
}

/** Same as `listUnsettledPurchaseIntents()` for redemptions (SUBMITTED/CONFIRMING, oldest first). Scheduled reconciler only. */
export async function listUnsettledRedeemIntents(admin: SupabaseClient, olderThanIso: string, limit: number): Promise<RedeemIntent[]> {
  const { data, error } = await admin
    .from('redeem_intents')
    .select()
    .in('status', ['SUBMITTED', 'CONFIRMING'])
    .lt('updated_at', olderThanIso)
    .order('updated_at', { ascending: true })
    .limit(limit);
  if (error) throw new Error(error.message);
  return ((data ?? []) as RedeemIntentRow[]).map(fromRow);
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

/** One user's intents for one Bag in the given statuses, newest first then id (execution history). Read-only. */
export async function listRedeemIntentsForUserBag(
  admin: SupabaseClient,
  userId: string,
  bagId: string,
  statuses: readonly RedeemIntentStatus[],
  limit: number,
  /** Keyset position: only rows strictly after it in (created_at desc, id asc) order. Values must be pre-validated. */
  after?: { createdAt: string; id: string }
): Promise<RedeemIntent[]> {
  const { data, error } = await admin
    .from('redeem_intents')
    .select()
    .eq('user_id', userId)
    .eq('bag_id', bagId)
    .in('status', [...statuses])
    .or(after ? `created_at.lt."${after.createdAt}",and(created_at.eq."${after.createdAt}",id.gt."${after.id}")` : 'id.not.is.null')
    .order('created_at', { ascending: false })
    .order('id', { ascending: true })
    .limit(limit);
  if (error) throw new Error(error.message);
  return ((data ?? []) as RedeemIntentRow[]).map(fromRow);
}

/**
 * Marks a still-unsettled intent as just checked (updated_at = now) so the reconciler's oldest-first batch moves
 * on to others instead of re-checking the same never-mined transactions forever. Only touches SUBMITTED/CONFIRMING.
 */
export async function touchUnsettledRedeemIntent(admin: SupabaseClient, id: string): Promise<void> {
  const { error } = await admin.from('redeem_intents').update({ updated_at: new Date().toISOString() }).eq('id', id).in('status', ['SUBMITTED', 'CONFIRMING']);
  if (error) throw new Error(error.message);
}

/**
 * Records phase 1's settlement plan (0053). Same race guard as the other updates: only while the intent is still in
 * `expectedStatus`. Clears any composer transaction an earlier attestation left, so a re-quote never pairs a new
 * plan with an old signature.
 */
export async function setRedeemSettlementPlan(
  admin: SupabaseClient,
  id: string,
  expectedStatus: RedeemIntentStatus,
  plan: RedeemSettlementPlan
): Promise<RedeemIntent | null> {
  const { data, error } = await admin
    .from('redeem_intents')
    .update({ settlement_plan: plan, composer_transaction: null, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('status', expectedStatus)
    .select()
    .maybeSingle<RedeemIntentRow>();
  if (error) throw new Error(error.message);
  return data ? fromRow(data) : null;
}

/**
 * Records phase 2's result: the attested plan and the one Composer transaction the wallet signs. Guarded on the
 * status AND on the plan phase 2 attested (its context hash), so a plan replaced in between is never overwritten
 * with a signature made for another one.
 */
export async function setRedeemSettlementAttested(
  admin: SupabaseClient,
  id: string,
  expectedStatus: RedeemIntentStatus,
  expectedContextHash: string,
  plan: RedeemSettlementPlan,
  composerTransaction: NonNullable<RedeemIntent['composerTransaction']>
): Promise<RedeemIntent | null> {
  const { data, error } = await admin
    .from('redeem_intents')
    .update({ settlement_plan: plan, composer_transaction: composerTransaction, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('status', expectedStatus)
    .eq('settlement_plan->>contextHash', expectedContextHash)
    .select()
    .maybeSingle<RedeemIntentRow>();
  if (error) throw new Error(error.message);
  return data ? fromRow(data) : null;
}

/** Statuses an intent can still move from (everything but the terminal ones). */
const OPEN_REDEEM_STATUSES = ['DRAFT', 'QUOTED', 'READY', 'AWAITING_SIGNATURE', 'SUBMITTED', 'CONFIRMING'] as const;

/** Every non-terminal redeem intent of this user's position (normally at most one). */
export async function listOpenRedeemIntentsForBag(admin: SupabaseClient, userId: string, bagId: string): Promise<RedeemIntent[]> {
  const { data, error } = await admin
    .from('redeem_intents')
    .select()
    .eq('user_id', userId)
    .eq('bag_id', bagId)
    .in('status', [...OPEN_REDEEM_STATUSES])
    .order('created_at', { ascending: false })
    .limit(20);
  if (error) throw new Error(error.message);
  return ((data ?? []) as RedeemIntentRow[]).map(fromRow);
}

/**
 * The most recent intents of this user's position whose settlement attestation (phase 2) is still valid on-chain —
 * its signed deadline has not passed — IN ANY STATUS. An attestation cannot be revoked: an intent marked FAILED or
 * CANCELLED in the database may still hold one the wallet could submit until its deadline. Attestations live at most
 * a few minutes, and a new intent of the position cannot start while one is live, so the recent rows suffice.
 */
export async function listLiveSettlementAttestations(admin: SupabaseClient, userId: string, bagId: string, nowSec = Math.floor(Date.now() / 1000)): Promise<RedeemIntent[]> {
  const { data, error } = await admin
    .from('redeem_intents')
    .select()
    .eq('user_id', userId)
    .eq('bag_id', bagId)
    .order('created_at', { ascending: false })
    .limit(20);
  if (error) throw new Error(error.message);
  return ((data ?? []) as RedeemIntentRow[]).map(fromRow).filter((i) => typeof i.settlementPlan?.deadline === 'number' && i.settlementPlan.deadline >= nowSec);
}

/**
 * Phase 2's claim, written BEFORE it reads for other sales of the position and before it signs (write-then-check, as
 * in fee-redemption-lock.ts): records the deadline the attestation will carry. Guarded on the status and on the plan
 * phase 2 checked.
 */
export async function claimRedeemSettlementAttestation(
  admin: SupabaseClient,
  id: string,
  expectedStatus: RedeemIntentStatus,
  plan: RedeemSettlementPlan
): Promise<RedeemIntent | null> {
  const { data, error } = await admin
    .from('redeem_intents')
    .update({ settlement_plan: plan, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('status', expectedStatus)
    .eq('settlement_plan->>contextHash', plan.contextHash)
    .select()
    .maybeSingle<RedeemIntentRow>();
  if (error) throw new Error(error.message);
  return data ? fromRow(data) : null;
}

/**
 * Records the settlement's on-chain result (from its `Settled` event) into the intent's plan. Idempotent; only onto
 * the plan it was read for (same context hash), never over another one.
 */
export async function recordRedeemSettlementResult(admin: SupabaseClient, id: string, plan: RedeemSettlementPlan): Promise<void> {
  const { error } = await admin
    .from('redeem_intents')
    .update({ settlement_plan: plan, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('settlement_plan->>contextHash', plan.contextHash)
    .select()
    .maybeSingle();
  if (error) throw new Error(error.message);
}
