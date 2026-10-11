import { liveSettlementAttestationFor } from '@/lib/server/fee-redemption-lock';
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
import { listAssets } from '@/lib/server/asset-repo';
import { getPriceProvider } from '@/lib/server/price-provider';
import { InsufficientSharesError, getRedeemQuote, ZeroRedeemAmountError, ZeroShareSupplyError } from '@/lib/domain/basket-protocol/shares/shares';
import {
  InvalidRedeemFractionError,
  assertValidFractionBps,
  calculateRedeemAllocation,
  buildRedeemExecutionSteps,
  sharesToBurnForFraction,
} from '@/lib/domain/basket-protocol/redeem/allocation';
import { estimatedProceedsRaw } from '@/lib/domain/basket-protocol/redeem/proceeds';
import { observeUserHoldings, sellableHoldingsForBag } from '@/lib/server/position-valuation';
import { getChainPublicClient } from '@/lib/blockchain/rpc/clients';
import { checkSaleCoverage, saleStillCovered } from '@/lib/server/sale-coverage';
import { computeRedeemFingerprint } from '@/lib/domain/basket-protocol/redeem/fingerprint';
import {
  assertValidPurchaseIntentStepTransition,
  isValidPurchaseIntentStepTransition,
} from '@/lib/domain/basket-protocol/purchase-intent/state-machine';
import { buildPurchaseIntentSteps } from '@/lib/blockchain/lifi-purchase-quote';
import { trackStepStatus } from '@/lib/blockchain/lifi-status';
import { trackComposerTransaction } from '@/lib/blockchain/composer-status';
import { findComposerTransactionFromWallet } from '@/lib/blockchain/composer-tx-search';
import { isBagChain } from '@/lib/config/chains';
import { DEPLOYED_CONTRACTS } from '@/lib/config/robinhood-chain';
import { readSettlementResult } from '@/lib/blockchain/redeem-settlement-event';
import { computeOnChainBagId } from '@/lib/domain/basket-protocol/onchain';
import { buildRedeemComposer, splitReceivedAcrossLegs } from '@/lib/server/redeem-composer';
import { formatDec, mulDiv, parseDec, rawToDecimalString } from '@/lib/domain/basket-protocol/accounting/decimal';
import {
  createRedeemIntent as insertRedeemIntent,
  findActiveRedeemIntentForBag,
  getRedeemIntentForUser,
  markRedeemAccountingApplied,
  markRedeemReconciliationApplied,
  recordRedeemSettlementResult,
  updateRedeemIntentStatus,
  updateRedeemIntentSteps,
  type CreateRedeemIntentInput,
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
  | { kind: 'REDEEM_IN_PROGRESS'; intentId: string; /** Set when a still-valid settlement attestation is the blocker: when it lapses. */ retryAfterSeconds?: number }
  | { kind: 'NOT_FOUND' }
  | { kind: 'FORBIDDEN' }
  | { kind: 'EXPIRED' }
  | { kind: 'ROUTE_CHANGED' }
  | { kind: 'INVALID_STATE'; status: string }
  | { kind: 'INVALID_TX_HASH' }
  | { kind: 'TX_ALREADY_USED' }
  | { kind: 'FEE_ROUTER_REQUIRED' }
  | { kind: 'INVALID_FRACTION' }
  | { kind: 'NOTHING_TO_SELL' }
  | { kind: 'BALANCE_UNAVAILABLE' };

export type RedeemExecutionOutcome<T> = { ok: true; value: T } | { ok: false; error: RedeemExecutionError };

// ----------------------------- 1. Create ------------------------------------

export interface CreateRedeemIntentParams {
  admin: SupabaseClient;
  session: SessionPayload;
  bagId: string;
  /** A4: fraction of the position to exit, in basis points (10000 = everything sellable). */
  fractionBps: number;
  outputAssetId: string;
}

/**
 * Builds a fresh `RedeemIntent` that sells `fractionBps` of THIS depositor's
 * EFFECTIVE holdings (A4, docs/ACCOUNTING_V2_DESIGN.md §7): what BAG tracks
 * for them in this Bag, limited to what their wallet really holds right now
 * (balances read at one block, fail-closed — an unreadable balance refuses
 * the quote instead of assuming the tokens are there). Rejects outright if
 * this wallet already has a non-terminal redeem intent open for this bag,
 * same "don't let two exits race" guard `createPurchaseIntentForUser()` gives
 * deposits.
 */
export async function createRedeemIntentForUser(params: CreateRedeemIntentParams): Promise<RedeemExecutionOutcome<RedeemIntent>> {
  const { admin, session, bagId, fractionBps, outputAssetId } = params;

  try {
    assertValidFractionBps(fractionBps);
  } catch {
    return { ok: false, error: { kind: 'INVALID_FRACTION' } };
  }

  const existing = await findActiveRedeemIntentForBag(admin, session.userId, bagId);
  if (existing) {
    const outcome = await releaseAbandonedRedeemIntent(admin, existing);
    let stillOpen = outcome === 'KEPT';
    if (outcome === 'RECOVERED') {
      // The sale did happen: book it now (verify is idempotent). Only a sale that reached a final state frees the
      // position for a new one.
      const verified = await verifyRedeemExecution(admin, session, existing.id);
      stillOpen = !verified.ok || !TERMINAL_REDEEM_STATUSES.has(verified.value.status);
    }
    if (stillOpen) return { ok: false, error: { kind: 'REDEEM_IN_PROGRESS', intentId: existing.id } };
  }
  // A settlement attestation still valid on-chain (§9) blocks a new sale of the position even when its intent is
  // already terminal in the database: the old signature could otherwise run after this sale changed the ledger.
  const liveAttestation = await liveSettlementAttestationFor(admin, session.userId, bagId);
  if (liveAttestation) {
    const { deadline } = liveAttestation;
    return {
      ok: false,
      error: {
        kind: 'REDEEM_IN_PROGRESS',
        intentId: liveAttestation.id,
        ...(typeof deadline === 'number' ? { retryAfterSeconds: Math.max(1, deadline - Math.floor(Date.now() / 1000)) } : {}),
      },
    };
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

  const [position, observed] = await Promise.all([
    getInvestorPosition(admin, session.userId, bagId),
    observeUserHoldings(admin, getChainPublicClient('robinhood'), session),
  ]);
  if (!observed.rows.some((r) => r.bagId === bagId)) {
    return { ok: false, error: { kind: 'NO_POSITION' } };
  }
  const sellable = sellableHoldingsForBag(observed, bagId);
  if (!sellable) return { ok: false, error: { kind: 'BALANCE_UNAVAILABLE' } };

  let allocation;
  try {
    allocation = calculateRedeemAllocation({
      bagId,
      fractionBps,
      outputAsset,
      outputDecimals: outputAssetRecord.decimals,
      holdings: sellable,
    });
  } catch (err) {
    if (err instanceof ZeroRedeemAmountError) return { ok: false, error: { kind: 'NOTHING_TO_SELL' } };
    if (err instanceof InvalidRedeemFractionError) return { ok: false, error: { kind: 'INVALID_FRACTION' } };
    throw err;
  }
  // Legacy share bookkeeping only (D1): burned in the same proportion, never used for value.
  const sharesBurnRaw = sharesToBurnForFraction(position.sharesRaw, fractionBps);

  const symbolByKey = new Map(assets.map((a) => [`${a.chain}:${a.address.toLowerCase()}`, a.symbol]));
  const symbolFor = (asset: AssetIdentity) => symbolByKey.get(`${asset.chain}:${asset.address.toLowerCase()}`) ?? '';
  const executionSteps = buildRedeemExecutionSteps(allocation, outputAsset, symbolFor);

  const ownBag = bag.creatorId === session.userId;
  const feeVersion = ownBag ? null : await getCurrentBagVersion(admin, bagId);
  const feeBps = ownBag ? 0 : (bag.performanceFeeBpsLocked ?? feeVersion?.recipe.performanceFeeBps ?? 0);

  // Same real, wallet-bound LI.FI quoting the deposit side uses — see
  // lib/blockchain/lifi-purchase-quote.ts's module doc on why this
  // function was narrowed to take `ExecutionStep[]` directly in this
  // phase (a redemption has no single top-level inputAsset/inputAmountRaw
  // an `ExecutionPlan` would otherwise require it to fabricate).
  // One transaction when it can be (LI.FI Composer), only where the per-asset
  // path would run at all: no RedeemFeeRouter configured (that path settles
  // fees itself) and no performance fee owed on this redemption.
  let composer: Awaited<ReturnType<typeof buildRedeemComposer>> = null;
  if (process.env.LIFI_API_KEY && !DEPLOYED_CONTRACTS.redeemFeeRouter && feeBps === 0) {
    composer = await buildRedeemComposer({
      steps: executionSteps,
      walletAddress: session.walletAddress,
      outputAsset,
      outputDecimals: outputAssetRecord.decimals,
      apiKey: process.env.LIFI_API_KEY,
    });
  }
  const { steps, allSwapsQuoted, firstFailure } = composer
    ? { steps: composer.steps, allSwapsQuoted: true, firstFailure: null }
    : await buildPurchaseIntentSteps(executionSteps, session.walletAddress, outputAssetRecord.decimals);

  // `redeemValueQuote` is the legacy fee basis of apply_redeem_execution (value − consumed share cost basis).
  // A performance-fee Bag keeps it NAV-based, exactly as RedeemFeeRouter's attestation expects (D4: fee
  // semantics change only in their own PR). Without a fee it is the route's estimated proceeds — no NAV
  // dependency on the sell path. Either way it is never realized P&L: that comes only from verified
  // receipts (accounting/position-pnl.ts).
  let redeemValueQuote: string;
  let sharePriceAtQuote: string;
  if (feeBps > 0) {
    if (sharesBurnRaw === '0') return { ok: false, error: { kind: 'NO_POSITION' } };
    const [navOutcome, shareSupply] = await Promise.all([getBagNavSafe(admin, bagId, priceProvider), getShareSupply(admin, bagId)]);
    if (!navOutcome.ok) return { ok: false, error: { kind: 'PRICE_UNAVAILABLE', message: navOutcome.message } };
    try {
      const redeemQuote = getRedeemQuote(navOutcome.nav, shareSupply, sharesBurnRaw);
      redeemValueQuote = redeemQuote.grossValue;
      sharePriceAtQuote = redeemQuote.sharePrice;
    } catch (err) {
      if (err instanceof ZeroShareSupplyError) return { ok: false, error: { kind: 'ZERO_SUPPLY' } };
      if (err instanceof InsufficientSharesError) {
        return { ok: false, error: { kind: 'INSUFFICIENT_POSITION', requestedRaw: err.requestedRaw, ownedRaw: err.availableRaw } };
      }
      throw err;
    }
  } else {
    const estimate = estimatedProceedsRaw(steps);
    redeemValueQuote = estimate === null ? '0' : rawToDecimalString(estimate, outputAssetRecord.decimals);
    sharePriceAtQuote =
      sharesBurnRaw === '0' ? '0' : formatDec(mulDiv(parseDec(redeemValueQuote), BigInt(10) ** BigInt(position.shareDecimals), BigInt(sharesBurnRaw)));
  }

  const fingerprint = computeRedeemFingerprint({ bagId, sharesToRedeemRaw: sharesBurnRaw, outputAsset, steps: executionSteps });
  const expiresAt = new Date(Date.now() + PURCHASE_INTENT_TTL_MS).toISOString();

  const intentInput: CreateRedeemIntentInput = {
    userId: session.userId,
    walletAddress: session.walletAddress,
    bagId,
    sharesRaw: sharesBurnRaw,
    shareDecimals: position.shareDecimals,
    outputAsset,
    outputDecimals: outputAssetRecord.decimals,
    routeFingerprint: fingerprint,
    sharePriceAtQuote,
    redeemValueQuote,
    steps,
    status: allSwapsQuoted ? 'READY' : 'FAILED',
    failureCode: allSwapsQuoted ? null : (firstFailure?.failureCode ?? 'UNKNOWN_ERROR'),
    expiresAt,
  };
  let intent: RedeemIntent;
  if (composer) {
    try {
      intent = await insertRedeemIntent(admin, { ...intentInput, composerTransaction: composer.composerTransaction });
    } catch {
      // Database without migration 0047 (no composer_transaction column): keep the per-asset sale.
      const sequential = await buildPurchaseIntentSteps(executionSteps, session.walletAddress, outputAssetRecord.decimals);
      if (!sequential.allSwapsQuoted && sequential.firstFailure) {
        return { ok: false, error: { kind: 'QUOTE_FAILED', failureCode: sequential.firstFailure.failureCode, message: sequential.firstFailure.message } };
      }
      intent = await insertRedeemIntent(admin, { ...intentInput, steps: sequential.steps });
    }
  } else {
    intent = await insertRedeemIntent(admin, intentInput);
  }

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

const TERMINAL_REDEEM_STATUSES: ReadonlySet<RedeemIntent['status']> = new Set(['COMPLETED', 'RECONCILIATION_REQUIRED', 'FAILED', 'CANCELLED', 'EXPIRED']);

/**
 * Extra time, after an intent's expiry, before a free sale awaiting signature counts as abandoned: the wallet may
 * still be open on it (expiry is a few minutes after the quote, signing can take longer).
 */
export const ABANDONED_FREE_SALE_GRACE_MS = 10 * 60 * 1000;

/**
 * An open sale nobody will finish — the wallet never signed and no report came back (tab closed, wallet dismissed
 * without a REJECTED report) — must not block the position forever. Released (→ EXPIRED) only when signing it can no
 * longer do anything:
 *  - not yet handed to the wallet (DRAFT / QUOTED / READY) and past its expiry: nothing was signed;
 *  - AWAITING_SIGNATURE of a settlement sale whose attestation deadline has passed: RedeemSettlement refuses the
 *    signed transaction after it (`deadline`, §8). The deadline is at most ~5 minutes after phase 2 (§9);
 *  - AWAITING_SIGNATURE of a free Composer sale, past its expiry plus ABANDONED_FREE_SALE_GRACE_MS, once the chain
 *    shows the built transaction was never sent (#27). It has no on-chain deadline of ours, so the chain is asked
 *    first (composer-tx-search.ts): found → the sale happened, it is recovered as SUBMITTED and booked by verify
 *    ('RECOVERED'); not found, with nothing pending from the wallet → released; the chain cannot answer → kept.
 * SUBMITTED / CONFIRMING are never touched here. The live-attestation lock is still checked by the caller.
 */
async function releaseAbandonedRedeemIntent(admin: SupabaseClient, intent: RedeemIntent): Promise<'RELEASED' | 'RECOVERED' | 'KEPT'> {
  const beforeWallet = intent.status === 'DRAFT' || intent.status === 'QUOTED' || intent.status === 'READY';
  const deadline = intent.settlementPlan?.deadline;
  const settlementLapsed = intent.status === 'AWAITING_SIGNATURE' && typeof deadline === 'number' && deadline < Math.floor(Date.now() / 1000);

  if (!(beforeWallet && isExpired(intent)) && !settlementLapsed) {
    const freeComposerSale = intent.status === 'AWAITING_SIGNATURE' && !intent.settlementPlan && !!intent.composerTransaction;
    const abandoned = new Date(intent.expiresAt).getTime() + ABANDONED_FREE_SALE_GRACE_MS < Date.now();
    if (!freeComposerSale || !abandoned || !intent.composerTransaction) return 'KEPT';
    const swaps = intent.steps.filter((s) => s.action === 'SWAP');
    const chain = swaps[0]?.sourceChain;
    if (!chain || !isBagChain(chain)) return 'KEPT';
    const search = await findComposerTransactionFromWallet({
      chain,
      wallet: intent.walletAddress,
      soldTokens: [...new Set(swaps.map((s) => s.inputAsset.address))],
      expected: intent.composerTransaction,
      since: new Date(intent.createdAt),
    });
    if (search.kind === 'UNKNOWN') return 'KEPT';
    if (search.kind === 'FOUND') {
      const steps = intent.steps.map((s) =>
        s.action === 'SWAP' && s.status !== 'COMPLETED' && s.status !== 'FAILED' ? { ...s, status: 'SUBMITTED' as const, txHash: s.txHash ?? search.txHash } : s
      );
      const recovered = await updateRedeemIntentStatus(admin, { id: intent.id, from: 'AWAITING_SIGNATURE', to: 'SUBMITTED', steps });
      return recovered ? 'RECOVERED' : 'KEPT';
    }
  }
  const released = await updateRedeemIntentStatus(admin, { id: intent.id, from: intent.status, to: 'EXPIRED', failureCode: 'ROUTE_EXPIRED' });
  return released !== null ? 'RELEASED' : 'KEPT';
}

/** What happened to an open sale the user asked to close (cancelOpenRedeemIntent). */
export type CloseOpenSaleResult =
  | { result: 'CLOSED'; status: RedeemIntent['status'] }
  | { result: 'BOOKED'; status: RedeemIntent['status'] }
  | { result: 'ALREADY_FINAL'; status: RedeemIntent['status'] }
  | { result: 'REFUSED'; status: RedeemIntent['status']; reason: string };

/**
 * Closes an open sale of the user's at their explicit request, so it stops blocking a new one — but only once the
 * chain shows its transaction cannot still land unbooked:
 *  - not yet handed to the wallet (DRAFT / QUOTED / READY): cancelled, nothing was signed;
 *  - a fee-paying sale awaiting signature: refused while its attestation is valid (it can be signed again), expired
 *    after (RedeemSettlement refuses the transaction then), cancelled if phase 2 never signed one;
 *  - a free Composer sale awaiting signature: the chain is searched for its transaction (composer-tx-search.ts);
 *    found → recovered and booked by verify, not found → cancelled, cannot tell → refused with the reason;
 *  - anything with a transaction already reported, SUBMITTED or CONFIRMING: verified, never cancelled.
 */
export async function cancelOpenRedeemIntent(admin: SupabaseClient, session: SessionPayload, intentId: string): Promise<RedeemExecutionOutcome<CloseOpenSaleResult>> {
  const owned = await loadOwnedIntent(admin, session.userId, intentId);
  if (!owned.ok) return owned;
  const intent = owned.value;
  const close = async (to: 'CANCELLED' | 'EXPIRED'): Promise<RedeemExecutionOutcome<CloseOpenSaleResult>> => {
    const updated = await updateRedeemIntentStatus(admin, { id: intent.id, from: intent.status, to, failureCode: to === 'EXPIRED' ? 'ROUTE_EXPIRED' : null });
    return updated
      ? { ok: true, value: { result: 'CLOSED', status: updated.status } }
      : { ok: true, value: { result: 'REFUSED', status: intent.status, reason: 'The sale changed while it was being closed. Try again.' } };
  };
  const verifyIt = async (): Promise<RedeemExecutionOutcome<CloseOpenSaleResult>> => {
    const verified = await verifyRedeemExecution(admin, session, intent.id);
    if (verified.ok && TERMINAL_REDEEM_STATUSES.has(verified.value.status)) return { ok: true, value: { result: 'BOOKED', status: verified.value.status } };
    return { ok: true, value: { result: 'REFUSED', status: verified.ok ? verified.value.status : intent.status, reason: 'A transaction of this sale was sent and is still being verified on-chain; it closes on its own once it is.' } };
  };

  if (TERMINAL_REDEEM_STATUSES.has(intent.status)) return { ok: true, value: { result: 'ALREADY_FINAL', status: intent.status } };
  const swaps = intent.steps.filter((s) => s.action === 'SWAP');
  if (intent.status === 'SUBMITTED' || intent.status === 'CONFIRMING' || swaps.some((s) => s.txHash !== null)) return verifyIt();
  if (intent.status === 'DRAFT' || intent.status === 'QUOTED' || intent.status === 'READY') return close('CANCELLED');
  if (intent.status !== 'AWAITING_SIGNATURE') {
    return { ok: true, value: { result: 'REFUSED', status: intent.status, reason: `A sale in status ${intent.status} cannot be closed here.` } };
  }

  if (intent.settlementPlan) {
    const deadline = intent.settlementPlan.deadline;
    if (typeof deadline !== 'number') return close('CANCELLED'); // phase 2 never signed: nothing valid exists
    if (deadline >= Math.floor(Date.now() / 1000)) {
      return { ok: true, value: { result: 'REFUSED', status: intent.status, reason: `This sale's signed settlement is valid until ${new Date(deadline * 1000).toISOString()}; sign it again, or it closes then.` } };
    }
    return close('EXPIRED');
  }

  if (intent.composerTransaction) {
    const chain = swaps[0]?.sourceChain;
    if (!chain || !isBagChain(chain)) return { ok: true, value: { result: 'REFUSED', status: intent.status, reason: 'The sale has no chain to search.' } };
    const search = await findComposerTransactionFromWallet({
      chain,
      wallet: intent.walletAddress,
      soldTokens: [...new Set(swaps.map((s) => s.inputAsset.address))],
      expected: intent.composerTransaction,
      since: new Date(intent.createdAt),
    });
    if (search.kind === 'UNKNOWN') {
      return { ok: true, value: { result: 'REFUSED', status: intent.status, reason: `The chain could not confirm that this sale was never sent (${search.reason}). Try again in a minute.` } };
    }
    if (search.kind === 'FOUND') {
      const steps = intent.steps.map((s) =>
        s.action === 'SWAP' && s.status !== 'COMPLETED' && s.status !== 'FAILED' ? { ...s, status: 'SUBMITTED' as const, txHash: s.txHash ?? search.txHash } : s
      );
      const recovered = await updateRedeemIntentStatus(admin, { id: intent.id, from: 'AWAITING_SIGNATURE', to: 'SUBMITTED', steps });
      if (!recovered) return { ok: true, value: { result: 'REFUSED', status: intent.status, reason: 'The sale changed while it was being closed. Try again.' } };
      return verifyIt();
    }
    return close('CANCELLED');
  }

  // Per-asset LI.FI sale with nothing reported sent.
  return close('CANCELLED');
}

export { saleStillCovered };

// ----------------------------- 2. Execute (idempotent) ------------------------

/**
 * Idempotent execution endpoint — same shape as `prepareExecution()` for
 * deposits. Before the wallet is asked to sign, re-checks that every leg is
 * still covered by THIS depositor's tracked holdings and by what their
 * wallet effectively holds now (`saleStillCovered`) — not the Bag's recipe,
 * which a redemption never reads (see redeem/allocation.ts's module doc).
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

  // A4: refuse to sign a sale of anything that is no longer really there (lib/server/sale-coverage.ts). An
  // unreadable balance does not fail the intent; the user can retry once the chain answers.
  const coverage = await checkSaleCoverage(admin, session, intent);
  if (coverage === 'BALANCE_UNAVAILABLE') return { ok: false, error: { kind: 'BALANCE_UNAVAILABLE' } };
  if (coverage === 'NOT_COVERED') {
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

  const verifiedSteps: RedeemIntentStepRecord[] = intent.composerTransaction
    ? await verifyComposerRedeemSteps(admin, intent, intent.composerTransaction)
    : await Promise.all(
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
 * Verifies a one-transaction (Composer) redemption: one receipt covers every SWAP leg, so they complete or fail
 * together. The reported hash must be exactly the transaction built for this intent (composer-status.ts), it
 * must have succeeded, every sold token must have left the wallet in full, and the output token must have
 * arrived. What arrived is split across the legs for display; accounting debits inputs, never outputs.
 */
async function verifyComposerRedeemSteps(
  admin: SupabaseClient,
  intent: RedeemIntent,
  composerTransaction: NonNullable<RedeemIntent['composerTransaction']>
): Promise<RedeemIntentStepRecord[]> {
  const swaps = intent.steps.filter((s) => s.action === 'SWAP');
  if (swaps.every((s) => s.status === 'COMPLETED' || s.status === 'FAILED')) return intent.steps;
  const txHash = swaps.find((s) => s.txHash)?.txHash;
  if (!txHash) return intent.steps;

  const outcome = await trackComposerTransaction({ txHash, chain: swaps[0].sourceChain, recipient: intent.walletAddress, expectedTransaction: composerTransaction });
  const markSwaps = (patch: Partial<RedeemIntentStepRecord>) => intent.steps.map((s) => (s.action === 'SWAP' ? { ...s, txHash: s.txHash ?? txHash, ...patch } : s));
  if (outcome.kind === 'PENDING') return markSwaps({ status: 'CONFIRMING' });
  if (outcome.kind === 'FAILED') return markSwaps({ status: 'FAILED', failureCode: outcome.failureCode });

  const soldInFull = swaps.every((s) => BigInt(outcome.sentAmountsByAddress[s.inputAsset.address.toLowerCase()] ?? '0') >= BigInt(s.inputAmountRaw));
  let received = BigInt(outcome.receivedAmountsByAddress[intent.outputAsset.address.toLowerCase()] ?? '0');
  if (!soldInFull || received <= BigInt(0)) return markSwaps({ status: 'FAILED', failureCode: 'VERIFICATION_FAILED' });

  // A fee-paying sale settled through RedeemSettlement (§9): the contract's Settled event for THIS redemption is the
  // source of truth — what arrived, the fee it computed and paid to the creator, what the user got. Without it, or
  // with a user other than this wallet, the sale is not verified. The legs carry the GROSS amount (`received`): the
  // fee is ledgered separately from the event (FEE_CHARGED, 0054), as a database-booked fee always was, so realized
  // P&L and the high-water mark stay on the basis the contract charged on.
  const plan = intent.settlementPlan;
  if (plan?.attestedAt) {
    // Every one of these must hold: the transaction succeeded; the event came from the deployed RedeemSettlement
    // (the plan's address, which must still be the configured one); exactly one event for THIS redemption id; and
    // it settled what was attested — this wallet, this creator, this context.
    const deployed = DEPLOYED_CONTRACTS.redeemSettlement;
    if (!deployed || deployed.toLowerCase() !== plan.settlement.toLowerCase()) return markSwaps({ status: 'FAILED', failureCode: 'VERIFICATION_FAILED' });
    const settled = await readSettlementResult(txHash as `0x${string}`, plan.settlement, computeOnChainBagId(intent.id));
    const matches =
      settled !== null &&
      settled.user.toLowerCase() === intent.walletAddress.toLowerCase() &&
      settled.creator.toLowerCase() === plan.creator.toLowerCase() &&
      settled.contextHash.toLowerCase() === plan.contextHash.toLowerCase();
    if (!settled || !matches) return markSwaps({ status: 'FAILED', failureCode: 'VERIFICATION_FAILED' });
    received = BigInt(settled.received);
    await recordRedeemSettlementResult(admin, intent.id, {
      ...plan,
      result: {
        txHash: settled.txHash || txHash,
        blockNumber: settled.blockNumber,
        logIndex: settled.logIndex,
        received: settled.received,
        feeBase: settled.feeBase,
        fee: settled.fee,
        userProceeds: settled.userProceeds,
        creator: settled.creator,
        executor: settled.executor,
      },
    });
  }

  const parts = splitReceivedAcrossLegs(received, swaps.map((s) => s.outputAmountRaw));
  return intent.steps.map((s) =>
    s.action === 'SWAP' ? { ...s, txHash: s.txHash ?? txHash, status: 'COMPLETED', providerSubstatus: 'COMPLETED', outputAmountRaw: parts[swaps.indexOf(s)] } : s
  );
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
  // A3: each sold leg carries what it actually returned (verified receipt output, in the output asset).
  const soldFromSwaps = intent.steps
    .filter((s) => s.action === 'SWAP' && s.status === 'COMPLETED')
    .map((s) => ({
      chain: s.inputAsset.chain,
      address: s.inputAsset.address,
      quantity_raw: s.inputAmountRaw,
      ...(s.outputAmountRaw && /^\d+$/.test(s.outputAmountRaw) ? { proceeds_quote: rawToDecimalString(s.outputAmountRaw, intent.outputDecimals) } : {}),
    }));

  // KEEP legs also remove exactly what was earmarked (already the output
  // asset — nothing was swapped, but the depositor's holding of it is
  // still leaving their position on this redemption).
  const soldFromKeeps = intent.steps
    .filter((s) => s.action === 'KEEP')
    .map((s) => ({
      chain: s.inputAsset.chain,
      address: s.inputAsset.address,
      quantity_raw: s.inputAmountRaw,
      // A KEEP leg already is the output asset: it returns itself.
      proceeds_quote: rawToDecimalString(s.inputAmountRaw, intent.outputDecimals),
    }));

  const holdingsSold = [...soldFromSwaps, ...soldFromKeeps];

  // Phase 22 — performance fee. Resolved fresh here (never trusted from
  // the intent/client) from the bag's OWN creator + fee, same "re-read the
  // authoritative source at execute time" discipline the rest of this file
  // already uses for prices/NAV. Once an external investor exists the fee is
  // LOCKED (migration 0033) and apply_redeem_execution() itself uses the
  // locked rate; passing it here too keeps both sides saying the same thing.
  const bag = await getBagById(admin, intent.bagId);
  const version = await getCurrentBagVersion(admin, intent.bagId);
  // A sale settled through RedeemSettlement already paid its fee on-chain: apply_redeem_execution (0054) sees the
  // attested plan on the intent row, books no database fee and ledgers the Settled event's fee instead.
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
