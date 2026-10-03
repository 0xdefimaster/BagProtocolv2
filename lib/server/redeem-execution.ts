import { SupabaseClient } from '@supabase/supabase-js';
import { recordNavSnapshot } from '@/lib/server/bag-nav-snapshots';
import { AssetIdentity } from '@/types/basket-protocol';
import { RedeemIntent, RedeemIntentFailureCode, RedeemIntentStepRecord } from '@/types/redeem-intent';
import { PURCHASE_INTENT_TTL_MS } from '@/types/purchase-intent';
import { SessionPayload } from '@/lib/auth/session';
import { getBagById, getCurrentBagVersion } from '@/lib/server/bag-repo';
import { claimNewlyVerifiedTxHashes, TX_HASH_RE } from '@/lib/server/intent-tx-claims';
import { paymentAssetsFor } from '@/lib/server/payment-assets';
import { getBagNavSafe } from '@/lib/server/bag-nav';
import { getShareSupply } from '@/lib/server/bag-share-state-repo';
import { getInvestorPosition } from '@/lib/server/bag-investor-position-repo';
import { getInvestorHoldings } from '@/lib/server/bag-investor-holdings-repo';
import { listAssets } from '@/lib/server/asset-repo';
import { getPriceProvider } from '@/lib/server/price-provider';
import { InsufficientSharesError, getRedeemQuote, ZeroShareSupplyError } from '@/lib/domain/basket-protocol/shares/shares';
import {
  InsufficientPositionError,
  calculateRedeemAllocation,
  buildRedeemExecutionSteps,
} from '@/lib/domain/basket-protocol/redeem/allocation';
import { computeRedeemFingerprint } from '@/lib/domain/basket-protocol/redeem/fingerprint';
import {
  assertValidPurchaseIntentStepTransition,
  isValidPurchaseIntentStepTransition,
} from '@/lib/domain/basket-protocol/purchase-intent/state-machine';
import { buildPurchaseIntentSteps } from '@/lib/blockchain/lifi-purchase-quote';
import { trackStepStatus } from '@/lib/blockchain/lifi-status';
import {
  createRedeemIntent as insertRedeemIntent,
  findActiveRedeemIntentForBag,
  getRedeemIntentForUser,
  markRedeemAccountingApplied,
  markRedeemReconciliationApplied,
  updateRedeemIntentStatus,
  updateRedeemIntentSteps,
} from '@/lib/server/redeem-intent-repo';

// -----------------------------------------------------------------------------
// Phase 21 — the exit-side counterpart to purchase-execution.ts's four
// operations. Same split (route handlers stay I/O + auth + status mapping;
// orchestration lives here), same reasoning throughout — see that file's
// own module doc, which applies here unchanged except where a redemption
// genuinely differs (no single input asset; ownership/sufficiency is
// re-checked at burn time in a way a mint never needs — see
// apply_redeem_execution()'s own doc, supabase/migrations/
// 0012_add_redeem_execution.sql).
// -----------------------------------------------------------------------------

const priceProvider = getPriceProvider();

export type RedeemExecutionError =
  | { kind: 'BAG_NOT_FOUND' }
  | { kind: 'UNKNOWN_OUTPUT_ASSET' }
  | { kind: 'PRICE_UNAVAILABLE'; message: string }
  | { kind: 'NO_POSITION' }
  | { kind: 'INSUFFICIENT_POSITION'; requestedRaw: string; ownedRaw: string }
  | { kind: 'ZERO_SUPPLY' }
  | { kind: 'QUOTE_FAILED'; failureCode: RedeemIntentFailureCode; message: string }
  | { kind: 'REDEEM_IN_PROGRESS'; intentId: string }
  | { kind: 'NOT_FOUND' }
  | { kind: 'FORBIDDEN' }
  | { kind: 'EXPIRED' }
  | { kind: 'ROUTE_CHANGED' }
  | { kind: 'INVALID_STATE'; status: string }
  | { kind: 'INVALID_TX_HASH' }
  | { kind: 'TX_ALREADY_USED' }
  | { kind: 'FEE_ROUTER_REQUIRED' };

export type RedeemExecutionOutcome<T> = { ok: true; value: T } | { ok: false; error: RedeemExecutionError };

// ----------------------------- 1. Create ------------------------------------

export interface CreateRedeemIntentParams {
  admin: SupabaseClient;
  session: SessionPayload;
  bagId: string;
  sharesToRedeemRaw: string;
  outputAssetId: string;
}

/**
 * Builds a fresh `RedeemIntent` against THIS depositor's own current
 * position and holdings — never the bag-level aggregate (see
 * redeem/allocation.ts's module doc). Rejects outright if this wallet
 * already has a non-terminal redeem intent open for this bag, same "don't
 * let two exits race" guard `createPurchaseIntentForUser()` gives deposits.
 */
export async function createRedeemIntentForUser(params: CreateRedeemIntentParams): Promise<RedeemExecutionOutcome<RedeemIntent>> {
  const { admin, session, bagId, sharesToRedeemRaw, outputAssetId } = params;

  const existing = await findActiveRedeemIntentForBag(admin, session.userId, bagId);
  if (existing) {
    return { ok: false, error: { kind: 'REDEEM_IN_PROGRESS', intentId: existing.id } };
  }

  const bag = await getBagById(admin, bagId);
  if (!bag) return { ok: false, error: { kind: 'BAG_NOT_FOUND' } };

  // Output asset resolved by registry id ONLY — same invariant the deposit
  // side's `inputAssetId` already enforces (client never supplies
  // chain/address/decimals directly).
  const assets = await listAssets(admin, { status: 'VERIFIED' });
  const outputAssetRecord = paymentAssetsFor(assets, bag.chain).find((a) => a.id === outputAssetId);
  if (!outputAssetRecord) return { ok: false, error: { kind: 'UNKNOWN_OUTPUT_ASSET' } };
  const outputAsset: AssetIdentity = { chain: outputAssetRecord.chain, address: outputAssetRecord.address };

  const [navOutcome, shareSupply, position, holdings] = await Promise.all([
    getBagNavSafe(admin, bagId, priceProvider),
    getShareSupply(admin, bagId),
    getInvestorPosition(admin, session.userId, bagId),
    getInvestorHoldings(admin, session.userId, bagId),
  ]);

  if (!navOutcome.ok) {
    return { ok: false, error: { kind: 'PRICE_UNAVAILABLE', message: navOutcome.message } };
  }
  const nav = navOutcome.nav;

  if (position.sharesRaw === '0') {
    return { ok: false, error: { kind: 'NO_POSITION' } };
  }

  let redeemQuote;
  try {
    redeemQuote = getRedeemQuote(nav, shareSupply, sharesToRedeemRaw);
  } catch (err) {
    if (err instanceof ZeroShareSupplyError) return { ok: false, error: { kind: 'ZERO_SUPPLY' } };
    // Bag-level insufficiency — should be unreachable in practice, since a
    // request exceeding THIS depositor's own position (the common case)
    // is caught below by `calculateRedeemAllocation()`'s
    // `InsufficientPositionError` instead, and a depositor's own position
    // can never exceed the bag's total. Handled anyway rather than left to
    // surface as an unhandled 500, in case `bag_share_state` and
    // `bag_investor_positions` are ever found to have drifted apart.
    if (err instanceof InsufficientSharesError) {
      return { ok: false, error: { kind: 'INSUFFICIENT_POSITION', requestedRaw: err.requestedRaw, ownedRaw: err.availableRaw } };
    }
    throw err;
  }

  let allocation;
  try {
    allocation = calculateRedeemAllocation({
      bagId,
      sharesRaw: position.sharesRaw,
      sharesToRedeemRaw,
      outputAsset,
      outputDecimals: outputAssetRecord.decimals,
      holdings: holdings.map((h) => ({ chain: h.chain, address: h.address, decimals: h.decimals, quantityRaw: h.quantityRaw })),
    });
  } catch (err) {
    if (err instanceof InsufficientPositionError) {
      return { ok: false, error: { kind: 'INSUFFICIENT_POSITION', requestedRaw: err.requestedRaw, ownedRaw: err.ownedRaw } };
    }
    throw err;
  }

  const symbolByKey = new Map(assets.map((a) => [`${a.chain}:${a.address.toLowerCase()}`, a.symbol]));
  const symbolFor = (asset: AssetIdentity) => symbolByKey.get(`${asset.chain}:${asset.address.toLowerCase()}`) ?? '';
  const executionSteps = buildRedeemExecutionSteps(allocation, outputAsset, symbolFor);

  // Same real, wallet-bound LI.FI quoting the deposit side uses — see
  // lib/blockchain/lifi-purchase-quote.ts's module doc on why this
  // function was narrowed to take `ExecutionStep[]` directly in this
  // phase (a redemption has no single top-level inputAsset/inputAmountRaw
  // an `ExecutionPlan` would otherwise require it to fabricate).
  const { steps, allSwapsQuoted, firstFailure } = await buildPurchaseIntentSteps(
    executionSteps,
    session.walletAddress,
    outputAssetRecord.decimals
  );

  const fingerprint = computeRedeemFingerprint({ bagId, sharesToRedeemRaw, outputAsset, steps: executionSteps });
  const expiresAt = new Date(Date.now() + PURCHASE_INTENT_TTL_MS).toISOString();

  const intent = await insertRedeemIntent(admin, {
    userId: session.userId,
    walletAddress: session.walletAddress,
    bagId,
    sharesRaw: sharesToRedeemRaw,
    shareDecimals: shareSupply.shareDecimals,
    outputAsset,
    outputDecimals: outputAssetRecord.decimals,
    routeFingerprint: fingerprint,
    sharePriceAtQuote: redeemQuote.sharePrice,
    // Phase 21 — locked now, from the same RedeemQuote a Redeem Preview
    // (future UI work) would show this user; threaded into
    // `apply_redeem_execution()` as the proportional cost-basis REDUCTION
    // input — see that RPC's doc on why this isn't derived some other way.
    redeemValueQuote: redeemQuote.grossValue,
    steps,
    status: allSwapsQuoted ? 'READY' : 'FAILED',
    failureCode: allSwapsQuoted ? null : (firstFailure?.failureCode ?? 'UNKNOWN_ERROR'),
    expiresAt,
  });

  if (!allSwapsQuoted && firstFailure) {
    return { ok: false, error: { kind: 'QUOTE_FAILED', failureCode: firstFailure.failureCode, message: firstFailure.message } };
  }

  return { ok: true, value: intent };
}

// ----------------------------- shared guards ---------------------------------

async function loadOwnedIntent(admin: SupabaseClient, userId: string, intentId: string): Promise<RedeemExecutionOutcome<RedeemIntent>> {
  const result = await getRedeemIntentForUser(admin, intentId, userId);
  if (!result.ok) {
    return { ok: false, error: { kind: result.error === 'NOT_FOUND' ? 'NOT_FOUND' : 'FORBIDDEN' } };
  }
  return { ok: true, value: result.intent };
}

function isExpired(intent: RedeemIntent): boolean {
  return new Date(intent.expiresAt).getTime() < Date.now();
}

// ----------------------------- 2. Execute (idempotent) ------------------------

/**
 * Idempotent execution endpoint — same shape as `prepareExecution()` for
 * deposits. Re-derives the allocation from this depositor's CURRENT
 * position/holdings and compares fingerprints: for a redemption, what can
 * go stale between quote and execute is THIS depositor's own
 * shares/holdings changing (another purchase or redemption completing) —
 * not the Bag's recipe, which a redemption never reads (see
 * redeem/allocation.ts's module doc).
 */
export async function prepareRedeemExecution(
  admin: SupabaseClient,
  session: SessionPayload,
  intentId: string
): Promise<RedeemExecutionOutcome<RedeemIntent>> {
  const owned = await loadOwnedIntent(admin, session.userId, intentId);
  if (!owned.ok) return owned;
  const intent = owned.value;

  if (intent.status !== 'READY' && intent.status !== 'QUOTED' && intent.status !== 'DRAFT') {
    return { ok: true, value: intent };
  }

  if (isExpired(intent)) {
    await updateRedeemIntentStatus(admin, { id: intentId, from: intent.status, to: 'EXPIRED', failureCode: 'ROUTE_EXPIRED' });
    return { ok: false, error: { kind: 'EXPIRED' } };
  }

  const bag = await getBagById(admin, intent.bagId);
  if (!bag) {
    await updateRedeemIntentStatus(admin, { id: intentId, from: intent.status, to: 'FAILED', failureCode: 'UNSUPPORTED_ROUTE' });
    return { ok: false, error: { kind: 'ROUTE_CHANGED' } };
  }

  // This legacy path sells through LI.FI straight to the user's wallet, so a
  // performance fee could never be collected on it — and recording one here
  // would have the protocol pay the creator out of its own pocket. A Bag with
  // a fee is redeemed only through RedeemFeeRouter (attest-fee +
  // confirm-router-tx), which settles the fee atomically. The creator's own
  // redemptions carry no fee (apply_redeem_execution skips creator == user).
  if (bag.creatorId !== session.userId) {
    const feeVersion = await getCurrentBagVersion(admin, intent.bagId);
    const feeBps = bag.performanceFeeBpsLocked ?? feeVersion?.recipe.performanceFeeBps ?? 0;
    if (feeBps > 0) return { ok: false, error: { kind: 'FEE_ROUTER_REQUIRED' } };
  }

  let currentFingerprint: string;
  try {
    const [position, holdings] = await Promise.all([
      getInvestorPosition(admin, session.userId, intent.bagId),
      getInvestorHoldings(admin, session.userId, intent.bagId),
    ]);
    const allocation = calculateRedeemAllocation({
      bagId: intent.bagId,
      sharesRaw: position.sharesRaw,
      sharesToRedeemRaw: intent.sharesRaw,
      outputAsset: intent.outputAsset,
      outputDecimals: intent.outputDecimals,
      holdings: holdings.map((h) => ({ chain: h.chain, address: h.address, decimals: h.decimals, quantityRaw: h.quantityRaw })),
    });
    const symbolByKey = new Map(intent.steps.map((s) => [`${s.inputAsset.chain}:${s.inputAsset.address.toLowerCase()}`, s.targetSymbol]));
    const executionSteps = buildRedeemExecutionSteps(
      allocation,
      intent.outputAsset,
      (asset) => symbolByKey.get(`${asset.chain}:${asset.address.toLowerCase()}`) ?? ''
    );
    currentFingerprint = computeRedeemFingerprint({
      bagId: intent.bagId,
      sharesToRedeemRaw: intent.sharesRaw,
      outputAsset: intent.outputAsset,
      steps: executionSteps,
    });
  } catch {
    // Position/holdings changed enough that the SAME allocation can no
    // longer be recomputed (e.g. insufficient shares now, or a holding
    // this intent's steps depended on has since been fully redeemed
    // elsewhere) — this intent cannot be executed as quoted.
    await updateRedeemIntentStatus(admin, { id: intentId, from: intent.status, to: 'FAILED', failureCode: 'ROUTE_EXPIRED' });
    return { ok: false, error: { kind: 'ROUTE_CHANGED' } };
  }

  if (currentFingerprint !== intent.routeFingerprint) {
    await updateRedeemIntentStatus(admin, { id: intentId, from: intent.status, to: 'FAILED', failureCode: 'ROUTE_EXPIRED' });
    return { ok: false, error: { kind: 'ROUTE_CHANGED' } };
  }

  const toStatus = intent.status === 'DRAFT' ? 'QUOTED' : intent.status === 'QUOTED' ? 'READY' : 'AWAITING_SIGNATURE';
  const updated = await updateRedeemIntentStatus(admin, { id: intentId, from: intent.status, to: toStatus });
  if (!updated) {
    const latest = await getRedeemIntentForUser(admin, intentId, session.userId);
    return latest.ok ? { ok: true, value: latest.intent } : { ok: false, error: { kind: 'NOT_FOUND' } };
  }

  if (updated.status !== 'AWAITING_SIGNATURE') {
    return prepareRedeemExecution(admin, session, intentId);
  }

  return { ok: true, value: updated };
}

// ----------------------------- 3. Per-step client report -----------------------

export type RedeemStepReportEvent =
  | { type: 'APPROVAL_REQUIRED' }
  | { type: 'APPROVAL_AWAITING_SIGNATURE' }
  | { type: 'APPROVAL_SUBMITTED'; txHash: string }
  | { type: 'APPROVAL_CONFIRMED' }
  | { type: 'AWAITING_SIGNATURE' }
  | { type: 'SUBMITTED'; txHash: string }
  | { type: 'REJECTED'; failureCode: 'USER_REJECTED' }
  | { type: 'FAILED'; failureCode: RedeemIntentFailureCode; message?: string };

/**
 * Same role and same "cannot mark COMPLETED" restriction as
 * `recordStepEvent()` on the deposit side — see that function's doc
 * comment, which applies here verbatim.
 */
export async function recordRedeemStepEvent(
  admin: SupabaseClient,
  session: SessionPayload,
  intentId: string,
  stepIndex: number,
  event: RedeemStepReportEvent
): Promise<RedeemExecutionOutcome<RedeemIntent>> {
  const owned = await loadOwnedIntent(admin, session.userId, intentId);
  if (!owned.ok) return owned;
  const intent = owned.value;

  if (intent.status !== 'AWAITING_SIGNATURE' && intent.status !== 'SUBMITTED') {
    return { ok: false, error: { kind: 'INVALID_STATE', status: intent.status } };
  }

  const step = intent.steps[stepIndex];
  if (!step) return { ok: false, error: { kind: 'NOT_FOUND' } };
  if (step.action !== 'SWAP') return { ok: false, error: { kind: 'INVALID_STATE', status: step.status } };

  const nextStepStatus = event.type === 'REJECTED' || event.type === 'FAILED' ? 'FAILED' : event.type;

  if (!isValidPurchaseIntentStepTransition(step.status, nextStepStatus)) {
    return { ok: false, error: { kind: 'INVALID_STATE', status: step.status } };
  }
  assertValidPurchaseIntentStepTransition(stepIndex, step.status, nextStepStatus);

  if ((event.type === 'SUBMITTED' || event.type === 'APPROVAL_SUBMITTED') && !TX_HASH_RE.test(event.txHash)) {
    return { ok: false, error: { kind: 'INVALID_TX_HASH' } };
  }
  // The hash is only stored here; it is claimed for this intent once the
  // transaction verifies as this intent's own (see intent-tx-claims.ts).

  const updatedStep: RedeemIntentStepRecord = {
    ...step,
    status: nextStepStatus,
    approvalTxHash: event.type === 'APPROVAL_SUBMITTED' ? event.txHash : step.approvalTxHash,
    txHash: event.type === 'SUBMITTED' ? event.txHash : step.txHash,
    failureCode: event.type === 'REJECTED' ? event.failureCode : event.type === 'FAILED' ? event.failureCode : step.failureCode,
  };

  const nextSteps = intent.steps.map((s, i) => (i === stepIndex ? updatedStep : s));
  const updatedIntent = await updateRedeemIntentSteps(admin, intentId, intent.status, nextSteps);
  if (!updatedIntent) return { ok: false, error: { kind: 'INVALID_STATE', status: intent.status } };

  if (event.type === 'SUBMITTED' && updatedIntent.status === 'AWAITING_SIGNATURE') {
    const advanced = await updateRedeemIntentStatus(admin, { id: intentId, from: 'AWAITING_SIGNATURE', to: 'SUBMITTED' });
    if (advanced) return { ok: true, value: advanced };
  }

  if (nextStepStatus === 'FAILED') {
    const anotherStepAlreadySubmitted = updatedIntent.steps.some((s, i) => i !== stepIndex && s.action === 'SWAP' && s.txHash !== null);
    if (!anotherStepAlreadySubmitted) {
      const failureCode = event.type === 'REJECTED' ? event.failureCode : event.type === 'FAILED' ? event.failureCode : 'UNKNOWN_ERROR';
      const failed = await updateRedeemIntentStatus(admin, { id: intentId, from: updatedIntent.status, to: 'FAILED', failureCode });
      if (failed) return { ok: true, value: failed };
    }
  }

  return { ok: true, value: updatedIntent };
}

// ----------------------------- 4. Verify + accounting (idempotent) -------------

/**
 * Same polling + mixed-outcome handling as `verifyExecution()` for
 * deposits — see that function's doc comment, which applies here
 * verbatim. Only the terminal accounting calls differ: `apply_redeem_
 * execution()` (burn) and `apply_partial_redeem_execution()` (mixed
 * outcome) instead of their mint-side counterparts.
 */
export async function verifyRedeemExecution(
  admin: SupabaseClient,
  session: SessionPayload,
  intentId: string
): Promise<RedeemExecutionOutcome<RedeemIntent>> {
  const owned = await loadOwnedIntent(admin, session.userId, intentId);
  if (!owned.ok) return owned;
  let intent = owned.value;

  if (
    intent.status === 'COMPLETED' ||
    intent.status === 'RECONCILIATION_REQUIRED' ||
    intent.status === 'FAILED' ||
    intent.status === 'CANCELLED' ||
    intent.status === 'EXPIRED'
  ) {
    return { ok: true, value: intent };
  }
  if (intent.status === 'PARTIAL_SUCCESS') {
    return { ok: true, value: await reconcilePartialRedeem(admin, intent) };
  }
  if (intent.status !== 'SUBMITTED' && intent.status !== 'CONFIRMING') {
    return { ok: false, error: { kind: 'INVALID_STATE', status: intent.status } };
  }

  const verifiedSteps: RedeemIntentStepRecord[] = await Promise.all(
    intent.steps.map(async (step): Promise<RedeemIntentStepRecord> => {
      if (step.action === 'KEEP' || step.status === 'COMPLETED' || step.status === 'FAILED') return step;
      if (!step.txHash) return step;

      const outcome = await trackStepStatus({
        txHash: step.txHash,
        sourceChain: step.sourceChain,
        destinationChain: step.destinationChain,
        tool: step.route,
        expectedOutputAsset: step.outputAsset,
        expectedWallet: intent.walletAddress,
        expectedInputAsset: step.inputAsset,
        expectedInputAmountRaw: step.inputAmountRaw,
        minOutputRaw: step.minOutputRaw,
      });

      if (outcome.kind === 'PENDING') {
        return { ...step, status: 'CONFIRMING', providerSubstatus: outcome.substatus };
      }
      if (outcome.kind === 'FAILED') {
        return { ...step, status: 'FAILED', failureCode: outcome.failureCode };
      }
      if (!outcome.matchesExpectedAsset) {
        return { ...step, status: 'FAILED', failureCode: 'VERIFICATION_FAILED' };
      }
      return {
        ...step,
        status: 'COMPLETED',
        providerSubstatus: 'COMPLETED',
        outputAmountRaw: outcome.receivedAmountRaw ?? step.outputAmountRaw,
      };
    })
  );

  // A step's hash is claimed only now, after it verified as this intent's
  // own transaction; if another intent already holds it, the step fails.
  const nextSteps = await claimNewlyVerifiedTxHashes(admin, 'REDEEM', intentId, intent.steps, verifiedSteps, (step) => ({
    ...step,
    status: 'FAILED' as const,
    failureCode: 'VERIFICATION_FAILED' as const,
  }));

  const stepsChanged = JSON.stringify(nextSteps) !== JSON.stringify(intent.steps);
  if (stepsChanged) {
    const updated = await updateRedeemIntentSteps(admin, intentId, intent.status, nextSteps);
    if (updated) intent = updated;
  }

  const swapSteps = intent.steps.filter((s) => s.action === 'SWAP');
  const stillInFlight = swapSteps.some((s) => s.status !== 'COMPLETED' && s.status !== 'FAILED');

  if (stillInFlight) {
    if (intent.status === 'SUBMITTED') {
      const confirming = await updateRedeemIntentStatus(admin, { id: intentId, from: 'SUBMITTED', to: 'CONFIRMING' });
      return { ok: true, value: confirming ?? intent };
    }
    return { ok: true, value: intent };
  }

  const anyCompleted = swapSteps.some((s) => s.status === 'COMPLETED');
  const anyFailed = swapSteps.some((s) => s.status === 'FAILED');

  if (anyFailed && anyCompleted) {
    const partial = await updateRedeemIntentStatus(admin, { id: intentId, from: intent.status, to: 'PARTIAL_SUCCESS' });
    return { ok: true, value: await reconcilePartialRedeem(admin, partial ?? intent) };
  }

  if (anyFailed) {
    // Every SWAP leg failed — nothing was ever sold, so plain FAILED (no
    // accounting at all — nothing burned, nothing removed) is correct.
    const failedStep = swapSteps.find((s) => s.status === 'FAILED');
    const failed = await updateRedeemIntentStatus(admin, {
      id: intentId,
      from: intent.status,
      to: 'FAILED',
      failureCode: failedStep?.failureCode ?? 'UNKNOWN_ERROR',
    });
    return { ok: true, value: failed ?? intent };
  }

  // Every SWAP leg COMPLETED (KEEP legs are always NOT_NEEDED/trivially
  // done). Legs already confirmed by the FIRST verify arrive here straight
  // from SUBMITTED; COMPLETED is only reachable from CONFIRMING, so step
  // through it first — before accounting — same as purchase-execution.ts.
  if (intent.status === 'SUBMITTED') {
    const confirming = await updateRedeemIntentStatus(admin, { id: intentId, from: 'SUBMITTED', to: 'CONFIRMING' });
    if (!confirming) return { ok: true, value: intent };
    intent = confirming;
  }

  // Apply the FULL burn accounting exactly once.
  if (!intent.accountingAppliedAt) {
    await applyRedeemAccountingIdempotently(admin, intent);
  }
  // Fresh NAV snapshot so listings show the new TVL right away. Best effort:
  // a pricing hiccup here never affects the purchase/redemption outcome.
  await recordNavSnapshot(admin, intent.bagId, { minIntervalMs: 0 }).catch(() => undefined);

  const completed = await updateRedeemIntentStatus(admin, {
    id: intentId,
    from: intent.status,
    to: 'COMPLETED',
    executedAt: new Date().toISOString(),
  });
  return { ok: true, value: completed ?? intent };
}

/**
 * Removes ONLY the verifiably-sold holdings for a mixed-outcome intent —
 * never touches shares/cost basis. See `apply_partial_redeem_execution()`'s
 * own doc (supabase/migrations/0012_add_redeem_execution.sql) for why
 * inventing a partial burn amount here would be worse than leaving this
 * state visible for a follow-up process, same reasoning
 * `reconcilePartialExecution()` documents on the deposit side.
 */
async function reconcilePartialRedeem(admin: SupabaseClient, intent: RedeemIntent): Promise<RedeemIntent> {
  if (!intent.reconciliationAppliedAt) {
    const soldHoldings = intent.steps
      .filter((s) => s.action === 'SWAP' && s.status === 'COMPLETED')
      .map((s) => ({ chain: s.inputAsset.chain, address: s.inputAsset.address, quantity_raw: s.inputAmountRaw }));

    const { error: partialRpcError } = await admin.rpc('apply_partial_redeem_execution', {
      p_intent_id: intent.id,
      p_bag_id: intent.bagId,
      p_holdings_sold: soldHoldings,
      p_user_id: intent.userId,
    });
    if (partialRpcError) throw new Error(`apply_partial_redeem_execution failed: ${partialRpcError.message}`);

    await markRedeemReconciliationApplied(admin, intent.id);
  }

  const reconciled = await updateRedeemIntentStatus(admin, { id: intent.id, from: 'PARTIAL_SUCCESS', to: 'RECONCILIATION_REQUIRED' });
  return reconciled ?? intent;
}

/**
 * Applies the burn + holdings-removal accounting for one fully-verified
 * redeem intent, via the atomic, self-idempotent `apply_redeem_execution()`
 * RPC — see that function's own doc (supabase/migrations/
 * 0012_add_redeem_execution.sql) for the row-lock + re-validation ordering
 * that makes it safe even if two `verifyRedeemExecution()` calls race.
 */
async function applyRedeemAccountingIdempotently(admin: SupabaseClient, intent: RedeemIntent): Promise<void> {
  if (intent.accountingAppliedAt) return;

  // Every SWAP leg sells its OWN input asset — `inputAmountRaw` is the
  // exact quantity `calculateRedeemAllocation()` computed at quote time,
  // which is what's being removed regardless of the swap's actual output
  // (unlike a purchase, where the CREDITED side is the swap's output —
  // here the DEBITED side is the swap's input, fixed at quote time, not
  // something on-chain execution can vary).
  const soldFromSwaps = intent.steps
    .filter((s) => s.action === 'SWAP' && s.status === 'COMPLETED')
    .map((s) => ({ chain: s.inputAsset.chain, address: s.inputAsset.address, quantity_raw: s.inputAmountRaw }));

  // KEEP legs also remove exactly what was earmarked (already the output
  // asset — nothing was swapped, but the depositor's holding of it is
  // still leaving their position on this redemption).
  const soldFromKeeps = intent.steps
    .filter((s) => s.action === 'KEEP')
    .map((s) => ({ chain: s.inputAsset.chain, address: s.inputAsset.address, quantity_raw: s.inputAmountRaw }));

  const holdingsSold = [...soldFromSwaps, ...soldFromKeeps];

  // Phase 22 — performance fee. Resolved fresh here (never trusted from
  // the intent/client) from the bag's OWN creator + fee, same "re-read the
  // authoritative source at execute time" discipline the rest of this file
  // already uses for prices/NAV. Once an external investor exists the fee is
  // LOCKED (migration 0033) and apply_redeem_execution() itself uses the
  // locked rate; passing it here too keeps both sides saying the same thing.
  const bag = await getBagById(admin, intent.bagId);
  const version = await getCurrentBagVersion(admin, intent.bagId);
  const performanceFeeBps = bag?.performanceFeeBpsLocked ?? version?.recipe.performanceFeeBps ?? 0;

  const { error: rpcError } = await admin.rpc('apply_redeem_execution', {
    p_intent_id: intent.id,
    p_bag_id: intent.bagId,
    p_holdings_sold: holdingsSold,
    p_shares_burn_raw: intent.sharesRaw,
    p_share_decimals: intent.shareDecimals,
    p_user_id: intent.userId,
    p_redeem_value_quote: intent.redeemValueQuote,
    p_performance_fee_bps: performanceFeeBps,
    p_creator_id: bag?.creatorId ?? null,
  });
  if (rpcError) throw new Error(`apply_redeem_execution failed: ${rpcError.message}`);

  await markRedeemAccountingApplied(admin, intent.id);
}
