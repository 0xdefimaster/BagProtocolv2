import type { SupabaseClient } from '@supabase/supabase-js';
import { AssetIdentity, CanonicalAsset, ChainId } from '@/types/basket-protocol';
import { PurchaseIntent, PurchaseIntentStepRecord, TERMINAL_PURCHASE_INTENT_STATUSES } from '@/types/purchase-intent';
import { RedeemIntent } from '@/types/redeem-intent';
import { ExecutionProviderKind } from '@/types/strategy-policy';
import {
  EXECUTION_HISTORY_SCHEMA_VERSION,
  ExecutionHistoryResponse,
  ExecutionOutcome,
  ExecutionReceipt,
  ReceiptAsset,
  ReceiptCheck,
  ReceiptEvidence,
  ReceiptFieldSource,
  ReceiptOutput,
  ReceiptSettlement,
  ReceiptTotalReceived,
  ReceiptTransaction,
  StepOutcome,
} from '@/types/execution-receipt';
import { assetIdentityKey } from '@/lib/domain/basket-protocol/asset-identity';
import { BAG_CHAINS, BagChain } from '@/lib/config/chains';
import { BAG_ROUTER_PROVIDER_ID } from '@/lib/execution/providers/bag-router-provider';
import { getAssetsByIdentities } from '@/lib/server/asset-repo';
import { listPurchaseIntentsForUserBag } from '@/lib/server/purchase-intent-repo';
import { listRedeemIntentsForUserBag } from '@/lib/server/redeem-intent-repo';

// -----------------------------------------------------------------------------
// Execution receipts (types/execution-receipt.ts, schema v2) built only from
// data BAG already records — no new tables. Internal intent/step statuses are
// mapped to the public outcome enums here and never leave this module.
//
// Where the actual output comes from:
//   purchase, LI.FI Composer / BAG Router: verifyExecution() replaced each
//     completed step's outputAmountRaw with the amount read from the confirmed
//     receipt's Transfer logs → ONCHAIN_DERIVED.
//   purchase/redeem, LI.FI sequential: LI.FI's status API or a same-chain
//     receipt fallback, which one is not recorded → PROVIDER_REPORTED, and only
//     when a minimum forced a received amount to exist (else null).
//   any step that did not complete: actual null; the stored value is a quote.
// -----------------------------------------------------------------------------

export const MAX_EXECUTIONS_PAGE = 50;
/** Intent statuses that can carry a submitted transaction; anything earlier (draft/quote) or abandoned before signing is not an execution. */
export const EXECUTION_STATUSES = ['SUBMITTED', 'CONFIRMING', 'COMPLETED', 'PARTIAL_SUCCESS', 'RECONCILIATION_REQUIRED', 'FAILED'] as const;
/** Upper bound on keyset batches per table per page (intents without a submitted tx are skipped server-side). */
const MAX_BATCHES = 20;

// ----------------------------- Public status mapping --------------------------

/**
 * Internal intent status → public outcome. Total over every string: an internal
 * status this contract does not know maps to UNKNOWN, never to a guess.
 */
export function publicOutcome(internal: string): ExecutionOutcome {
  switch (internal) {
    case 'COMPLETED':
      return 'SUCCEEDED';
    case 'PARTIAL_SUCCESS':
    case 'RECONCILIATION_REQUIRED':
      return 'PARTIAL';
    case 'FAILED':
      return 'FAILED';
    case 'SUBMITTED':
    case 'CONFIRMING':
      return 'PENDING';
    default:
      return 'UNKNOWN';
  }
}

export function isFinalOutcome(internal: string): boolean {
  return (TERMINAL_PURCHASE_INTENT_STATUSES as ReadonlySet<string>).has(internal);
}

const NOT_SUBMITTED_STEP_STATUSES = new Set(['PENDING', 'APPROVAL_REQUIRED', 'APPROVAL_AWAITING_SIGNATURE', 'APPROVAL_SUBMITTED', 'APPROVAL_CONFIRMED', 'AWAITING_SIGNATURE']);

/** Internal step status → public step outcome (KEEP steps are HELD: no swap, nothing to fill). */
export function publicStepOutcome(step: Pick<PurchaseIntentStepRecord, 'action' | 'status' | 'txHash'>): StepOutcome {
  if (step.action === 'KEEP') return 'HELD';
  const status = step.status as string;
  if (status === 'COMPLETED') return 'FILLED';
  if (status === 'FAILED') return 'FAILED';
  if (status === 'SUBMITTED' || status === 'CONFIRMING') return 'PENDING';
  if (NOT_SUBMITTED_STEP_STATUSES.has(status)) return step.txHash ? 'PENDING' : 'NOT_SUBMITTED';
  return 'UNKNOWN';
}

// ----------------------------- Building ---------------------------------------

export interface TxClaimRow {
  chain: string;
  tx_hash: string;
  intent_kind: 'PURCHASE' | 'REDEEM';
  intent_id: string;
}

export interface ReceiptContext {
  assetsByKey: Map<string, CanonicalAsset>;
  /** key `${chain}:${txHash lowercase}` → claim row. */
  claims: Map<string, TxClaimRow>;
  /** version number → composition hash, for this Bag. */
  versionHashes: Map<number, string>;
}

const claimKey = (chain: string, txHash: string) => `${chain}:${txHash.toLowerCase()}`;

/** EIP-155 id from BAG's own chain config — never from the request. Null for chains BAG has no EVM config for. */
export function chainIdFor(chain: ChainId): number | null {
  return (BAG_CHAINS as Partial<Record<string, (typeof BAG_CHAINS)[BagChain]>>)[chain]?.chainId ?? null;
}

function asset(id: AssetIdentity, ctx: ReceiptContext, fallback: { symbol?: string | null; decimals?: number | null } = {}): ReceiptAsset {
  const reg = ctx.assetsByKey.get(assetIdentityKey(id));
  return {
    chain: id.chain,
    chainId: chainIdFor(id.chain),
    address: id.address,
    symbol: reg?.symbol ?? fallback.symbol ?? null,
    decimals: reg?.decimals ?? fallback.decimals ?? null,
  };
}

/** Provider of a purchase, from what BAG recorded server-side (never from the client). */
export function purchaseProvider(intent: Pick<PurchaseIntent, 'providerId' | 'composerTransaction' | 'bagRouterTransaction' | 'steps'>): ExecutionProviderKind {
  if (intent.providerId) {
    if (intent.providerId === BAG_ROUTER_PROVIDER_ID) return 'BAG_ROUTER';
    if (intent.providerId === 'lifi-composer') return 'LIFI_COMPOSER';
    if (intent.providerId === 'lifi-sequential') return 'LIFI_SEQUENTIAL';
    return 'UNKNOWN';
  }
  if (intent.composerTransaction) return 'LIFI_COMPOSER';
  if (intent.bagRouterTransaction) return 'BAG_ROUTER';
  if (intent.steps.some((s) => s.action === 'SWAP' && s.lifiStep)) return 'LIFI_SEQUENTIAL';
  return 'UNKNOWN';
}

/** Provider of a redeem, from what BAG recorded server-side. */
export function redeemProvider(intent: Pick<RedeemIntent, 'steps' | 'composerTransaction'>): ExecutionProviderKind {
  if (intent.composerTransaction) return 'LIFI_COMPOSER';
  return intent.steps.some((s) => s.action === 'SWAP' && s.lifiStep) ? 'LIFI_SEQUENTIAL' : 'UNKNOWN';
}

/**
 * A one-transaction (Composer) redeem pays every leg in the same token in the same transaction: only the total is
 * observable on-chain, and the per-leg amounts BAG stores are an apportionment of it (splitReceivedAcrossLegs).
 */
const legActualsApportioned = (kind: 'PURCHASE' | 'REDEEM', provider: ExecutionProviderKind) => kind === 'REDEEM' && provider === 'LIFI_COMPOSER';

function actualFor(step: PurchaseIntentStepRecord, provider: ExecutionProviderKind, apportioned: boolean): { raw: string | null; source: ReceiptFieldSource | null } {
  if (step.action === 'KEEP') return { raw: step.inputAmountRaw, source: 'BAG_RECORDED' };
  if (apportioned) return { raw: null, source: null };
  if (step.status !== 'COMPLETED' || !step.outputAmountRaw) return { raw: null, source: null };
  if (provider === 'LIFI_COMPOSER' || provider === 'BAG_ROUTER') return { raw: step.outputAmountRaw, source: 'ONCHAIN_DERIVED' };
  if (provider === 'LIFI_SEQUENTIAL' && step.minOutputRaw !== null) return { raw: step.outputAmountRaw, source: 'PROVIDER_REPORTED' };
  return { raw: null, source: null };
}

function outputsFor(steps: PurchaseIntentStepRecord[], provider: ExecutionProviderKind, ctx: ReceiptContext, kind: 'PURCHASE' | 'REDEEM'): ReceiptOutput[] {
  const apportioned = legActualsApportioned(kind, provider);
  return [...steps]
    .sort((a, b) => a.stepIndex - b.stepIndex)
    .map((step) => {
      const actual = actualFor(step, provider, apportioned);
      const swapped = step.action === 'SWAP';
      const outcome = publicStepOutcome(step);
      return {
        stepIndex: step.stepIndex,
        action: step.action,
        outcome,
        asset: asset(step.outputAsset, ctx, { decimals: step.outputDecimals }),
        soldAsset: kind === 'REDEEM' ? asset(step.inputAsset, ctx) : null,
        inputAmountRaw: step.inputAmountRaw,
        bagMinimumRaw: swapped ? step.minOutputRaw : null,
        providerEnforcedMinimumRaw: swapped ? (step.providerEnforcedMinOutputRaw ?? null) : null,
        actualRaw: actual.raw,
        actualSource: actual.source,
        // An apportioned leg amount is neither an outcome nor a quote.
        quotedRaw: swapped && outcome !== 'FILLED' && !apportioned ? step.outputAmountRaw : null,
        minimumRespected: swapped && actual.raw !== null && step.minOutputRaw !== null ? BigInt(actual.raw) >= BigInt(step.minOutputRaw) : null,
      };
    });
}

/**
 * Receipt-level summary over FILLED swaps (types/execution-receipt.ts `EVIDENCE_LEVELS`). A filled swap with no
 * per-step actual counts as on-chain evidenced only when an ONCHAIN_DERIVED `totalReceived` covers it.
 */
export function evidenceFor(outputs: ReceiptOutput[], totalReceived: ReceiptTotalReceived | null = null): ReceiptEvidence {
  const swaps = outputs.filter((o) => o.action === 'SWAP');
  const filled = swaps.filter((o) => o.outcome === 'FILLED');
  const onchainDerived = filled.filter((o) => o.actualRaw !== null && o.actualSource === 'ONCHAIN_DERIVED').length;
  const providerReported = filled.filter((o) => o.actualRaw !== null && o.actualSource === 'PROVIDER_REPORTED').length;
  const coveredByTotal = totalReceived?.actualSource === 'ONCHAIN_DERIVED' ? filled.filter((o) => o.actualRaw === null).length : 0;
  const unrecorded = filled.length - onchainDerived - providerReported - coveredByTotal;
  const level = filled.length === 0 ? 'NONE' : unrecorded > 0 ? 'PARTIAL' : providerReported > 0 ? 'PROVIDER' : 'ONCHAIN';
  return { level, swapSteps: swaps.length, filledSwaps: filled.length, onchainDerived, providerReported, coveredByTotal, unrecorded };
}

const SOURCE_STRENGTH: ReceiptFieldSource[] = ['ONCHAIN_DERIVED', 'PROVIDER_REPORTED'];

/** Redeem: total received in the output asset, only when every swap filled and its output is recorded (types `ReceiptTotalReceived`). */
function totalReceivedFor(intent: RedeemIntent, outputs: ReceiptOutput[], provider: ExecutionProviderKind, ctx: ReceiptContext): ReceiptTotalReceived | null {
  const swapSteps = intent.steps.filter((s) => s.action === 'SWAP');
  const swapOutputs = outputs.filter((o) => o.action === 'SWAP');
  if (swapSteps.length === 0 || swapOutputs.some((o) => o.outcome !== 'FILLED')) return null;
  const sum = (values: (string | null | undefined)[]) =>
    values.every((v) => typeof v === 'string' && /^\d+$/.test(v)) ? values.reduce((a, v) => a + BigInt(v as string), BigInt(0)).toString() : null;

  let actualRaw: string | null;
  let actualSource: ReceiptFieldSource;
  if (legActualsApportioned('REDEEM', provider)) {
    // The stored leg amounts sum exactly to what the receipt's Transfer logs showed reaching the wallet.
    actualRaw = sum(swapSteps.map((s) => s.outputAmountRaw));
    actualSource = 'ONCHAIN_DERIVED';
  } else {
    actualRaw = sum(swapOutputs.map((o) => o.actualRaw));
    const sources = swapOutputs.map((o) => o.actualSource);
    if (sources.some((src) => src === null || !SOURCE_STRENGTH.includes(src))) return null;
    actualSource = sources.some((src) => src === 'PROVIDER_REPORTED') ? 'PROVIDER_REPORTED' : 'ONCHAIN_DERIVED';
  }
  if (actualRaw === null) return null;
  return {
    asset: asset(intent.outputAsset, ctx, { decimals: intent.outputDecimals }),
    actualRaw,
    actualSource,
    providerEnforcedMinimumRaw: sum(swapSteps.map((s) => s.providerEnforcedMinOutputRaw)),
  };
}

function transactionsFor(executionId: string, steps: PurchaseIntentStepRecord[], ctx: ReceiptContext): ReceiptTransaction[] {
  const byKey = new Map<string, ReceiptTransaction>();
  const add = (txHash: string, chain: ChainId, role: ReceiptTransaction['role'], verified: boolean) => {
    const key = `${role}:${claimKey(chain, txHash)}`;
    const claim = ctx.claims.get(claimKey(chain, txHash));
    const existing = byKey.get(key);
    byKey.set(key, {
      txHash,
      chain,
      chainId: chainIdFor(chain),
      role,
      verification: verified || existing?.verification === 'VERIFIED' ? 'VERIFIED' : 'REPORTED_UNVERIFIED',
      claim: !claim ? 'UNCLAIMED' : claim.intent_id === executionId ? 'THIS_EXECUTION' : 'OTHER_EXECUTION',
    });
  };
  for (const s of steps) {
    if (s.approvalTxHash) add(s.approvalTxHash, s.sourceChain, 'APPROVAL', false);
    if (s.txHash) add(s.txHash, s.sourceChain, 'EXECUTION', s.status === 'COMPLETED');
  }
  // A transaction counts as verified only if the claim table agrees it is this execution's.
  return Array.from(byKey.values())
    .map((t) => (t.verification === 'VERIFIED' && t.claim !== 'THIS_EXECUTION' ? { ...t, verification: 'REPORTED_UNVERIFIED' as const } : t))
    .sort((a, b) => (a.role === b.role ? (a.txHash < b.txHash ? -1 : a.txHash > b.txHash ? 1 : 0) : a.role === 'APPROVAL' ? -1 : 1));
}

function checksFor(outputs: ReceiptOutput[], txs: ReceiptTransaction[], versionBinding: ExecutionReceipt['versionBinding']): ReceiptCheck[] {
  const filled = outputs.filter((o) => o.action === 'SWAP' && o.outcome === 'FILLED');
  const minimum: ReceiptCheck['result'] =
    filled.length === 0 || filled.some((o) => o.minimumRespected === null) ? 'UNKNOWN' : filled.every((o) => o.minimumRespected) ? 'PASS' : 'FAIL';
  const executionTxs = txs.filter((t) => t.role === 'EXECUTION');
  const claimed: ReceiptCheck['result'] =
    executionTxs.length === 0 ? 'UNKNOWN' : executionTxs.some((t) => t.claim === 'OTHER_EXECUTION') ? 'FAIL' : executionTxs.every((t) => t.claim === 'THIS_EXECUTION') ? 'PASS' : 'UNKNOWN';
  const version: ReceiptCheck['result'] = versionBinding === 'MATCHES_VERSION_RECORD' ? 'PASS' : versionBinding === 'MISMATCH' ? 'FAIL' : 'UNKNOWN';
  return [
    { check: 'ACTUAL_AT_LEAST_MINIMUM', result: minimum },
    { check: 'TX_CLAIMED_BY_THIS_EXECUTION', result: claimed },
    { check: 'VERSION_BINDING', result: version },
  ];
}

export function buildPurchaseReceipt(intent: PurchaseIntent, ctx: ReceiptContext): ExecutionReceipt {
  const provider = purchaseProvider(intent);
  const recordedHash = ctx.versionHashes.get(intent.recipeVersion);
  const versionBinding: ExecutionReceipt['versionBinding'] =
    recordedHash === undefined ? 'VERSION_NOT_FOUND' : recordedHash === intent.compositionHash ? 'MATCHES_VERSION_RECORD' : 'MISMATCH';
  const outputs = outputsFor(intent.steps, provider, ctx, 'PURCHASE');
  const transactions = transactionsFor(intent.id, intent.steps, ctx);
  const input = asset(intent.inputAsset, ctx);
  return {
    executionId: intent.id,
    kind: 'PURCHASE',
    outcome: publicOutcome(intent.status),
    isFinal: isFinalOutcome(intent.status),
    bagId: intent.bagId,
    strategyVersion: intent.recipeVersion,
    versionBinding,
    provider,
    executionPlanHash: intent.executionPlanHash,
    planHashCheckedOnchain: provider === 'BAG_ROUTER' && intent.executionPlanHash !== null && outputs.some((o) => o.action === 'SWAP' && o.outcome === 'FILLED'),
    wallet: intent.walletAddress,
    transactions,
    blockNumber: null,
    blockTimestamp: null,
    createdAt: intent.createdAt,
    recordedExecutedAt: intent.executedAt,
    input: { unit: 'TOKEN', asset: input, amountRaw: intent.inputAmountRaw, decimals: input.decimals, source: 'EXECUTION_PLAN' },
    shares: { amountRaw: intent.sharesRaw, decimals: intent.shareDecimals, source: 'BAG_RECORDED' },
    outputs,
    totalReceived: null,
    evidence: evidenceFor(outputs),
    policyEvaluation: {
      policySnapshotAvailable: false,
      evaluatedAgainstVersion: intent.recipeVersion,
      checks: checksFor(outputs, transactions, versionBinding),
      noRouteFallback: intent.fallback
        ? {
            policy: intent.fallback.policy,
            skippedAssets: intent.fallback.assets.map((a) => asset({ chain: a.chain, address: a.address }, ctx, { symbol: a.symbol })),
            unroutableWeightBps: intent.fallback.unroutableWeightBps,
          }
        : null,
    },
  };
}

/** A settled sale's on-chain result (the `Settled` event recorded by verification), or null. */
export function settlementFor(intent: RedeemIntent, ctx: ReceiptContext): ReceiptSettlement | null {
  const plan = intent.settlementPlan;
  const result = plan?.result;
  const isUint = (v: unknown): v is string => typeof v === 'string' && /^\d+$/.test(v);
  if (!plan || !result || ![result.received, result.feeBase, result.fee, result.userProceeds, plan.consumedBasisRaw].every(isUint)) return null;
  const gross = BigInt(result.received);
  const fee = BigInt(result.fee);
  const feeBase = BigInt(result.feeBase);
  const realized = gross - BigInt(plan.consumedBasisRaw);
  const feeReason: ReceiptSettlement['feeReason'] = fee > BigInt(0) ? 'CHARGED' : plan.feeRateBps === 0 ? 'NO_FEE_RATE' : feeBase === BigInt(0) ? 'NO_GAIN' : 'GAIN_TOO_SMALL';
  return {
    source: 'ONCHAIN_SETTLED_EVENT',
    settlementContract: plan.settlement,
    txHash: result.txHash,
    asset: asset(intent.outputAsset, ctx, { decimals: intent.outputDecimals }),
    grossProceedsRaw: result.received,
    feeBaseRaw: result.feeBase,
    performanceFeeRaw: result.fee,
    netProceedsRaw: result.userProceeds,
    feeRateBps: plan.feeRateBps,
    consumedBasisRaw: plan.consumedBasisRaw,
    realizedPnlRaw: realized.toString(),
    netRealizedPnlRaw: (realized - fee).toString(),
    feeReason,
    creator: result.creator,
  };
}

export function buildRedeemReceipt(intent: RedeemIntent, ctx: ReceiptContext): ExecutionReceipt {
  const provider = redeemProvider(intent);
  const outputs = outputsFor(intent.steps, provider, ctx, 'REDEEM');
  const totalReceived = totalReceivedFor(intent, outputs, provider, ctx);
  const transactions = transactionsFor(intent.id, intent.steps, ctx);
  const settlement = settlementFor(intent, ctx);
  return {
    executionId: intent.id,
    kind: 'REDEEM',
    outcome: publicOutcome(intent.status),
    isFinal: isFinalOutcome(intent.status),
    bagId: intent.bagId,
    strategyVersion: null,
    versionBinding: 'NOT_RECORDED',
    provider,
    executionPlanHash: null,
    planHashCheckedOnchain: false,
    wallet: intent.walletAddress,
    transactions,
    blockNumber: null,
    blockTimestamp: null,
    createdAt: intent.createdAt,
    recordedExecutedAt: intent.executedAt,
    // What a redeem spends is the Bag's shares; each step sells one holding into the output asset.
    input: { unit: 'BAG_SHARES', asset: null, amountRaw: intent.sharesRaw, decimals: intent.shareDecimals, source: 'EXECUTION_PLAN' },
    shares: { amountRaw: intent.sharesRaw, decimals: intent.shareDecimals, source: 'BAG_RECORDED' },
    outputs,
    totalReceived,
    evidence: evidenceFor(outputs, totalReceived),
    policyEvaluation: { policySnapshotAvailable: false, evaluatedAgainstVersion: null, checks: checksFor(outputs, transactions, 'NOT_RECORDED'), noRouteFallback: null },
    ...(settlement ? { settlement } : {}),
  };
}

// ----------------------------- Ordering & cursor ------------------------------

const ISO_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Microseconds since epoch, exact (Postgres timestamps carry up to 6 fractional digits of varying length). */
export function toMicros(iso: string): bigint {
  const m = ISO_RE.exec(iso);
  if (!m) throw new Error(`Not an ISO timestamp: ${iso}`);
  const seconds = BigInt(Math.floor(Date.parse(`${m[1]}${m[3]}`) / 1000));
  return seconds * BigInt(1_000_000) + BigInt((m[2] ?? '').padEnd(6, '0'));
}

interface Position {
  createdAt: string;
  id: string;
}

/** Global order: createdAt desc, then id asc (codepoint order, same as Postgres uuid order for canonical lowercase ids). */
export function comparePositions(a: Position, b: Position): number {
  const ta = toMicros(a.createdAt);
  const tb = toMicros(b.createdAt);
  if (ta !== tb) return ta > tb ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function sortReceipts(receipts: ExecutionReceipt[]): ExecutionReceipt[] {
  return [...receipts].sort((a, b) => comparePositions({ createdAt: a.createdAt, id: a.executionId }, { createdAt: b.createdAt, id: b.executionId }));
}

export class InvalidCursorError extends Error {}

interface CursorPayload {
  v: 1;
  b: string;
  t: string;
  i: string;
}

export function encodeCursor(bagId: string, pos: Position): string {
  const payload: CursorPayload = { v: 1, b: bagId, t: pos.createdAt, i: pos.id };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/** Validates everything that later reaches a query filter; a cursor for another Bag is refused. */
export function decodeCursor(cursor: string, bagId: string): Position {
  let payload: Partial<CursorPayload>;
  try {
    if (!/^[A-Za-z0-9_-]{1,512}$/.test(cursor)) throw new Error('shape');
    payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidCursorError('Invalid cursor.');
  }
  if (payload?.v !== 1 || payload.b !== bagId || typeof payload.t !== 'string' || typeof payload.i !== 'string' || !ISO_RE.test(payload.t) || !UUID_RE.test(payload.i)) {
    throw new InvalidCursorError('Invalid cursor.');
  }
  return { createdAt: payload.t, id: payload.i };
}

const hasSubmittedTx = (steps: PurchaseIntentStepRecord[]) => steps.some((s) => s.txHash);

type IntentLike = { id: string; userId: string; bagId: string; createdAt: string; steps: PurchaseIntentStepRecord[] };

/**
 * Reads one table in keyset order after `after`, skipping intents without a submitted tx, until it has
 * `need` executions or runs out. `exhausted` is false when it stopped early (more may exist).
 */
async function collect<T extends IntentLike>(
  list: (after: Position | undefined, limit: number) => Promise<T[]>,
  userId: string,
  bagId: string,
  after: Position | undefined,
  need: number
): Promise<{ items: T[]; exhausted: boolean; boundary: Position | null }> {
  const items: T[] = [];
  let position = after;
  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    const rows = await list(position, need);
    for (const row of rows) {
      // Defense in depth: the query already filters by user and Bag.
      if (row.userId === userId && row.bagId === bagId && hasSubmittedTx(row.steps)) items.push(row);
    }
    if (rows.length < need) return { items, exhausted: true, boundary: null };
    const last = rows[rows.length - 1];
    position = { createdAt: last.createdAt, id: last.id };
    if (items.length >= need) return { items, exhausted: false, boundary: position };
  }
  // Stopped early: nothing older than `boundary` has been read from this table yet.
  return { items, exhausted: false, boundary: position ?? null };
}

// ----------------------------- Loading ----------------------------------------

async function loadClaims(admin: SupabaseClient, txHashes: string[]): Promise<Map<string, TxClaimRow>> {
  const unique = Array.from(new Set(txHashes.map((h) => h.toLowerCase())));
  if (unique.length === 0) return new Map();
  const { data, error } = await admin.from('intent_tx_claims').select('chain,tx_hash,intent_kind,intent_id').in('tx_hash', unique);
  if (error) throw new Error(error.message);
  return new Map(((data ?? []) as TxClaimRow[]).map((r) => [claimKey(r.chain, r.tx_hash), r]));
}

async function loadVersionHashes(admin: SupabaseClient, bagId: string): Promise<Map<number, string>> {
  const { data, error } = await admin.from('bag_versions').select('version,composition_hash').eq('bag_id', bagId);
  if (error) throw new Error(error.message);
  return new Map(((data ?? []) as { version: number; composition_hash: string }[]).map((r) => [r.version, r.composition_hash]));
}

/**
 * One page of the viewer's own executions in one Bag, newest first. Never another user's: every query is
 * filtered by user id and Bag id, and the cursor only moves the position within that set.
 */
export async function loadExecutionHistory(
  admin: SupabaseClient,
  bagId: string,
  userId: string,
  options: { cursor?: string | null; limit?: number } = {}
): Promise<ExecutionHistoryResponse> {
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? MAX_EXECUTIONS_PAGE), 1), MAX_EXECUTIONS_PAGE);
  const after = options.cursor ? decodeCursor(options.cursor, bagId) : undefined;
  const need = limit + 1;

  const [p, r] = await Promise.all([
    collect((a, n) => listPurchaseIntentsForUserBag(admin, userId, bagId, EXECUTION_STATUSES, n, a), userId, bagId, after, need),
    collect((a, n) => listRedeemIntentsForUserBag(admin, userId, bagId, EXECUTION_STATUSES, n, a), userId, bagId, after, need),
  ]);

  // Merge both tables in the global order and keep exactly one page.
  type Tagged = { kind: 'PURCHASE'; intent: PurchaseIntent } | { kind: 'REDEEM'; intent: RedeemIntent };
  const merged: Tagged[] = [
    ...p.items.map((intent) => ({ kind: 'PURCHASE' as const, intent })),
    ...r.items.map((intent) => ({ kind: 'REDEEM' as const, intent })),
  ]
    .sort((a, b) => comparePositions({ createdAt: a.intent.createdAt, id: a.intent.id }, { createdAt: b.intent.createdAt, id: b.intent.id }))
    // A table that stopped early has unread rows older than its boundary: never page past it, or they would be skipped.
    .filter((t) => [p, r].every((c) => c.exhausted || !c.boundary || comparePositions({ createdAt: t.intent.createdAt, id: t.intent.id }, c.boundary) <= 0));
  const boundaries = [p, r].filter((c) => !c.exhausted && c.boundary).map((c) => c.boundary as Position);
  const page = merged.slice(0, limit);
  const hasMore = merged.length > limit || boundaries.length > 0;

  const pageSteps = page.flatMap((t) => t.intent.steps);
  const txHashes = pageSteps.flatMap((s) => [s.txHash, s.approvalTxHash]).filter((h): h is string => !!h);
  const identities = [
    ...page.filter((t) => t.kind === 'PURCHASE').map((t) => (t.intent as PurchaseIntent).inputAsset),
    ...pageSteps.flatMap((s) => [s.inputAsset, s.outputAsset]),
    ...page.flatMap((t) => (t.kind === 'PURCHASE' ? ((t.intent as PurchaseIntent).fallback?.assets ?? []) : [])),
  ].filter((a) => /^0x[0-9a-fA-F]{40}$/.test(a.address));

  const [claims, versionHashes, assets] = await Promise.all([
    loadClaims(admin, txHashes),
    loadVersionHashes(admin, bagId),
    getAssetsByIdentities(admin, identities).catch(() => [] as CanonicalAsset[]),
  ]);
  const ctx: ReceiptContext = {
    claims,
    versionHashes,
    assetsByKey: new Map(assets.map((a) => [assetIdentityKey({ chain: a.chain, address: a.address }), a])),
  };

  const executions = page.map((t) => (t.kind === 'PURCHASE' ? buildPurchaseReceipt(t.intent, ctx) : buildRedeemReceipt(t.intent, ctx)));
  const last = page[page.length - 1];
  // With an empty page (only non-executions were read) continue from the newest unread boundary.
  const resumeAt = last ? { createdAt: last.intent.createdAt, id: last.intent.id } : boundaries.sort(comparePositions)[0];
  return {
    schemaVersion: EXECUTION_HISTORY_SCHEMA_VERSION,
    bagId,
    scope: 'VIEWER_OWN_EXECUTIONS',
    executions,
    hasMore,
    nextCursor: hasMore && resumeAt ? encodeCursor(bagId, resumeAt) : null,
  };
}
