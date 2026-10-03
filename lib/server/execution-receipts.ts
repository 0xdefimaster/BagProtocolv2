import type { SupabaseClient } from '@supabase/supabase-js';
import { AssetIdentity, CanonicalAsset } from '@/types/basket-protocol';
import { PurchaseIntent, PurchaseIntentStepRecord } from '@/types/purchase-intent';
import { RedeemIntent } from '@/types/redeem-intent';
import { ExecutionProviderKind } from '@/types/strategy-policy';
import {
  EXECUTION_HISTORY_SCHEMA_VERSION,
  ExecutionHistoryResponse,
  ExecutionReceipt,
  ReceiptAsset,
  ReceiptCheck,
  ReceiptFieldSource,
  ReceiptOutput,
  ReceiptTransaction,
} from '@/types/execution-receipt';
import { assetIdentityKey } from '@/lib/domain/basket-protocol/asset-identity';
import { BAG_ROUTER_PROVIDER_ID } from '@/lib/execution/providers/bag-router-provider';
import { getAssetsByIdentities } from '@/lib/server/asset-repo';
import { listPurchaseIntentsForUserBag } from '@/lib/server/purchase-intent-repo';
import { listRedeemIntentsForUserBag } from '@/lib/server/redeem-intent-repo';

// -----------------------------------------------------------------------------
// Execution receipts (types/execution-receipt.ts) built only from data BAG
// already records — no new tables. Where the actual output comes from:
//
//   purchase, LI.FI Composer / BAG Router: verifyExecution() replaced each
//     completed step's outputAmountRaw with the amount read from the confirmed
//     receipt's Transfer logs (composer-status.ts / bag-router-status.ts) →
//     ONCHAIN_DERIVED.
//   purchase/redeem, LI.FI sequential: trackStepStatus() used LI.FI's status
//     API or, as a same-chain fallback, the receipt; which one is not recorded
//     → PROVIDER_REPORTED, and only when a minimum forced a received amount to
//     exist (otherwise the stored value could still be the quote → null).
//   any step that did not complete: no actual output (null); its stored
//     outputAmountRaw is the quote.
//
// `buildExecutionReceipt*` are pure; `loadExecutionHistory` gathers inputs.
// -----------------------------------------------------------------------------

export const MAX_EXECUTIONS = 50;
/** Intent statuses that can carry a submitted transaction; drafts/quotes/expired-before-signing are not executions. */
export const EXECUTION_STATUSES = ['SUBMITTED', 'CONFIRMING', 'COMPLETED', 'PARTIAL_SUCCESS', 'RECONCILIATION_REQUIRED', 'FAILED'] as const;

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

function asset(id: AssetIdentity, ctx: ReceiptContext, decimalsHint: number | null = null): ReceiptAsset {
  const reg = ctx.assetsByKey.get(assetIdentityKey(id));
  return { chain: id.chain, address: id.address, symbol: reg?.symbol ?? null, decimals: reg?.decimals ?? decimalsHint };
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

function redeemProvider(intent: Pick<RedeemIntent, 'steps'>): ExecutionProviderKind {
  return intent.steps.some((s) => s.action === 'SWAP' && s.lifiStep) ? 'LIFI_SEQUENTIAL' : 'UNKNOWN';
}

function actualFor(step: PurchaseIntentStepRecord, provider: ExecutionProviderKind): { raw: string | null; source: ReceiptFieldSource | null } {
  if (step.action === 'KEEP') return { raw: step.inputAmountRaw, source: 'BAG_RECORDED' };
  if (step.status !== 'COMPLETED' || !step.outputAmountRaw) return { raw: null, source: null };
  if (provider === 'LIFI_COMPOSER' || provider === 'BAG_ROUTER') return { raw: step.outputAmountRaw, source: 'ONCHAIN_DERIVED' };
  if (provider === 'LIFI_SEQUENTIAL' && step.minOutputRaw !== null) return { raw: step.outputAmountRaw, source: 'PROVIDER_REPORTED' };
  return { raw: null, source: null };
}

function outputsFor(steps: PurchaseIntentStepRecord[], provider: ExecutionProviderKind, ctx: ReceiptContext): ReceiptOutput[] {
  return [...steps]
    .sort((a, b) => a.stepIndex - b.stepIndex)
    .map((step) => {
      const actual = actualFor(step, provider);
      const swapped = step.action === 'SWAP';
      return {
        stepIndex: step.stepIndex,
        action: step.action,
        stepStatus: step.status,
        asset: asset(step.outputAsset, ctx, step.outputDecimals),
        inputAmountRaw: step.inputAmountRaw,
        bagMinimumRaw: swapped ? step.minOutputRaw : null,
        providerEnforcedMinimumRaw: swapped ? (step.providerEnforcedMinOutputRaw ?? null) : null,
        actualRaw: actual.raw,
        actualSource: actual.source,
        quotedRaw: swapped && step.status !== 'COMPLETED' ? step.outputAmountRaw : null,
        minimumRespected: swapped && actual.raw !== null && step.minOutputRaw !== null ? BigInt(actual.raw) >= BigInt(step.minOutputRaw) : null,
      };
    });
}

function transactionsFor(executionId: string, steps: PurchaseIntentStepRecord[], ctx: ReceiptContext): ReceiptTransaction[] {
  const byKey = new Map<string, ReceiptTransaction>();
  const add = (txHash: string, chain: PurchaseIntentStepRecord['sourceChain'], role: ReceiptTransaction['role'], verified: boolean) => {
    const key = `${role}:${claimKey(chain, txHash)}`;
    const claim = ctx.claims.get(claimKey(chain, txHash));
    const existing = byKey.get(key);
    const verification: ReceiptTransaction['verification'] = verified || existing?.verification === 'VERIFIED' ? 'VERIFIED' : 'REPORTED_UNVERIFIED';
    byKey.set(key, {
      txHash,
      chain,
      role,
      verification,
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
    .sort((a, b) => (a.role === b.role ? a.txHash.localeCompare(b.txHash) : a.role === 'APPROVAL' ? -1 : 1));
}

function checksFor(outputs: ReceiptOutput[], txs: ReceiptTransaction[], versionBinding: ExecutionReceipt['versionBinding']): ReceiptCheck[] {
  const swaps = outputs.filter((o) => o.action === 'SWAP' && o.stepStatus === 'COMPLETED');
  const minimum: ReceiptCheck['result'] =
    swaps.length === 0 || swaps.some((o) => o.minimumRespected === null) ? 'UNKNOWN' : swaps.every((o) => o.minimumRespected) ? 'PASS' : 'FAIL';
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
  const outputs = outputsFor(intent.steps, provider, ctx);
  const transactions = transactionsFor(intent.id, intent.steps, ctx);
  return {
    executionId: intent.id,
    kind: 'PURCHASE',
    status: intent.status,
    bagId: intent.bagId,
    strategyVersion: intent.recipeVersion,
    versionBinding,
    provider,
    executionPlanHash: intent.executionPlanHash,
    planHashCheckedOnchain: provider === 'BAG_ROUTER' && intent.executionPlanHash !== null && outputs.some((o) => o.action === 'SWAP' && o.stepStatus === 'COMPLETED'),
    wallet: intent.walletAddress,
    transactions,
    blockNumber: null,
    blockTimestamp: null,
    createdAt: intent.createdAt,
    recordedExecutedAt: intent.executedAt,
    input: (() => {
      const a = asset(intent.inputAsset, ctx);
      return { unit: 'TOKEN' as const, asset: a, amountRaw: intent.inputAmountRaw, decimals: a.decimals, source: 'EXECUTION_PLAN' as const };
    })(),
    shares: { amountRaw: intent.sharesRaw, decimals: intent.shareDecimals, source: 'BAG_RECORDED' },
    outputs,
    policyEvaluation: {
      policySnapshotAvailable: false,
      evaluatedAgainstVersion: intent.recipeVersion,
      checks: checksFor(outputs, transactions, versionBinding),
      noRouteFallback: intent.fallback
        ? { policy: intent.fallback.policy, skippedAssets: intent.fallback.assets.map((a) => a.symbol), unroutableWeightBps: intent.fallback.unroutableWeightBps }
        : null,
    },
  };
}

export function buildRedeemReceipt(intent: RedeemIntent, ctx: ReceiptContext): ExecutionReceipt {
  const provider = redeemProvider(intent);
  const outputs = outputsFor(intent.steps, provider, ctx);
  const transactions = transactionsFor(intent.id, intent.steps, ctx);
  return {
    executionId: intent.id,
    kind: 'REDEEM',
    status: intent.status,
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
    policyEvaluation: { policySnapshotAvailable: false, evaluatedAgainstVersion: null, checks: checksFor(outputs, transactions, 'NOT_RECORDED'), noRouteFallback: null },
  };
}

/** Newest first; ties broken by id so the order never depends on the database. */
export function sortReceipts(receipts: ExecutionReceipt[]): ExecutionReceipt[] {
  return [...receipts].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.executionId.localeCompare(b.executionId));
}

const hasSubmittedTx = (steps: PurchaseIntentStepRecord[]) => steps.some((s) => s.txHash);

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

/** The viewer's own executions in one Bag. Never another user's: both queries are filtered by user id. */
export async function loadExecutionHistory(admin: SupabaseClient, bagId: string, userId: string): Promise<ExecutionHistoryResponse> {
  const [purchases, redeems] = await Promise.all([
    listPurchaseIntentsForUserBag(admin, userId, bagId, EXECUTION_STATUSES, MAX_EXECUTIONS),
    listRedeemIntentsForUserBag(admin, userId, bagId, EXECUTION_STATUSES, MAX_EXECUTIONS),
  ]);
  const p = purchases.filter((i) => i.userId === userId && i.bagId === bagId && hasSubmittedTx(i.steps));
  const r = redeems.filter((i) => i.userId === userId && i.bagId === bagId && hasSubmittedTx(i.steps));

  const allSteps = [...p.flatMap((i) => i.steps), ...r.flatMap((i) => i.steps)];
  const txHashes = allSteps.flatMap((s) => [s.txHash, s.approvalTxHash]).filter((h): h is string => !!h);
  const identities = [
    ...p.map((i) => i.inputAsset),
    ...allSteps.flatMap((s) => [s.inputAsset, s.outputAsset]),
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

  return {
    schemaVersion: EXECUTION_HISTORY_SCHEMA_VERSION,
    bagId,
    scope: 'VIEWER_OWN_EXECUTIONS',
    executions: sortReceipts([...p.map((i) => buildPurchaseReceipt(i, ctx)), ...r.map((i) => buildRedeemReceipt(i, ctx))]).slice(0, MAX_EXECUTIONS),
  };
}
