import { SupabaseClient } from '@supabase/supabase-js';
import { recordNavSnapshot } from '@/lib/server/bag-nav-snapshots';
import { AssetIdentity, BagRecord, BagVersionRecord, BasketRecipe, CanonicalAsset, DEFAULT_UNROUTABLE_POLICY, NavResult } from '@/types/basket-protocol';
import {
  ComposerFallbackNotice,
  MAX_ACCEPTABLE_PRICE_IMPACT_BPS,
  PRICE_IMPACT_ACCEPT_BUFFER_BPS,
  PurchaseIntent,
  PurchaseIntentFailureCode,
  PurchaseIntentFallback,
  PurchaseIntentStepRecord,
  PURCHASE_INTENT_TTL_MS,
  TERMINAL_PURCHASE_INTENT_STATUSES,
} from '@/types/purchase-intent';
import { SessionPayload } from '@/lib/auth/session';
import { getBagById, getCurrentBagVersion } from '@/lib/server/bag-repo';
import { claimNewlyVerifiedTxHashes, TX_HASH_RE } from '@/lib/server/intent-tx-claims';
import { purchaseInputAssetsFor } from '@/lib/server/payment-assets';
import { valuePayment } from '@/lib/server/payment-value';
import { FORK_ROYALTY_BPS } from '@/lib/config/rewards';
import { cancelPurchaseIfFeeSaleOpen, openFeeRedemptionFor } from '@/lib/server/fee-redemption-lock';
import { getBagAssetHoldings, getBagNavSafe, priceHoldingsIndividually } from '@/lib/server/bag-nav';
import { EXECUTION_QUOTE_PRICE_SOURCE, executionPricesFromLegs, navAtExecutionPrices } from '@/lib/domain/basket-protocol/shares/execution-valuation';
import { getPurchaseDepositQuote, OrphanedNavError, ZeroNavError } from '@/lib/domain/basket-protocol/shares/shares';
import type { DepositQuote, ShareSupply } from '@/types/basket-protocol';
import { getShareSupply } from '@/lib/server/bag-share-state-repo';
import { getVerifiedIdentityKeys, listAssets } from '@/lib/server/asset-repo';
import { getPriceProvider } from '@/lib/server/price-provider';
import { checkStockTokensForPurchase } from '@/lib/server/stock-token-guard';
import { computePurchasePreview, PurchasePreviewResult } from '@/lib/server/purchase-preview';
import { calculateDepositAllocation, InvalidRecipeWeightsError } from '@/lib/domain/basket-protocol/deposit/allocation';
import { buildExecutionPlan } from '@/lib/domain/basket-protocol/deposit/execution-plan';
import { validateRecipeAssetsAgainstRegistry } from '@/lib/domain/basket-protocol/validation/registry-validation';
import { assetIdentitiesEqual, recipeAssetIdentity } from '@/lib/domain/basket-protocol/asset-identity';
import { applyUnroutablePolicy, rawToDecimalString, scaleAmountRaw } from '@/lib/domain/basket-protocol/deposit/unroutable';
import { isValidDecimalString, toProtocolPrice } from '@/lib/domain/basket-protocol/pricing/price-precision';
import { checkAssetRoute } from '@/lib/server/asset-route-check';
import { computeExecutionPlanFingerprint } from '@/lib/domain/basket-protocol/purchase-intent/fingerprint';
import {
  assertValidPurchaseIntentStepTransition,
  isValidPurchaseIntentStepTransition,
} from '@/lib/domain/basket-protocol/purchase-intent/state-machine';
import { buildPurchaseIntentSteps, DEFAULT_COMPOSER_SLIPPAGE_BPS } from '@/lib/blockchain/lifi-purchase-quote';
import { trackStepStatus } from '@/lib/blockchain/lifi-status';
import { trackComposerTransaction } from '@/lib/blockchain/composer-status';
import { splitDecimal } from '@/lib/domain/basket-protocol/accounting/decimal';
import { trackBagRouterTransaction } from '@/lib/blockchain/bag-router-status';
import {
  createPurchaseIntent as insertPurchaseIntent,
  findActivePurchaseIntentForBag,
  listUnsettledPurchaseIntentsForUser,
  getPurchaseIntentForUser,
  markAccountingApplied,
  markReconciliationApplied,
  updatePurchaseIntentStatus,
  updatePurchaseIntentSteps,
} from '@/lib/server/purchase-intent-repo';
// -----------------------------------------------------------------------------
// BAG execution compiler integration (spec item — "purchase-execution.ts
// artık compileBagExecution() çağırıyor mu?"). Behind
// `BAG_EXECUTION_COMPILER_ENABLED` (feature-flag.ts): flag OFF takes the
// EXACT legacy `buildPurchaseIntentSteps()` path below, unchanged. Flag ON
// routes provider selection through `compileBagExecution()` instead — this
// file never picks Composer vs sequential itself (spec item 6: "purchase-
// execution.ts provider-specific routing yapmasın"), it only builds the
// provider-independent intent/graph, calls the compiler, and hands the
// result to `compiledExecutionToPurchaseIntentSteps()` to translate back
// into the SAME `PurchaseIntentStepRecord[]`/`composerTransaction` shape
// the legacy path already produces — nothing downstream of this function
// (persistence, verification, accounting) needs to know which path ran.
import { isBagExecutionCompilerEnabled } from '@/lib/config/execution';
import { buildBagExecutionGraph, purchaseIntentToBagExecutionIntent, computeBagExecutionGraphHash } from '@/lib/execution/plan';
import { compileBagExecution, compileBagExecutionCandidates } from '@/lib/execution/compiler';
import { buildDefaultProviders } from '@/lib/execution/registry';
import { compiledExecutionToPurchaseIntentSteps } from '@/lib/execution/purchase-intent-bridge';
import { BagExecutionError } from '@/lib/execution/errors';
import { BagExecutionIntent, ExecutionMode } from '@/lib/execution/types';
import { BagExecutionProvider } from '@/lib/execution/providers/types';
import { ExecutionCandidateSet, ExecutionCandidateView, toExecutionCandidateView } from '@/lib/execution/candidate-types';
import { annotateCandidateMetrics } from '@/lib/execution/candidate-metrics';
import { rankCandidates, CandidateRankingResult } from '@/lib/execution/candidate-ranking';
import { assetIdentityKey } from '@/lib/domain/basket-protocol/asset-identity';
import { DEPLOYED_CONTRACTS, ROBINHOOD_CHAIN_ID, getBagRouterPlanSignerKey } from '@/lib/config/robinhood-chain';
import { getDeployedOnChainBagId } from '@/lib/server/bag-deployment-repo';
import type { Hex } from 'viem';
import { createRobinhoodUniswapLegBuilder } from '@/lib/execution/legbuilders/robinhood-uniswap-leg-builder';
import { createRobinhoodUniswapQuoter } from '@/lib/blockchain/robinhood-uniswap-quoter';
import { getRobinhoodPublicClient } from '@/lib/blockchain/robinhood-public-client';
import { createBagRouterPlanSigner } from '@/lib/blockchain/bag-execution-router-signer';
import type { DefaultProvidersConfig } from '@/lib/execution/registry';

// -----------------------------------------------------------------------------
// PHASE 19.X-2 — wires `BagRouterProvider` (item 7) into the SAME
// `buildDefaultProviders()` call the Composer/LI.FI path already uses.
// Same "no key, never attempted" rule as `LIFI_API_KEY`: this builder
// returns `undefined` — meaning `bagRouter` is omitted from
// `DefaultProvidersConfig` entirely, so `BagRouterProvider` is never even
// registered — unless BOTH `BAG_EXECUTION_ROUTER_ADDRESS` and
// `BAG_ROUTER_PLAN_SIGNER_KEY` are set. A deployment missing either one is
// byte-for-byte the same as before this wiring existed: LI.FI Composer /
// sequential only, exactly as `registry.ts`'s own doc requires.
// -----------------------------------------------------------------------------
//
// The plan's `bagId` is the Bag's REAL on-chain id — the creator-bound value
// `BagFactory` emitted at deploy time and lib/server/bag-deployment-repo.ts
// persisted (`bag_deployments.on_chain_bag_id`). It is NEVER re-derived here:
// `onChainBag` is `null` for a Bag with no CONFIRMED deployment, in which case
// `bagRouter` is omitted (LI.FI Composer / sequential only) exactly as when the
// router or plan signer is unconfigured — a Bag that is not deployed is not
// routable through the Bag Router, full stop.
function buildBagRouterProviderConfig(
  verifiedIdentityKeys: Set<string>,
  onChainBag: { bagId: string; onChainBagId: Hex } | null
): DefaultProvidersConfig['bagRouter'] {
  const routerAddress = DEPLOYED_CONTRACTS.bagExecutionRouter;
  const planSignerKey = getBagRouterPlanSignerKey();
  if (!routerAddress || !planSignerKey || !onChainBag) return undefined;

  return {
    routerAddress,
    chainId: ROBINHOOD_CHAIN_ID, // Robinhood Chain mainnet — the router is deployed there; BagRouterProvider.supports() refuses graphs for any other chain.
    toOnChainBagId: (bagId: string) => {
      // Only this purchase's own Bag has a resolved on-chain id; any other id is a caller bug, not something to guess at.
      if (bagId !== onChainBag.bagId) throw new Error(`No persisted on-chain id for bag ${bagId}.`);
      return onChainBag.onChainBagId;
    },
    legBuilder: createRobinhoodUniswapLegBuilder({
      routerAddress,
      // Same registry Set already computed above (getVerifiedIdentityKeys)
      // for `validateRecipeAssetsAgainstRegistry` — reused rather than
      // re-fetched, so there's one DB round-trip and one source of truth
      // for "is this identity canonical" per request.
      isCanonicalToken: (identity) => verifiedIdentityKeys.has(assetIdentityKey(identity)),
      quote: createRobinhoodUniswapQuoter(getRobinhoodPublicClient()),
    }),
    signPlan: createBagRouterPlanSigner(planSignerKey),
  };
}

// -----------------------------------------------------------------------------
// Phase 17 — the four operations every API route in app/api/purchase-intent
// and app/api/bags/[id]/purchase-intent delegates to. Route handlers stay
// I/O parsing + auth + status-code mapping only (same split the rest of
// this codebase already uses — see app/api/trades/route.ts); the actual
// orchestration (which repo calls happen in which order, which errors map
// to which typed outcome) lives here so it's independently testable and so
// two routes never duplicate the same sequencing.
// -----------------------------------------------------------------------------

const priceProvider = getPriceProvider();

/**
 * Builds a full `PurchaseIntentStepRecord[]` (every plan step, `KEEP`
 * included) with every `SWAP` step marked `FAILED` — used ONLY when
 * `compileBagExecution()` itself throws (no provider could even be
 * selected), so `createPurchaseIntentForUser` can still persist a
 * consistent, auditable intent row instead of one with no step data at
 * all. Field-for-field identical to a KEEP row from
 * `compiledExecutionToPurchaseIntentSteps()`/`buildPurchaseIntentSteps()`
 * for the KEEP case; the SWAP case mirrors those two functions' own
 * "quote failed" branch.
 */
function buildAllFailedSteps(
  steps: import('@/types/basket-protocol').ExecutionStep[],
  inputDecimals: number
): PurchaseIntentStepRecord[] {
  return steps.map((step, stepIndex) => {
    if (step.action === 'KEEP') {
      return {
        stepIndex,
        action: 'KEEP',
        targetSymbol: step.targetSymbol,
        inputAsset: step.route.inputAsset,
        outputAsset: step.route.outputAsset,
        sourceChain: step.route.sourceChain,
        destinationChain: step.route.destinationChain,
        inputAmountRaw: step.route.inputAmountRaw,
        targetValueRaw: step.route.targetValueRaw,
        outputAmountRaw: null,
        outputDecimals: inputDecimals,
        minOutputRaw: null,
        route: null,
        lifiStep: null,
        status: 'NOT_NEEDED',
        approvalTxHash: null,
        txHash: null,
        providerSubstatus: null,
        failureCode: null,
      };
    }
    return {
      stepIndex,
      action: 'SWAP',
      targetSymbol: step.targetSymbol,
      inputAsset: step.route.inputAsset,
      outputAsset: step.route.outputAsset,
      sourceChain: step.route.sourceChain,
      destinationChain: step.route.destinationChain,
      inputAmountRaw: step.route.inputAmountRaw,
      targetValueRaw: step.route.targetValueRaw,
      outputAmountRaw: null,
      outputDecimals: null,
      minOutputRaw: null,
      route: null,
      lifiStep: null,
      status: 'FAILED',
      approvalTxHash: null,
      txHash: null,
      providerSubstatus: null,
      failureCode: 'PROVIDER_ERROR',
    };
  });
}

/**
 * The max slippage this Bag's creator chose (recipe.rebalanceRule.maxSlippageBps),
 * used for every quote and plan minimum of a purchase. Falls back to the
 * protocol default for a recipe that predates the setting, and is capped at
 * 3% whatever the stored value, so a bad recipe can't widen execution floors.
 */
export function bagSlippageBps(version: Pick<BagVersionRecord, 'recipe'>): number {
  const chosen = version.recipe.rebalanceRule?.maxSlippageBps;
  if (typeof chosen !== 'number' || !Number.isFinite(chosen) || chosen <= 0) return DEFAULT_COMPOSER_SLIPPAGE_BPS;
  return Math.min(300, Math.max(10, Math.round(chosen)));
}

/**
 * Every asset a compiled execution can possibly target is one of the
 * recipe's own `RecipeAsset[]` (already carries `decimals`) or the
 * purchase's input asset — both already in hand wherever this is called,
 * so this is a synchronous lookup with no extra DB round-trip. Shared by
 * `getPurchaseOptionsForUser()` (candidate metrics) and
 * `createPurchaseIntentForUser()`'s BAG Router branch (`compiledExecutionToPurchaseIntentSteps()`'s
 * required `resolveOutputDecimals`, item 5 of the Bag Router hardening
 * spec: a BAG Router step's `outputDecimals` must never be `null`) — one
 * resolver, not two independently-maintained copies.
 */
function buildOutputAssetDecimalsResolver(
  version: BagVersionRecord,
  identity: AssetIdentity,
  inputAsset: CanonicalAsset
): (asset: AssetIdentity) => number | null {
  const decimalsByKey = new Map<string, number>();
  for (const asset of version.recipe.assets) {
    decimalsByKey.set(assetIdentityKey(recipeAssetIdentity(asset)), asset.decimals);
  }
  decimalsByKey.set(assetIdentityKey(identity), inputAsset.decimals);
  return (asset: AssetIdentity) => decimalsByKey.get(assetIdentityKey(asset)) ?? null;
}

export type PurchaseExecutionError =
  | { kind: 'BAG_NOT_FOUND' }
  | { kind: 'NO_PUBLISHED_RECIPE' }
  | { kind: 'REGISTRY_INVALID'; details: string[] }
  | { kind: 'UNKNOWN_INPUT_ASSET' }
  | { kind: 'PREVIEW_ERROR'; message: string }
  | { kind: 'PRICE_UNAVAILABLE'; message: string }
  /** Robinhood's live Stock Token registry could not be reached, so the Bag's Stock Tokens cannot be re-checked. Not a price problem. */
  | { kind: 'STOCK_REGISTRY_UNAVAILABLE'; message: string }
  /**
   * Neither the oracle nor this purchase's own executable quote could value these holdings, so shares cannot be
   * priced. Never estimated: the purchase stops. (Typically a holding left from an older version whose price
   * source is down while its market is closed.)
   */
  | { kind: 'VALUATION_UNAVAILABLE'; assets: AssetIdentity[]; labels: string[] }
  | { kind: 'QUOTE_FAILED'; failureCode: PurchaseIntentFailureCode; message: string; composerFallback?: ComposerFallbackNotice }
  | { kind: 'PURCHASE_IN_PROGRESS'; intentId: string }
  /** B0 (docs/FEE_ECONOMICS_DESIGN.md §5.6): a fee-paying sale of this position is open; its attested basis must not move under it. */
  | { kind: 'REDEEM_IN_PROGRESS'; intentId: string }
  | { kind: 'PROVIDER_SELECTION_UNAVAILABLE' }
  | { kind: 'NOT_FOUND' }
  | { kind: 'FORBIDDEN' }
  | { kind: 'EXPIRED' }
  | { kind: 'ROUTE_CHANGED' }
  | { kind: 'INVALID_STATE'; status: string }
  | { kind: 'BAG_NOT_LIVE'; status: string }
  | { kind: 'INVALID_TX_HASH' }
  | { kind: 'TX_ALREADY_USED' }
  /** Some assets have no swap route and the Bag's unroutable-asset policy doesn't allow buying around them (or too much is unroutable). */
  | { kind: 'ASSETS_UNROUTABLE'; reason: 'BLOCKED' | 'TOO_MUCH_UNROUTABLE'; symbols: string[] };

export type PurchaseExecutionOutcome<T> = { ok: true; value: T } | { ok: false; error: PurchaseExecutionError };

// ----------------------------- 1. Create ------------------------------------

export interface CreatePurchaseIntentParams {
  admin: SupabaseClient;
  session: SessionPayload;
  bagId: string;
  inputAssetId: string;
  amount: string;
  /**
   * Item 11 — the ONLY extra thing a client may send after comparing
   * candidates via `getPurchaseOptionsForUser()`: which provider it wants,
   * by `identify()` name. Never a `CompiledExecution`, calldata, a price, or
   * a route — this id is the sole input; everything else (recipe version,
   * registry validity, input asset, allocation, graph, eligibility) is
   * RE-DERIVED server-side from `session`/`bagId`/`inputAssetId`/`amount`
   * exactly as it already is for every other purchase. Constrains
   * `compileBagExecution()` to `constraints.allowedProviders: [selectedProviderId]`
   * (compiler.ts's own `NO_ELIGIBLE_PROVIDER` fires — mapped to the usual
   * `QUOTE_FAILED` below — if that provider is no longer eligible by the
   * time this runs). Only meaningful when `isBagExecutionCompilerEnabled()`
   * — see the `PROVIDER_SELECTION_UNAVAILABLE` guard at the top of
   * `createPurchaseIntentForUser()`.
   */
  selectedProviderId?: string;
  /**
   * Set only after the buyer saw and accepted a Composer price-impact refusal
   * (the bps Composer reported). The single-transaction route is then compiled
   * with that limit (+1% for price movement, capped at
   * MAX_ACCEPTABLE_PRICE_IMPACT_BPS); without it Composer's default applies.
   */
  acceptedPriceImpactBps?: number;
}

/**
 * Builds a fresh `PurchaseIntent`: recomputes the SAME registry-validated,
 * allocation-derived `ExecutionPlan` `computePurchasePreview()` already
 * produces for the preview UI (spec Aşama 3 — "existing quote adapter
 * contract mümkün olduğunca korunacak"), then quotes every SWAP step
 * against the REAL session wallet address (never a client-supplied one —
 * spec Aşama 12) via `buildPurchaseIntentSteps()`. Rejects outright if the
 * same wallet already has a non-terminal intent open for this bag (spec
 * Aşama 15's "duplicate execution logic" concern applies at the "don't let
 * two purchases race" level too, not just idempotent replay of the same
 * intent id).
 */
/**
 * Everything `createPurchaseIntentForUser()` and the new (item 9)
 * `getPurchaseOptionsForUser()` need BEFORE either one decides what to do
 * with a compiled execution — bag/version lookup, canonical-registry
 * re-verification, input-asset resolution, and the same
 * `computePurchasePreview()` allocation math the preview route already
 * runs. Extracted so the two callers can never drift on any of this (item
 * 10: "Do not create a second independently implemented version of:
 * registry validation, allocation math, graph construction, price
 * checks") — NEITHER caller inlines its own copy any more.
 *
 * Deliberately does NOT include `findActivePurchaseIntentForBag()`'s
 * duplicate-active-intent guard: that guard exists to stop two
 * PurchaseIntent ROWS from racing, so it belongs only to the path that
 * actually writes one. A candidate-comparison call writes nothing (item 10:
 * "candidate comparison request should NOT create a persistent
 * PurchaseIntent") and must keep working even while the user already has a
 * READY intent open from a previous comparison pass.
 */
interface PreparedBagPurchaseContext {
  bag: BagRecord;
  version: BagVersionRecord;
  outputIdentityKeys: Set<string>;
  inputAsset: CanonicalAsset;
  identity: AssetIdentity;
  /**
   * Oracle NAV, or null when the oracle could not price the holdings. A null NAV never blocks a purchase by
   * itself: shares are then priced from the executable quote (`priceSharesFromExecution`). Everything that
   * protects the buyer (route, quote, minimum output, slippage, allowlists, policy) is unaffected.
   */
  nav: NavResult | null;
  shareSupply: ShareSupply;
  outcome: PurchasePreviewResult;
  /** Set when the Bag's unroutable-asset policy changed what this purchase buys — persisted on the intent. */
  fallback: PurchaseIntentFallback | null;
  /** The (effective) payment in USD, and the USD price of one payment-asset unit it was valued at ('1' for a stablecoin) — lib/server/payment-value.ts. */
  quoteAmount: string;
  inputUsdPrice: string;
}

/**
 * Which of `recipe`'s swap targets have no route right now, probed from the
 * payment token (asset-route-check.ts, cached). Provider errors count as
 * routable here — the real quote that follows decides those.
 */
async function findUnroutableAssets(recipe: BasketRecipe, input: AssetIdentity): Promise<AssetIdentity[]> {
  const targets = recipe.assets.filter((a) => a.weightBps > 0 && !assetIdentitiesEqual(a, input));
  const statuses = await Promise.all(targets.map((a) => checkAssetRoute({ chain: a.chain, address: a.address })));
  return targets.filter((_, i) => statuses[i] === 'NO_ROUTE').map((a) => ({ chain: a.chain, address: a.address }));
}

async function prepareBagPurchaseContext(
  admin: SupabaseClient,
  bagId: string,
  inputAssetId: string,
  amount: string
): Promise<PurchaseExecutionOutcome<PreparedBagPurchaseContext>> {
  const bag = await getBagById(admin, bagId);
  if (!bag) return { ok: false, error: { kind: 'BAG_NOT_FOUND' } };
  // Only a deployed (ACTIVE) Bag takes investments — never a DRAFT (not on
  // chain yet, possibly someone else's) or an ARCHIVED one.
  if (bag.status !== 'ACTIVE') return { ok: false, error: { kind: 'BAG_NOT_LIVE', status: bag.status } };

  const version = await getCurrentBagVersion(admin, bagId);
  if (!version) return { ok: false, error: { kind: 'NO_PUBLISHED_RECIPE' } };

  // Same registry re-verification the preview route runs — never trust that
  // a Bag verified at publish time is still verified now (spec Aşama 12:
  // "canonical registry enforcement KESİNLİKLE korunacak").
  const outputIdentityKeys = await getVerifiedIdentityKeys(admin, version.recipe.assets.map(recipeAssetIdentity));
  const registryIssues = validateRecipeAssetsAgainstRegistry(version.recipe, {
    verifiedIdentityKeys: outputIdentityKeys,
    severity: 'ERROR',
  });
  if (registryIssues.length > 0) {
    return { ok: false, error: { kind: 'REGISTRY_INVALID', details: registryIssues.map((i) => i.message) } };
  }

  // Input asset resolved by registry id ONLY — the client never supplies
  // chain/address/decimals directly (same invariant as the preview route).
  const inputAssets = await listAssets(admin, { status: 'VERIFIED' });
  const inputAsset = purchaseInputAssetsFor(inputAssets, bag.chain).find((a) => a.id === inputAssetId);
  if (!inputAsset) return { ok: false, error: { kind: 'UNKNOWN_INPUT_ASSET' } };

  // Stock Tokens are re-checked against Robinhood's LIVE registry: still the
  // canonical contract, still active, fractionally tradable right now.
  const stockGuard = await checkStockTokensForPurchase(version.recipe.assets.map(recipeAssetIdentity), inputAssets);
  if (!stockGuard.ok) {
    return stockGuard.kind === 'REGISTRY_UNAVAILABLE'
      ? { ok: false, error: { kind: 'STOCK_REGISTRY_UNAVAILABLE', message: stockGuard.message } }
      : { ok: false, error: { kind: 'REGISTRY_INVALID', details: stockGuard.details } };
  }

  const [navOutcome, shareSupply] = await Promise.all([
    getBagNavSafe(admin, bagId, priceProvider),
    getShareSupply(admin, bagId),
  ]);

  // Real-price fail-closed guard (Phase 18), narrowed to what needs a price:
  // a missing, stale or invalid oracle price is never used and never
  // estimated. It no longer blocks the purchase on its own, because nothing
  // that protects the buyer depends on it (allocation is weights x amount;
  // minimum output comes from the executable quote). Only the share mint
  // needs a valuation, and `priceSharesFromExecution()` provides one from the
  // purchase's own quote, or stops the purchase.
  const nav = navOutcome.ok ? navOutcome.nav : null;

  const identity: AssetIdentity = { chain: inputAsset.chain, address: inputAsset.address };

  // Unroutable-asset policy (types/basket-protocol.ts). Only probed when the
  // creator allowed buying around a dead route; under BLOCK the real quote
  // below fails exactly as before.
  const policy = version.recipe.unroutablePolicy ?? DEFAULT_UNROUTABLE_POLICY;
  let effectiveRecipe = version.recipe;
  let effectiveAmount = amount;
  let fallback: PurchaseIntentFallback | null = null;
  if (policy !== 'BLOCK' && isValidDecimalString(amount.trim()) && !amount.trim().startsWith('-')) {
    const unroutable = await findUnroutableAssets(version.recipe, identity);
    const applied = applyUnroutablePolicy(
      version.recipe,
      { ...identity, symbol: inputAsset.symbol, decimals: inputAsset.decimals },
      unroutable,
      policy
    );
    if (!applied.ok) {
      return { ok: false, error: { kind: 'ASSETS_UNROUTABLE', reason: applied.reason, symbols: applied.affected.map((a) => a.symbol) } };
    }
    if (applied.affected.length > 0) {
      const requestedAmountRaw = toProtocolPrice(amount.trim(), inputAsset.decimals).toString();
      effectiveRecipe = applied.recipe;
      effectiveAmount = rawToDecimalString(scaleAmountRaw(requestedAmountRaw, applied.amountScaleBps), inputAsset.decimals);
      fallback = {
        policy: policy as PurchaseIntentFallback['policy'],
        assets: applied.affected.map((a) => ({ chain: a.chain, address: a.address, symbol: a.symbol })),
        unroutableWeightBps: applied.unroutableWeightBps,
        amountScaleBps: applied.amountScaleBps,
        requestedAmountRaw,
        inputSymbol: inputAsset.symbol,
        inputDecimals: inputAsset.decimals,
      };
    }
  }

  // The payment in USD: shares, the minimum investment and the cost basis
  // are in USD. A stablecoin counts 1:1; native ETH is valued at its oracle
  // price, and without one there is no purchase (nothing is estimated).
  let payment: { quoteAmount: string; inputUsdPrice: string } = { quoteAmount: effectiveAmount, inputUsdPrice: '1' };
  if (isValidDecimalString(effectiveAmount.trim()) && !effectiveAmount.trim().startsWith('-')) {
    try {
      payment = await valuePayment(identity, effectiveAmount, priceProvider);
    } catch {
      return { ok: false, error: { kind: 'PREVIEW_ERROR', message: `Unable to value ${inputAsset.symbol} right now. Try again shortly.` } };
    }
  }

  const outcome = computePurchasePreview({
    recipe: effectiveRecipe,
    inputAsset: identity,
    inputSymbol: inputAsset.symbol,
    inputDecimals: inputAsset.decimals,
    amount: effectiveAmount,
    quoteAmount: payment.quoteAmount,
    nav,
    shareSupply,
  });

  if (!outcome.ok) {
    const messageByKind: Record<string, string> = {
      INVALID_AMOUNT: 'Enter a valid amount.',
      ZERO_AMOUNT: 'Deposit amount must be greater than zero.',
      INVALID_RECIPE: 'This Bag has an invalid composition.',
      NAV_UNAVAILABLE: 'NAV is currently unavailable.',
    };
    if (outcome.error.kind === 'BELOW_MIN_INVESTMENT') messageByKind.BELOW_MIN_INVESTMENT = outcome.error.message;
    if (outcome.error.kind === 'NATIVE_INPUT_KEPT') messageByKind.NATIVE_INPUT_KEPT = outcome.error.message;
    return { ok: false, error: { kind: 'PREVIEW_ERROR', message: messageByKind[outcome.error.kind] ?? 'Unable to calculate allocation.' } };
  }

  return {
    ok: true,
    value: { bag, version, outputIdentityKeys, inputAsset, identity, nav, shareSupply, outcome, fallback, quoteAmount: payment.quoteAmount, inputUsdPrice: payment.inputUsdPrice },
  };
}

/**
 * Shares for a purchase whose holdings the oracle could not value: the Bag's holdings and the deposit are valued
 * at the prices this purchase's own executable quote implies (input spent / BAG's minimum output, rounded up;
 * see execution-valuation.ts). A holding the purchase does not buy is priced by the oracle individually, or the
 * purchase stops with the assets named. Nothing is estimated and no price is invented.
 */
async function priceSharesFromExecution(
  admin: SupabaseClient,
  bagId: string,
  steps: PurchaseIntentStepRecord[],
  inputAsset: CanonicalAsset,
  shareSupply: ShareSupply,
  /** The payment in USD (the quote currency the deposit is valued in). */
  depositAmount: string,
  slippageBps: number,
  /** Display symbols by identity key (recipe assets), only to name an unpriced holding in the error. */
  knownSymbols: ReadonlyMap<string, string>,
  now: Date,
  /** USD per one payment-asset unit ('1' for a stablecoin): turns the legs' payment-unit prices into USD. */
  inputUsdPrice: string
): Promise<PurchaseExecutionOutcome<{ depositQuote: DepositQuote; nav: NavResult }>> {
  const executionPrices = executionPricesFromLegs(
    steps.map((st) => ({
      action: st.action,
      outputAsset: st.outputAsset,
      inputAmountRaw: st.inputAmountRaw,
      minOutputRaw: st.minOutputRaw,
      providerEnforcedMinOutputRaw: st.providerEnforcedMinOutputRaw ?? null,
      outputAmountRaw: st.outputAmountRaw,
      outputDecimals: st.outputDecimals,
    })),
    { asset: { chain: inputAsset.chain, address: inputAsset.address }, decimals: inputAsset.decimals },
    now.toISOString(),
    // Only used when a leg reports no minimum at all: the same tolerance the transaction is built with.
    { expectedHaircutBps: slippageBps, inputUsdPrice }
  );
  const holdings = await getBagAssetHoldings(admin, bagId);
  const uncovered = holdings.filter((h) => !executionPrices.has(assetIdentityKey(h.asset)));
  const other = uncovered.length > 0 ? (await priceHoldingsIndividually(uncovered, priceProvider)).prices : new Map();
  const valued = navAtExecutionPrices(holdings, executionPrices, other, now);
  if (!valued.ok) {
    const labels = valued.unpriced.map((a) => knownSymbols.get(assetIdentityKey(a)) ?? `${a.address.slice(0, 6)}…${a.address.slice(-4)}`);
    return { ok: false, error: { kind: 'VALUATION_UNAVAILABLE', assets: valued.unpriced, labels } };
  }
  try {
    return { ok: true, value: { depositQuote: getPurchaseDepositQuote(valued.nav, shareSupply, depositAmount), nav: valued.nav } };
  } catch (err) {
    if (err instanceof OrphanedNavError || err instanceof ZeroNavError) {
      return { ok: false, error: { kind: 'PREVIEW_ERROR', message: 'NAV is currently unavailable.' } };
    }
    throw err;
  }
}

/**
 * Builds the `BagExecutionIntent` + `BagExecutionGraph` + fully-wired
 * provider registry for one purchase — the SAME construction
 * `createPurchaseIntentForUser()`'s compiler branch used to build inline,
 * extracted so `getPurchaseOptionsForUser()` (item 10/6) can share it
 * exactly rather than re-deriving eligibility/registry/router-wiring a
 * second way. Returns the base intent with NO `constraints` set — the
 * create-intent path adds `selectedProviderId`'s `allowedProviders`
 * constraint itself (a single-provider request); the candidate-comparison
 * path leaves it unconstrained (item 3: "try every eligible provider").
 */
async function buildBagExecutionIntentAndProviders(
  admin: SupabaseClient,
  bag: BagRecord,
  version: BagVersionRecord,
  session: SessionPayload,
  identity: AssetIdentity,
  outcome: PurchasePreviewResult,
  bagId: string,
  /** Same registry Set `prepareBagPurchaseContext()` already computed — passed in and reused rather than re-fetched, so this helper costs no extra DB round-trip. */
  outputIdentityKeys: Set<string>
): Promise<{ graph: ReturnType<typeof buildBagExecutionGraph>; bagIntent: BagExecutionIntent; providers: BagExecutionProvider[] }> {
  const graph = buildBagExecutionGraph(outcome.executionPlan, {
    wallet: session.walletAddress,
    chainId: identity.chain,
    defaultSlippageBps: bagSlippageBps(version),
  });
  const bagIntent: BagExecutionIntent = {
    bagId,
    wallet: session.walletAddress,
    chainId: identity.chain,
    inputAsset: identity,
    inputAmountRaw: outcome.inputAmountRaw,
    targets: graph.legs.map((leg) => ({ asset: leg.targetAsset, weightBps: leg.weightBps })),
    maxSlippageBps: bagSlippageBps(version),
    deadline: Date.now() + PURCHASE_INTENT_TTL_MS,
    recipeVersion: version.version,
    compositionHash: version.compositionHash,
  };

  const canonicalIdentityKeys = new Set(outputIdentityKeys);
  canonicalIdentityKeys.add(assetIdentityKey(identity));

  const onChainBagId =
    bag.chain === 'robinhood' && DEPLOYED_CONTRACTS.bagExecutionRouter && getBagRouterPlanSignerKey()
      ? await getDeployedOnChainBagId(admin, bag.id, bag.chain)
      : null;

  const providers = buildDefaultProviders({
    ...(process.env.LIFI_API_KEY ? { lifiComposer: { apiKey: process.env.LIFI_API_KEY } } : {}),
    bagRouter: buildBagRouterProviderConfig(canonicalIdentityKeys, onChainBagId ? { bagId: bag.id, onChainBagId } : null),
  });

  return { graph, bagIntent, providers };
}

export async function createPurchaseIntentForUser(
  params: CreatePurchaseIntentParams
): Promise<PurchaseExecutionOutcome<PurchaseIntent>> {
  const { admin, session, bagId, inputAssetId, amount, selectedProviderId } = params;

  if (params.acceptedPriceImpactBps !== undefined && params.acceptedPriceImpactBps > MAX_ACCEPTABLE_PRICE_IMPACT_BPS) {
    return {
      ok: false,
      error: {
        kind: 'QUOTE_FAILED',
        failureCode: 'SLIPPAGE_EXCEEDED',
        message: `Price impact above ${MAX_ACCEPTABLE_PRICE_IMPACT_BPS / 100}% is not accepted. Try a smaller amount or a different composition.`,
      },
    };
  }

  // A `selectedProviderId` only means anything once the compiler layer
  // exists to constrain — see item 12's "Do NOT force the new path onto
  // legacy deployments". Rejected BEFORE the duplicate-intent check so a
  // caller misusing this on a legacy deployment gets an immediate, cheap
  // error rather than a confusing downstream one.
  if (selectedProviderId && !isBagExecutionCompilerEnabled()) {
    return { ok: false, error: { kind: 'PROVIDER_SELECTION_UNAVAILABLE' } };
  }

  const existing = await findActivePurchaseIntentForBag(admin, session.userId, bagId);
  if (existing && !(await settleOpenIntent(admin, session, existing))) {
    return { ok: false, error: { kind: 'PURCHASE_IN_PROGRESS', intentId: existing.id } };
  }

  const prepared = await prepareBagPurchaseContext(admin, bagId, inputAssetId, amount);
  if (!prepared.ok) return prepared;
  const { bag, version, outputIdentityKeys, inputAsset, identity, nav: oracleNav, shareSupply, outcome, fallback, quoteAmount, inputUsdPrice } = prepared.value;

  const openFeeSale = await openFeeRedemptionFor(admin, session.userId, bag, version);
  if (openFeeSale) return { ok: false, error: { kind: 'REDEEM_IN_PROGRESS', intentId: openFeeSale.id } };

  // THE Phase 17 step: quote every SWAP step against the real, connected,
  // session-authenticated wallet — never PLACEHOLDER_ADDRESS (spec Aşama
  // 1/4). `session.walletAddress` is signed into the JWT cookie at sign-in
  // (lib/auth/session.ts) — never a request-body field.
  //
  // BAG_EXECUTION_COMPILER_ENABLED branch: provider selection goes through
  // `compileBagExecution()` (lib/execution/compiler.ts) instead of this
  // file calling `buildPurchaseIntentSteps()` directly. Both branches
  // produce the EXACT same `{ steps, allSwapsQuoted, firstFailure,
  // composerTransaction }` shape, so everything below this block (fingerprint,
  // persistence, the READY/FAILED status decision) is identical either way.
  let steps: PurchaseIntentStepRecord[];
  let allSwapsQuoted: boolean;
  let firstFailure: { failureCode: 'UNSUPPORTED_ROUTE' | 'PROVIDER_ERROR' | 'SLIPPAGE_EXCEEDED'; message: string } | null;
  let composerTransaction: { to: string; data: string; value: string; chainId: number; userProxy: string } | null;
  // Set when Composer refused the single-transaction route; the intent then fails and this goes back to the buyer.
  let composerFallback: ComposerFallbackNotice | null = null;
  let bagRouterTransaction: {
    to: string;
    data: string;
    value: string;
    chainId: number;
    inputToken: string;
    inputAmountRaw: string;
    bagOnChainId: string;
  } | null = null;
  // Explicit, persisted provider identity (Bag Router execution hardening,
  // item 1) — never re-derived from `executionMode`/`mode`, which is
  // `SINGLE_TX` for BOTH `bag-router` and `lifi-composer` and therefore
  // cannot tell them apart on its own. `null` for the legacy path, which
  // has no compiler-determined provider.
  let providerId: string | null = null;
  // Non-null iff `compileBagExecution()` actually ran and produced a
  // result — see `PurchaseIntent.executionPlanHash`'s own doc and
  // supabase/migrations/0022_add_execution_plan_hash.sql: null for every
  // legacy (flag-off) intent, exactly like `composerTransaction` is null
  // for every non-Composer intent.
  let executionPlanHash: string | null = null;
  // Item 8 — what the compiled execution ACTUALLY asks of the wallet.
  // Same null-for-legacy rule as `executionPlanHash` directly above: the
  // pre-compiler path never produced a `CompiledExecution`, so it has no
  // mode to report, and the UI must not invent one on its behalf.
  let executionMode: ExecutionMode | null = null;

  if (isBagExecutionCompilerEnabled()) {
    const { graph, bagIntent: baseBagIntent, providers } = await buildBagExecutionIntentAndProviders(
      admin,
      bag,
      version,
      session,
      identity,
      outcome,
      bagId,
      outputIdentityKeys
    );
    const bagIntent: BagExecutionIntent = {
      ...baseBagIntent,
      // Item 11 — the ONLY effect a client-supplied `selectedProviderId` is
      // allowed to have: which provider(s) `compileBagExecution()` will even
      // try. Everything that provider then compiles against (graph, intent,
      // targets, wallet) was just re-derived above from scratch, same as
      // every other purchase — a selection can narrow WHICH eligible
      // provider runs, never what it runs against.
      ...(selectedProviderId ? { constraints: { allowedProviders: [selectedProviderId] } } : {}),
    };

    try {
      const compiled = await compileBagExecution(bagIntent, graph, providers);
      const resolveOutputDecimals = buildOutputAssetDecimalsResolver(version, identity, inputAsset);
      const bridged = compiledExecutionToPurchaseIntentSteps(outcome.executionPlan, compiled, inputAsset.decimals, resolveOutputDecimals);
      steps = bridged.steps;
      allSwapsQuoted = bridged.allSwapsQuoted;
      firstFailure = bridged.firstFailure;
      composerTransaction = bridged.composerTransaction;
      bagRouterTransaction = bridged.bagRouterTransaction;
      executionPlanHash = compiled.executionPlanHash;
      executionMode = compiled.mode;
      providerId = compiled.providerId;
    } catch (err) {
      // No provider could compile this purchase at all (e.g. every
      // registered provider is ineligible or every eligible one failed to
      // compile — `compileBagExecution()`'s own doc). Still persists a
      // FAILED, fully-auditable intent row exactly like the legacy path
      // does for a per-step quote failure, rather than silently dropping
      // the attempt — same "every purchase attempt gets an auditable row"
      // guarantee, just for a failure this abstraction layer's error
      // surface doesn't (yet) attribute to one specific step.
      if (!(err instanceof BagExecutionError)) throw err;
      steps = buildAllFailedSteps(outcome.executionPlan.steps, inputAsset.decimals);
      allSwapsQuoted = false;
      firstFailure = { failureCode: 'PROVIDER_ERROR', message: err.message };
      composerTransaction = null;
    }
  } else {
    // Phase 22 — attempts a single-signature LI.FI Composer transaction
    // first (composerOptions), falling back to the sequential per-step path
    // whenever Composer isn't configured/eligible/available — see
    // tryBuildComposerSteps()'s own doc for every condition that causes a
    // fall-through. LIFI_API_KEY missing simply means this deposit never
    // attempts Composer, not an error.
    const composerOptions = process.env.LIFI_API_KEY
      ? {
          apiKey: process.env.LIFI_API_KEY,
          slippageBps: bagSlippageBps(version),
          resolveOutputDecimals: buildOutputAssetDecimalsResolver(version, identity, inputAsset),
          ...(params.acceptedPriceImpactBps !== undefined
            ? { maxPriceImpactBps: Math.min(params.acceptedPriceImpactBps + PRICE_IMPACT_ACCEPT_BUFFER_BPS, MAX_ACCEPTABLE_PRICE_IMPACT_BPS) }
            : {}),
        }
      : undefined;
    const legacy = await buildPurchaseIntentSteps(
      outcome.executionPlan.steps,
      session.walletAddress,
      inputAsset.decimals,
      composerOptions
    );
    steps = legacy.steps;
    allSwapsQuoted = legacy.allSwapsQuoted;
    firstFailure = legacy.firstFailure;
    composerTransaction = legacy.composerTransaction;
    composerFallback = legacy.composerFallback ?? null;
    // Composer refused: record the attempt as FAILED, one row per step, like any other quote failure.
    if (composerFallback) steps = buildAllFailedSteps(outcome.executionPlan.steps, inputAsset.decimals);
  }

  // Shares: oracle NAV when it could value the Bag; otherwise this purchase's
  // own quote. Without a complete quote there is nothing true to value with,
  // and the purchase fails below anyway, so no row is written for it.
  let depositQuote = outcome.depositQuote;
  let nav = oracleNav;
  if (!depositQuote || !nav) {
    if (!allSwapsQuoted) {
      return {
        ok: false,
        error: {
          kind: 'QUOTE_FAILED',
          failureCode: firstFailure?.failureCode ?? 'PROVIDER_ERROR',
          message: firstFailure?.message ?? 'No executable route could be quoted for this purchase.',
          ...(composerFallback ? { composerFallback } : {}),
        },
      };
    }
    const knownSymbols = new Map(version.recipe.assets.map((a) => [assetIdentityKey(a), a.symbol] as const));
    const priced = await priceSharesFromExecution(admin, bagId, steps, inputAsset, shareSupply, quoteAmount, bagSlippageBps(version), knownSymbols, new Date(), inputUsdPrice);
    if (!priced.ok) return priced;
    depositQuote = priced.value.depositQuote;
    nav = priced.value.nav;
    console.info(`[purchase] bag ${bagId}: oracle NAV unavailable; shares priced from the executable quote (${EXECUTION_QUOTE_PRICE_SOURCE}).`);
  }

  const fingerprint = computeExecutionPlanFingerprint(outcome.executionPlan);
  const expiresAt = new Date(Date.now() + PURCHASE_INTENT_TTL_MS).toISOString();

  const intent = await insertPurchaseIntent(admin, {
    userId: session.userId,
    walletAddress: session.walletAddress,
    bagId,
    inputAsset: identity,
    inputAmountRaw: outcome.inputAmountRaw,
    // Locked in NOW, from the exact DepositQuote the Purchase Preview
    // already showed this user — minted verbatim on completion (see
    // PurchaseIntent.sharesRaw's doc comment), never recomputed against a
    // possibly-moved NAV at execution time.
    sharesRaw: depositQuote.sharesRaw,
    shareDecimals: depositQuote.shareDecimals,
    routeFingerprint: fingerprint,
    // Phase 18 — locked alongside the fingerprint, re-verified at execute
    // time (see prepareExecution() below) instead of the weaker "output
    // asset set" check Phase 17 shipped with.
    recipeVersion: version.version,
    compositionHash: version.compositionHash,
    navSnapshot: { grossNav: nav.grossNav, quoteCurrency: nav.quoteCurrency, asOf: nav.asOf },
    sharePriceAtQuote: depositQuote.isBootstrap ? null : depositQuote.sharePrice,
    // Phase 20 — locked now, from the same DepositQuote the Purchase
    // Preview already showed the user, so `applyAccountingIdempotently()`
    // below has a well-defined per-investor cost-basis delta regardless of
    // whether this deposit was a bootstrap (sharePriceAtQuote null) or not.
    depositAmount: depositQuote.depositAmount,
    steps,
    composerTransaction,
    bagRouterTransaction,
    providerId,
    executionPlanHash,
    executionMode,
    fallback,
    status: allSwapsQuoted ? 'READY' : 'FAILED',
    failureCode: allSwapsQuoted ? null : (firstFailure?.failureCode ?? 'UNKNOWN_ERROR'),
    expiresAt,
  });

  if (!allSwapsQuoted && firstFailure) {
    return {
      ok: false,
      error: {
        kind: 'QUOTE_FAILED',
        failureCode: firstFailure.failureCode,
        message: firstFailure.message,
        ...(composerFallback ? { composerFallback } : {}),
      },
    };
  }

  // B0 (§5.6), the second half of the lock: the purchase is written FIRST, then the open fee-paying sale is looked
  // up. The fee attestation does the mirror image (its sale intent is written before it looks for purchases), so of a
  // racing purchase and fee sale at least one always sees the other — never both proceed. If a sale won, this
  // purchase is cancelled before it can be signed.
  const blocked = await cancelPurchaseIfFeeSaleOpen(admin, intent, bag, version);
  if (blocked) return { ok: false, error: { kind: 'REDEEM_IN_PROGRESS', intentId: blocked.id } };

  return { ok: true, value: intent };
}

// ----------------------------- 1b. candidate comparison (item 6/9/10) ---------

export interface PurchaseOptionsResult {
  candidates: ExecutionCandidateView[];
  /** Never dropped (spec item 8) — the caller/UI decides how much of this to show ("2 of 3 routes available"). */
  failed: ExecutionCandidateView[];
  winners: CandidateRankingResult['winners'];
  executionPlanHash: string;
  compiledAt: number;
}

/**
 * Item 6/9/10's candidate-comparison service: "existing BagExecutionGraph →
 * all eligible providers → parallel compile → validate complete execution →
 * annotate real metrics → rank transparently". Deliberately the ONLY thing
 * this function does that `createPurchaseIntentForUser()` doesn't:
 *   - NEVER calls `insertPurchaseIntent()` / any persistence — item 10:
 *     "Do NOT persist 2-3 candidate intents. Do NOT write rows merely
 *     because the user opened the route comparison screen."
 *   - NEVER checks `findActivePurchaseIntentForBag()` — a pure read has no
 *     business colliding with that write-side guard (see
 *     `prepareBagPurchaseContext()`'s own doc on why it's excluded there).
 *
 * Every other step — bag/version/registry/input-asset/NAV/allocation,
 * graph+intent+provider-registry construction, even the Bag Router
 * on-chain-id wiring — is the EXACT SAME shared code
 * `createPurchaseIntentForUser()` uses (item 10: "Reuse the existing
 * functions", "Do not create a second independently implemented version").
 *
 * Returns `PROVIDER_SELECTION_UNAVAILABLE` when the compiler flag is off —
 * candidate comparison is meaningless without `compileBagExecutionCandidates()`
 * to run (item 12: "When the flag is OFF: the existing legacy behavior must
 * remain unchanged" — there is no legacy candidate-comparison behavior to
 * fall back to).
 */
export async function getPurchaseOptionsForUser(
  params: Omit<CreatePurchaseIntentParams, 'selectedProviderId'>
): Promise<PurchaseExecutionOutcome<PurchaseOptionsResult>> {
  const { admin, session, bagId, inputAssetId, amount } = params;

  if (!isBagExecutionCompilerEnabled()) {
    return { ok: false, error: { kind: 'PROVIDER_SELECTION_UNAVAILABLE' } };
  }

  const prepared = await prepareBagPurchaseContext(admin, bagId, inputAssetId, amount);
  if (!prepared.ok) return prepared;
  const { bag, version, outputIdentityKeys, inputAsset, identity, outcome } = prepared.value;

  const { graph, bagIntent, providers } = await buildBagExecutionIntentAndProviders(
    admin,
    bag,
    version,
    session,
    identity,
    outcome,
    bagId,
    outputIdentityKeys
  );

  let candidateSet: ExecutionCandidateSet;
  try {
    candidateSet = await compileBagExecutionCandidates(bagIntent, graph, providers);
  } catch (err) {
    // Only structural failures reach here (compiler.ts's own doc:
    // `assertValidExecutionGraph()` or `UNSATISFIABLE_CONSTRAINTS`) — every
    // per-provider failure is already folded into a FAILED candidate
    // instead of thrown. Same error-shape convention as
    // `createPurchaseIntentForUser()`'s own compiler try/catch below.
    if (err instanceof BagExecutionError) {
      return { ok: false, error: { kind: 'QUOTE_FAILED', failureCode: 'PROVIDER_ERROR', message: err.message } };
    }
    throw err;
  }

  // Every asset a candidate can possibly target is one of the recipe's own
  // `RecipeAsset[]` (already carries `decimals`) or the purchase's input
  // asset — both already in hand, so this is a synchronous lookup with no
  // extra DB round-trip (spec item 5's "existing asset registry / decimals").
  const resolveAssetDecimals = buildOutputAssetDecimalsResolver(version, identity, inputAsset);

  const annotated = await annotateCandidateMetrics(candidateSet, {
    requestedSlippageBps: bagIntent.maxSlippageBps,
    priceProvider,
    resolveAssetDecimals,
  });

  const { executable, failed, winners } = rankCandidates(annotated.candidates);

  // Item 2 (sanitize before it ever reaches the client): the raw
  // `ExecutionCandidate[]` carries each provider's full `compiled`
  // (transactions/calldata, LI.FI's raw per-leg step objects, a SIGNED Bag
  // Router plan when that provider is a candidate) — none of which the
  // comparison screen needs, and selecting a candidate re-compiles it from
  // scratch server-side regardless (see `ExecutionCandidateView`'s own
  // doc). `winners[].candidateId`/`providerId` reference ids already
  // present on the sanitized view, so nothing downstream loses information
  // by this mapping — only the unused, oversized/sensitive internals are
  // dropped.
  return {
    ok: true,
    value: {
      candidates: executable.map(toExecutionCandidateView),
      failed: failed.map(toExecutionCandidateView),
      winners,
      executionPlanHash: annotated.executionPlanHash,
      compiledAt: annotated.compiledAt,
    },
  };
}

// ----------------------------- shared guards ---------------------------------

async function loadOwnedIntent(
  admin: SupabaseClient,
  userId: string,
  intentId: string
): Promise<PurchaseExecutionOutcome<PurchaseIntent>> {
  const result = await getPurchaseIntentForUser(admin, intentId, userId);
  if (!result.ok) {
    return { ok: false, error: { kind: result.error === 'NOT_FOUND' ? 'NOT_FOUND' : 'FORBIDDEN' } };
  }
  return { ok: true, value: result.intent };
}

function isExpired(intent: PurchaseIntent): boolean {
  return new Date(intent.expiresAt).getTime() < Date.now();
}

// ----------------------------- 2. Execute (idempotent) ------------------------

/**
 * Spec Aşama 9 — idempotent execution endpoint. If the intent has already
 * moved past `READY` (AWAITING_SIGNATURE/SUBMITTED/CONFIRMING/COMPLETED/
 * FAILED/...), this returns the EXISTING state unchanged — never creates a
 * second transaction, never re-quotes. Only a fresh `READY` intent actually
 * advances (to `AWAITING_SIGNATURE`), after re-validating it hasn't expired
 * and the Bag's current `ExecutionPlan` fingerprint still matches what this
 * intent was quoted against (spec Aşama 3/8: a changed recipe/allocation
 * invalidates an in-flight intent rather than silently executing a stale
 * route).
 */
export async function prepareExecution(
  admin: SupabaseClient,
  session: SessionPayload,
  intentId: string
): Promise<PurchaseExecutionOutcome<PurchaseIntent>> {
  const owned = await loadOwnedIntent(admin, session.userId, intentId);
  if (!owned.ok) return owned;
  const intent = owned.value;

  // Idempotent replay: already advanced (or terminal) — return as-is,
  // create nothing new (spec Aşama 9's explicit table).
  if (intent.status !== 'READY' && intent.status !== 'QUOTED' && intent.status !== 'DRAFT') {
    return { ok: true, value: intent };
  }

  if (isExpired(intent)) {
    await updatePurchaseIntentStatus(admin, { id: intentId, from: intent.status, to: 'EXPIRED', failureCode: 'ROUTE_EXPIRED' });
    return { ok: false, error: { kind: 'EXPIRED' } };
  }

  // Re-derive the CURRENT ExecutionPlan fingerprint and compare — protects
  // against the Bag's recipe changing between quote and execute.
  const bag = await getBagById(admin, intent.bagId);
  const version = bag ? await getCurrentBagVersion(admin, intent.bagId) : null;
  if (!bag || !version) {
    await updatePurchaseIntentStatus(admin, { id: intentId, from: intent.status, to: 'FAILED', failureCode: 'UNSUPPORTED_ROUTE' });
    return { ok: false, error: { kind: 'ROUTE_CHANGED' } };
  }

  // B0 (§5.6): no purchase of a position while a fee-paying sale of it is open.
  const openFeeSale = await openFeeRedemptionFor(admin, session.userId, bag, version);
  if (openFeeSale) return { ok: false, error: { kind: 'REDEEM_IN_PROGRESS', intentId: openFeeSale.id } };

  // Same registry re-verification the preview/create routes run — never
  // trust that a Bag verified at creation time is still verified now.
  const currentOutputIdentityKeys = await getVerifiedIdentityKeys(admin, version.recipe.assets.map(recipeAssetIdentity));
  const registryIssues = validateRecipeAssetsAgainstRegistry(version.recipe, {
    verifiedIdentityKeys: currentOutputIdentityKeys,
    severity: 'ERROR',
  });
  if (registryIssues.length > 0) {
    await updatePurchaseIntentStatus(admin, { id: intentId, from: intent.status, to: 'FAILED', failureCode: 'UNSUPPORTED_ROUTE' });
    return { ok: false, error: { kind: 'ROUTE_CHANGED' } };
  }

  // Phase 18 — compositionHash re-check: cheapest, most specific signal
  // that the Bag's recipe itself changed since this intent was quoted
  // (types/purchase-intent.ts's `PurchaseIntent.compositionHash` doc).
  if (version.compositionHash !== intent.compositionHash) {
    await updatePurchaseIntentStatus(admin, { id: intentId, from: intent.status, to: 'FAILED', failureCode: 'ROUTE_EXPIRED' });
    return { ok: false, error: { kind: 'ROUTE_CHANGED' } };
  }

  // Phase 18 — full ExecutionPlan re-derivation and fingerprint compare.
  // Supersedes the Phase 17 "output asset set" check: that only caught an
  // asset being added/removed, never a reweighting between the SAME
  // assets, a changed source/destination chain, or any other allocation-
  // math difference a still-matching compositionHash wouldn't itself
  // catch (compositionHash covers the recipe's declared composition, not
  // what `buildExecutionPlan()` derives from it plus the input asset/
  // amount). Reconstructible EXACTLY, with no precision loss, because
  // `DepositRequest.amountRaw` (unlike `computePurchasePreview()`'s human
  // `amount` string) takes the same raw integer string `intent
  // .inputAmountRaw` already is — no round-trip through a human decimal
  // string is needed here, so nothing is approximated.
  // A partial purchase (unroutable-asset policy) was quoted against an
  // effective recipe; rebuild exactly that one from the stored record. The
  // creator changing the policy since then counts as a changed route.
  let planRecipe = version.recipe;
  if (intent.fallback) {
    const currentPolicy = version.recipe.unroutablePolicy ?? DEFAULT_UNROUTABLE_POLICY;
    const applied =
      currentPolicy === intent.fallback.policy
        ? applyUnroutablePolicy(
            version.recipe,
            { ...intent.inputAsset, symbol: intent.fallback.inputSymbol, decimals: intent.fallback.inputDecimals },
            intent.fallback.assets,
            intent.fallback.policy
          )
        : null;
    if (!applied || !applied.ok) {
      await updatePurchaseIntentStatus(admin, { id: intentId, from: intent.status, to: 'FAILED', failureCode: 'ROUTE_EXPIRED' });
      return { ok: false, error: { kind: 'ROUTE_CHANGED' } };
    }
    planRecipe = applied.recipe;
  }

  let currentPlan: import('@/types/basket-protocol').DepositPlan;
  let currentFingerprint: string;
  try {
    currentPlan = calculateDepositAllocation(
      { bagId: intent.bagId, inputAsset: intent.inputAsset, amountRaw: intent.inputAmountRaw },
      planRecipe
    );
    currentFingerprint = computeExecutionPlanFingerprint(buildExecutionPlan(currentPlan));
  } catch (err) {
    if (err instanceof InvalidRecipeWeightsError) {
      await updatePurchaseIntentStatus(admin, { id: intentId, from: intent.status, to: 'FAILED', failureCode: 'UNSUPPORTED_ROUTE' });
      return { ok: false, error: { kind: 'ROUTE_CHANGED' } };
    }
    throw err;
  }

  if (currentFingerprint !== intent.routeFingerprint) {
    await updatePurchaseIntentStatus(admin, { id: intentId, from: intent.status, to: 'FAILED', failureCode: 'ROUTE_EXPIRED' });
    return { ok: false, error: { kind: 'ROUTE_CHANGED' } };
  }

  // BAG_EXECUTION_COMPILER_ENABLED — the execute-time half of the
  // `executionPlanHash` lifecycle supabase/migrations/0022_add_execution_plan_hash.sql
  // and `PurchaseIntent.executionPlanHash`'s own doc already describe:
  // `intent.executionPlanHash` is non-null only for an intent CREATED
  // while the flag was on (see createPurchaseIntentForUser above); for
  // such an intent, this re-derives the CURRENT `BagExecutionGraph`'s hash
  // and compares. This is a genuine ADDITIONAL check, not a repeat of the
  // `routeFingerprint` compare above: that one proves the recipe/plan
  // hasn't changed (pre-compiler `ExecutionPlan` shape); this one proves
  // the compiler-layer `BagExecutionGraph` derived from that SAME plan is
  // still the one this intent's steps were actually compiled from. A
  // legacy (flag-off-at-create) intent has `executionPlanHash === null`
  // and skips this block entirely, exactly as the migration doc says.
  // The intent's own provenance decides whether this integrity check applies,
  // not the CURRENT feature-flag state. A compiler-created intent must remain
  // protected even if the rollout flag is later turned off or rolled back;
  // otherwise a stale/tampered graph could bypass the hash check merely by
  // disabling the feature flag between create and execute. Legacy intents have
  // a null hash and naturally skip this block.
  if (intent.executionPlanHash) {
    const graph = buildBagExecutionGraph(buildExecutionPlan(currentPlan), {
      wallet: intent.walletAddress,
      chainId: intent.inputAsset.chain,
      defaultSlippageBps: bagSlippageBps(version),
    });
    const currentGraphHash = computeBagExecutionGraphHash(graph);
    if (currentGraphHash !== intent.executionPlanHash) {
      await updatePurchaseIntentStatus(admin, { id: intentId, from: intent.status, to: 'FAILED', failureCode: 'VERIFICATION_FAILED' });
      return { ok: false, error: { kind: 'ROUTE_CHANGED' } };
    }

    // Second, independent invariant using `purchaseIntentToBagExecutionIntent()`
    // for real (not left as an unused helper — that function's own doc):
    // the STORED intent's own steps, translated back into
    // `BagExecutionTarget[]`, must still name the same assets in the same
    // weights as the FRESHLY rebuilt graph's legs. The hash check above
    // already implies this in practice, but this checks it independently,
    // via a completely different code path (per-field comparison instead
    // of hash equality) — the kind of redundant, cheap-to-run invariant
    // that is worth having specifically because this code moves real
    // money.
    const bagIntent = purchaseIntentToBagExecutionIntent(
      intent,
      intent.inputAsset.chain,
      bagSlippageBps(version),
      new Date(intent.expiresAt).getTime()
    );
    const targetsMatch =
      bagIntent.targets.length === graph.legs.length &&
      bagIntent.targets.every((target, i) => {
        const leg = graph.legs[i];
        return (
          target.asset.chain === leg.targetAsset.chain &&
          target.asset.address === leg.targetAsset.address &&
          target.weightBps === leg.weightBps
        );
      });
    if (!targetsMatch) {
      await updatePurchaseIntentStatus(admin, { id: intentId, from: intent.status, to: 'FAILED', failureCode: 'VERIFICATION_FAILED' });
      return { ok: false, error: { kind: 'ROUTE_CHANGED' } };
    }
  }

  const toStatus = intent.status === 'DRAFT' ? 'QUOTED' : intent.status === 'QUOTED' ? 'READY' : 'AWAITING_SIGNATURE';
  const updated = await updatePurchaseIntentStatus(admin, { id: intentId, from: intent.status, to: toStatus });
  if (!updated) {
    // Lost the race to another concurrent request — re-read and return
    // whatever the winner left behind (still idempotent from the caller's
    // point of view).
    const latest = await getPurchaseIntentForUser(admin, intentId, session.userId);
    return latest.ok ? { ok: true, value: latest.intent } : { ok: false, error: { kind: 'NOT_FOUND' } };
  }

  // READY -> AWAITING_SIGNATURE may need two hops (READY was the initial
  // create status) — recurse once to finish reaching AWAITING_SIGNATURE.
  if (updated.status !== 'AWAITING_SIGNATURE') {
    return prepareExecution(admin, session, intentId);
  }

  return { ok: true, value: updated };
}

// ----------------------------- 3. Per-step client report -----------------------

export type StepReportEvent =
  | { type: 'APPROVAL_REQUIRED' }
  | { type: 'APPROVAL_AWAITING_SIGNATURE' }
  | { type: 'APPROVAL_SUBMITTED'; txHash: string }
  | { type: 'APPROVAL_CONFIRMED' }
  | { type: 'AWAITING_SIGNATURE' }
  | { type: 'SUBMITTED'; txHash: string }
  | { type: 'REJECTED'; failureCode: 'USER_REJECTED' }
  | { type: 'FAILED'; failureCode: PurchaseIntentFailureCode; message?: string };

/**
 * Records what happened for ONE step, as reported by the client wallet
 * flow. Deliberately CANNOT mark a step `COMPLETED` — that only ever
 * happens via `verifyExecution()`'s on-chain check (spec section 12/13:
 * "Fake success" yok — a client claiming success is not evidence of
 * success; `StepReportEvent`'s type has no `COMPLETED` variant, and
 * .../report/route.ts's `parseEvent()` allow-list rejects any request body
 * that tries to claim one at the HTTP layer too — defense at both the
 * type system AND the wire boundary, not just one).
 *
 * A rejection/failure on THIS step fails the whole intent immediately only
 * if no OTHER step has ever been submitted on-chain (Phase 18: if another
 * step DOES already have a real `txHash` in flight, that transaction could
 * still land successfully regardless of this one being rejected/reverted
 * — finalizing the intent here would permanently stop `verifyExecution()`
 * from ever polling and reconciling it, silently losing whatever that
 * other step actually delivers on-chain). In that case this function only
 * records the step's own failure and leaves the intent's own status alone
 * — `verifyExecution()`'s mixed-outcome handling (PARTIAL_SUCCESS /
 * RECONCILIATION_REQUIRED) is what decides the intent's fate once every
 * step has reached a terminal per-step state.
 */
export async function recordStepEvent(
  admin: SupabaseClient,
  session: SessionPayload,
  intentId: string,
  stepIndex: number,
  event: StepReportEvent
): Promise<PurchaseExecutionOutcome<PurchaseIntent>> {
  const owned = await loadOwnedIntent(admin, session.userId, intentId);
  if (!owned.ok) return owned;
  const intent = owned.value;

  if (intent.status !== 'AWAITING_SIGNATURE' && intent.status !== 'SUBMITTED') {
    return { ok: false, error: { kind: 'INVALID_STATE', status: intent.status } };
  }

  const step = intent.steps[stepIndex];
  if (!step) return { ok: false, error: { kind: 'NOT_FOUND' } };
  if (step.action !== 'SWAP') return { ok: false, error: { kind: 'INVALID_STATE', status: step.status } };

  const nextStepStatus =
    event.type === 'REJECTED' || event.type === 'FAILED' ? 'FAILED' : event.type;

  if (!isValidPurchaseIntentStepTransition(step.status, nextStepStatus)) {
    return { ok: false, error: { kind: 'INVALID_STATE', status: step.status } };
  }
  assertValidPurchaseIntentStepTransition(stepIndex, step.status, nextStepStatus);

  if ((event.type === 'SUBMITTED' || event.type === 'APPROVAL_SUBMITTED') && !TX_HASH_RE.test(event.txHash)) {
    return { ok: false, error: { kind: 'INVALID_TX_HASH' } };
  }
  // The hash is only stored here; it is claimed for this intent once the
  // transaction verifies as this intent's own (see intent-tx-claims.ts).

  const updatedStep: PurchaseIntentStepRecord = {
    ...step,
    status: nextStepStatus,
    approvalTxHash: event.type === 'APPROVAL_SUBMITTED' ? event.txHash : step.approvalTxHash,
    txHash: event.type === 'SUBMITTED' ? event.txHash : step.txHash,
    failureCode:
      event.type === 'REJECTED' ? event.failureCode : event.type === 'FAILED' ? event.failureCode : step.failureCode,
  };

  const nextSteps = intent.steps.map((s, i) => (i === stepIndex ? updatedStep : s));
  const updatedIntent = await updatePurchaseIntentSteps(admin, intentId, intent.status, nextSteps);
  if (!updatedIntent) return { ok: false, error: { kind: 'INVALID_STATE', status: intent.status } };

  // First real submission of any step moves the whole intent from
  // AWAITING_SIGNATURE -> SUBMITTED (spec Aşama 6's UI state list).
  if (event.type === 'SUBMITTED' && updatedIntent.status === 'AWAITING_SIGNATURE') {
    const advanced = await updatePurchaseIntentStatus(admin, { id: intentId, from: 'AWAITING_SIGNATURE', to: 'SUBMITTED' });
    if (advanced) return { ok: true, value: advanced };
  }

  if (nextStepStatus === 'FAILED') {
    // Phase 18: don't finalize the whole intent here if a DIFFERENT step
    // already has a real transaction in flight — that transaction's
    // outcome must still be reconciled, not discarded (see this
    // function's doc comment above).
    const anotherStepAlreadySubmitted = updatedIntent.steps.some(
      (s, i) => i !== stepIndex && s.action === 'SWAP' && s.txHash !== null
    );
    if (!anotherStepAlreadySubmitted) {
      const failureCode = event.type === 'REJECTED' ? event.failureCode : event.type === 'FAILED' ? event.failureCode : 'UNKNOWN_ERROR';
      const failed = await updatePurchaseIntentStatus(admin, {
        id: intentId,
        from: updatedIntent.status,
        to: 'FAILED',
        failureCode,
      });
      if (failed) return { ok: true, value: failed };
    }
  }

  return { ok: true, value: updatedIntent };
}

// ----------------------------- 4. Verify + accounting (idempotent) -------------

/**
 * Polls on-chain status for every SUBMITTED SWAP step (spec Aşama 7), and
 * only once EVERY step is confirmed `DONE` with its received asset matching
 * the registry-verified expected asset (spec Aşama 10) does it apply
 * accounting — atomically, via `apply_purchase_execution()` — and mark the
 * intent `COMPLETED`. `accountingAppliedAt` is checked BEFORE calling the
 * RPC, so a retried/racing call never double-applies (spec Aşama 11).
 */
/** How long after an intent's expiry its never-submitted steps count as abandoned. */
export const UNSUBMITTED_STEP_GRACE_MS = 5 * 60 * 1000;

function unsubmittedStepsAbandoned(intent: PurchaseIntent, now: number = Date.now()): boolean {
  return now > new Date(intent.expiresAt).getTime() + UNSUBMITTED_STEP_GRACE_MS;
}

/**
 * A still-open intent for the same (user, bag) blocks a new purchase. Try to
 * settle it first: one that never had a transaction sent is simply
 * cancelled (the buyer walked away before signing anything), and one with
 * transactions out is verified — which also finalizes it once its unsigned
 * steps are abandoned. Returns true when it no longer blocks.
 */
async function settleOpenIntent(admin: SupabaseClient, session: SessionPayload, existing: PurchaseIntent): Promise<boolean> {
  const anySubmitted = existing.steps.some((s) => s.txHash);
  if (!anySubmitted && (existing.status === 'DRAFT' || existing.status === 'QUOTED' || existing.status === 'READY' || existing.status === 'AWAITING_SIGNATURE')) {
    const cancelled = await updatePurchaseIntentStatus(admin, { id: existing.id, from: existing.status, to: 'CANCELLED' });
    return cancelled !== null;
  }
  if (existing.status === 'SUBMITTED' || existing.status === 'CONFIRMING') {
    const verified = await verifyExecution(admin, session, existing.id);
    return verified.ok && TERMINAL_PURCHASE_INTENT_STATUSES.has(verified.value.status);
  }
  return false;
}

/** How many unsettled purchases one call settles (each is one on-chain check, no waiting). */
export const MAX_SETTLE_PER_CALL = 5;

/**
 * Verifies the user's purchases that have a transaction on chain but were never verified (e.g. the purchase
 * window was closed before confirmation), so their shares, holdings and activity are recorded. Same
 * `verifyExecution()` as the purchase flow: on-chain checked, idempotent, scoped to this user's own intents.
 * Never throws: a check that cannot complete now is simply retried on the next call.
 */
export async function settleUnsettledPurchasesForUser(admin: SupabaseClient, session: SessionPayload): Promise<{ checked: number; settled: number }> {
  let intents: PurchaseIntent[];
  try {
    intents = await listUnsettledPurchaseIntentsForUser(admin, session.userId, MAX_SETTLE_PER_CALL);
  } catch {
    return { checked: 0, settled: 0 };
  }
  let settled = 0;
  for (const intent of intents) {
    try {
      const outcome = await verifyExecution(admin, session, intent.id);
      if (outcome.ok && TERMINAL_PURCHASE_INTENT_STATUSES.has(outcome.value.status)) settled++;
    } catch {
      // Retried on the next call.
    }
  }
  return { checked: intents.length, settled };
}

export async function verifyExecution(
  admin: SupabaseClient,
  session: SessionPayload,
  intentId: string
): Promise<PurchaseExecutionOutcome<PurchaseIntent>> {
  const owned = await loadOwnedIntent(admin, session.userId, intentId);
  if (!owned.ok) return owned;
  let intent = owned.value;

  // Idempotent: already terminal — nothing to do.
  if (
    intent.status === 'COMPLETED' ||
    intent.status === 'RECONCILIATION_REQUIRED' ||
    intent.status === 'FAILED' ||
    intent.status === 'CANCELLED' ||
    intent.status === 'EXPIRED'
  ) {
    return { ok: true, value: intent };
  }
  // Phase 18 — PARTIAL_SUCCESS is a valid re-entry point: if a previous
  // call transitioned the intent to PARTIAL_SUCCESS but crashed/failed
  // before `reconcilePartialExecution()` finished (RPC call, or the
  // follow-up status write to RECONCILIATION_REQUIRED), a retried call
  // must resume reconciliation rather than being rejected as an invalid
  // state — `reconcilePartialExecution()` itself is idempotent either way.
  if (intent.status === 'PARTIAL_SUCCESS') {
    return { ok: true, value: await reconcilePartialExecution(admin, intent) };
  }
  if (intent.status !== 'SUBMITTED' && intent.status !== 'CONFIRMING') {
    return { ok: false, error: { kind: 'INVALID_STATE', status: intent.status } };
  }

  // Phase 22 — a Composer-executed intent has ONE shared receipt to check,
  // not N independent LI.FI-tracked routes: fetch it once here rather than
  // once per step inside the map below (same on-chain answer either way,
  // this just avoids N redundant RPC calls for what is, atomically, one
  // transaction).
  let composerOutcome: Awaited<ReturnType<typeof trackComposerTransaction>> | null = null;
  if (intent.composerTransaction) {
    const anySubmittedStep = intent.steps.find((s) => s.action === 'SWAP' && s.txHash);
    if (anySubmittedStep?.txHash) {
      composerOutcome = await trackComposerTransaction({
        txHash: anySubmittedStep.txHash,
        chain: anySubmittedStep.sourceChain,
        recipient: intent.walletAddress,
        expectedTransaction: intent.composerTransaction,
      });
    }
  }

  // Bag Router execution hardening (item 4) — same "one shared receipt,
  // fetched once" shape as the Composer branch above, but checked via
  // `trackBagRouterTransaction()` (lib/blockchain/bag-router-status.ts),
  // never `trackComposerTransaction()`: the BAG Router's own
  // `ExecutionCompleted` event carries plan-identity fields Composer's
  // transaction has no equivalent of, and conflating the two would mean
  // never actually checking them. `intent.bagRouterTransaction` and
  // `intent.composerTransaction` are mutually exclusive by construction
  // (purchase-intent-bridge.ts sets at most one, keyed off the compiled
  // result's `providerId`), but this is still checked as its OWN branch
  // rather than folded into the one above — a BAG Router result must never
  // be verified as if it were a Composer one.
  let bagRouterOutcome: Awaited<ReturnType<typeof trackBagRouterTransaction>> | null = null;
  if (intent.bagRouterTransaction) {
    const anySubmittedStep = intent.steps.find((s) => s.action === 'SWAP' && s.txHash);
    if (anySubmittedStep?.txHash) {
      const swapSteps = intent.steps.filter((s) => s.action === 'SWAP');
      bagRouterOutcome = await trackBagRouterTransaction({
        txHash: anySubmittedStep.txHash,
        chain: anySubmittedStep.sourceChain,
        routerAddress: intent.bagRouterTransaction.to,
        recipient: intent.walletAddress,
        expectedBagId: intent.bagRouterTransaction.bagOnChainId,
        expectedExecutionPlanHash: intent.executionPlanHash ?? '',
        expectedInputToken: intent.bagRouterTransaction.inputToken,
        expectedInputAmountRaw: intent.bagRouterTransaction.inputAmountRaw,
        expectedLegCount: swapSteps.length,
        expectedOutputTokens: swapSteps.map((s) => s.outputAsset.address),
      });
    }
  }

  // Composer / BAG Router: every leg is part of the SAME transaction. A leg
  // whose own txHash never got recorded (parallel step reports used to
  // overwrite each other) is still covered by that one receipt, so it takes
  // the shared hash instead of being treated as "never submitted".
  const sharedTxHash =
    composerOutcome || bagRouterOutcome ? (intent.steps.find((s) => s.action === 'SWAP' && s.txHash)?.txHash ?? null) : null;

  const verifiedSteps: PurchaseIntentStepRecord[] = await Promise.all(
    intent.steps.map(async (recorded): Promise<PurchaseIntentStepRecord> => {
      const step =
        sharedTxHash && recorded.action === 'SWAP' && !recorded.txHash && recorded.status !== 'COMPLETED' && recorded.status !== 'FAILED'
          ? { ...recorded, txHash: sharedTxHash }
          : recorded;
      if (step.action === 'KEEP' || step.status === 'COMPLETED' || step.status === 'FAILED') return step;
      // Never submitted. Once the intent is well past its expiry, nobody is
      // still signing it (the modal was closed or the wallet prompt ignored):
      // fail the step so the intent can reach a final state instead of
      // blocking every later purchase of this Bag forever.
      if (!step.txHash) return unsubmittedStepsAbandoned(intent) ? { ...step, status: 'FAILED', failureCode: 'ROUTE_EXPIRED' } : step;

      // BAG Router path (Bag Router execution hardening, item 4) — checked
      // BEFORE `composerOutcome`, never folded into it: verifies the
      // on-chain `ExecutionCompleted` event's plan identity (see
      // bag-router-status.ts's own doc) in addition to the received-amount
      // check every path shares, and ADDITIONALLY re-checks the received
      // amount against this step's own persisted `minOutputRaw` — a
      // defense-in-depth check on top of the contract's own
      // `InsufficientOutput` revert (a reverted transaction never reaches
      // here at all — see the `TRANSACTION_REVERTED` case below — this
      // guards against the router/plan-signer disagreeing with what this
      // row expects, not against the router's own enforcement failing).
      if (bagRouterOutcome) {
        if (bagRouterOutcome.kind === 'PENDING') {
          return { ...step, status: 'CONFIRMING' };
        }
        if (bagRouterOutcome.kind === 'FAILED') {
          return { ...step, status: 'FAILED', failureCode: bagRouterOutcome.failureCode };
        }
        const received = bagRouterOutcome.receivedAmountsByAddress[step.outputAsset.address.toLowerCase()];
        if (received === undefined) {
          return { ...step, status: 'FAILED', failureCode: 'VERIFICATION_FAILED' };
        }
        if (step.minOutputRaw !== null && BigInt(received) < BigInt(step.minOutputRaw)) {
          return { ...step, status: 'FAILED', failureCode: 'VERIFICATION_FAILED' };
        }
        return { ...step, status: 'COMPLETED', providerSubstatus: 'COMPLETED', outputAmountRaw: received };
      }

      // Composer path — see composer-status.ts's own doc for why this is a
      // direct receipt check, not LI.FI's getStatus(). Same
      // "VERIFICATION_FAILED on any asset mismatch, credit only what was
      // actually received" rule as the sequential path below, just
      // sourced from an on-chain Transfer log instead of a LI.FI status
      // response.
      if (composerOutcome) {
        if (composerOutcome.kind === 'PENDING') {
          return { ...step, status: 'CONFIRMING' };
        }
        if (composerOutcome.kind === 'FAILED') {
          return { ...step, status: 'FAILED', failureCode: composerOutcome.failureCode };
        }
        const received = composerOutcome.receivedAmountsByAddress[step.outputAsset.address.toLowerCase()];
        if (received === undefined) {
          return { ...step, status: 'FAILED', failureCode: 'VERIFICATION_FAILED' };
        }
        if (step.minOutputRaw !== null && BigInt(received) < BigInt(step.minOutputRaw)) {
          return { ...step, status: 'FAILED', failureCode: 'VERIFICATION_FAILED' };
        }
        return { ...step, status: 'COMPLETED', providerSubstatus: 'COMPLETED', outputAmountRaw: received };
      }

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
      // DONE — but only a genuine asset match counts as verified success
      // (spec Aşama 10: wrong destination asset => FAILED/VERIFICATION_FAILED,
      // never silently accepted).
      if (!outcome.matchesExpectedAsset) {
        return { ...step, status: 'FAILED', failureCode: 'VERIFICATION_FAILED' };
      }
      // Accounting below credits whatever was ACTUALLY received on-chain,
      // never the pre-execution quote estimate — a real swap's output can
      // differ from `minOutputRaw`/`outputAmountRaw`'s original quote by up
      // to the step's slippage tolerance, and crediting the bag with the
      // estimate rather than the verified receipt would let a worse-than-
      // quoted fill silently overstate what the bag actually holds.
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
  const nextSteps = await claimNewlyVerifiedTxHashes(admin, 'PURCHASE', intentId, intent.steps, verifiedSteps, (step) => ({
    ...step,
    status: 'FAILED' as const,
    failureCode: 'VERIFICATION_FAILED' as const,
  }));

  const stepsChanged = JSON.stringify(nextSteps) !== JSON.stringify(intent.steps);
  if (stepsChanged) {
    const updated = await updatePurchaseIntentSteps(admin, intentId, intent.status, nextSteps);
    if (updated) intent = updated;
  }

  // Phase 18 — never finalize the intent while ANY SWAP step hasn't yet
  // reached a terminal per-step outcome (COMPLETED or FAILED): a step
  // still PENDING/CONFIRMING could still land on-chain and deliver real
  // assets after we've already decided the intent's fate, which is
  // exactly what the old "first failure wins" logic below this comment
  // used to risk losing.
  const swapSteps = intent.steps.filter((s) => s.action === 'SWAP');
  const stillInFlight = swapSteps.some((s) => s.status !== 'COMPLETED' && s.status !== 'FAILED');

  if (stillInFlight) {
    if (intent.status === 'SUBMITTED') {
      const confirming = await updatePurchaseIntentStatus(admin, { id: intentId, from: 'SUBMITTED', to: 'CONFIRMING' });
      return { ok: true, value: confirming ?? intent };
    }
    return { ok: true, value: intent }; // still confirming, nothing new to report
  }

  const anyCompleted = swapSteps.some((s) => s.status === 'COMPLETED');
  const anyFailed = swapSteps.some((s) => s.status === 'FAILED');

  if (anyFailed && anyCompleted) {
    // Mixed, final outcome: at least one SWAP step's assets are verifiably
    // on-chain (matched the expected asset — see the DONE branch above),
    // at least one genuinely failed, and nothing is left pending. Never
    // collapse this into plain FAILED (would discard the verified
    // holdings the succeeding steps actually received) and never silently
    // COMPLETE it either (would mint the full quoted shares against a
    // deposit that was only partially fulfilled) — PARTIAL_SUCCESS is its
    // own state; reconcilePartialExecution() credits exactly the verified
    // portion and stops at RECONCILIATION_REQUIRED.
    const partial = await updatePurchaseIntentStatus(admin, { id: intentId, from: intent.status, to: 'PARTIAL_SUCCESS' });
    return { ok: true, value: await reconcilePartialExecution(admin, partial ?? intent) };
  }

  if (anyFailed) {
    // Every SWAP step failed — nothing was ever received on-chain, so a
    // plain FAILED (no accounting applied at all) is the correct, complete
    // outcome, same as before Phase 18.
    const failedStep = swapSteps.find((s) => s.status === 'FAILED');
    const failed = await updatePurchaseIntentStatus(admin, {
      id: intentId,
      from: intent.status,
      to: 'FAILED',
      failureCode: failedStep?.failureCode ?? 'UNKNOWN_ERROR',
    });
    return { ok: true, value: failed ?? intent };
  }

  // Every SWAP step COMPLETED (KEEP steps are always NOT_NEEDED/trivially
  // done). A transaction that had already landed by the FIRST verify (a
  // single Composer / BAG Router tx, or fast sequential legs) reaches here
  // straight from SUBMITTED, but the state machine only allows COMPLETED
  // from CONFIRMING — so step through it first, BEFORE any accounting, or
  // the final write throws after accounting was already applied.
  if (intent.status === 'SUBMITTED') {
    const confirming = await updatePurchaseIntentStatus(admin, { id: intentId, from: 'SUBMITTED', to: 'CONFIRMING' });
    // Lost a race with a concurrent verify: report the current state; the next poll finishes it.
    if (!confirming) return { ok: true, value: intent };
    intent = confirming;
  }

  // Apply the FULL accounting exactly once.
  if (!intent.accountingAppliedAt) {
    await applyAccountingIdempotently(admin, intent);
  }
  // Fresh NAV snapshot so listings show the new TVL right away. Best effort:
  // a pricing hiccup here never affects the purchase/redemption outcome.
  await recordNavSnapshot(admin, intent.bagId, { minIntervalMs: 0 }).catch(() => undefined);

  const completed = await updatePurchaseIntentStatus(admin, {
    id: intentId,
    from: intent.status,
    to: 'COMPLETED',
    executedAt: new Date().toISOString(),
  });
  return { ok: true, value: completed ?? intent };
}

/**
 * Phase 18 — credits `bag_holdings` for exactly the SWAP steps that
 * genuinely completed on-chain (verified by `trackStepStatus()` inside
 * `verifyExecution()` above — never a client-reported success) plus any
 * KEEP allocations (never routed/never failable — see
 * lib/blockchain/lifi-execution-adapter.ts's module doc), for an intent
 * that ended in a mixed COMPLETED/FAILED outcome. Deliberately does NOT
 * mint any shares — see `RECONCILIATION_REQUIRED`'s doc comment on
 * `PURCHASE_INTENT_STATUSES` (types/purchase-intent.ts) for why inventing
 * a partial share-mint or refund here would be worse than stopping and
 * leaving the verified state visible for a follow-up process.
 *
 * Idempotent via `reconciliation_applied_at`, checked and set inside
 * `apply_partial_purchase_execution()` under the same row-lock pattern
 * `apply_purchase_execution()` already uses (see its own doc comment on
 * `applyAccountingIdempotently()` below) — a retried/racing call never
 * double-credits.
 */
/**
 * The share of a partially executed purchase that actually happened:
 * `spent / requested` of the input, where `spent` counts COMPLETED swap legs
 * and KEEP allocations. Shares and cost basis scale by that fraction (both
 * floored, so a partial fill never mints more than it paid for).
 */
export function partialPurchaseShare(intent: PurchaseIntent): { spentRaw: string; sharesRaw: string; costBasis: string } {
  const requested = BigInt(intent.inputAmountRaw);
  const spent = intent.steps
    .filter((st) => st.action === 'KEEP' || (st.action === 'SWAP' && st.status === 'COMPLETED'))
    .reduce((sum, st) => sum + BigInt(st.inputAmountRaw), BigInt(0));
  if (requested === BigInt(0) || spent === BigInt(0)) return { spentRaw: '0', sharesRaw: '0', costBasis: '0' };
  const capped = spent > requested ? requested : spent;
  const sharesRaw = ((BigInt(intent.sharesRaw) * capped) / requested).toString();
  return { spentRaw: capped.toString(), sharesRaw, costBasis: scaleDecimalString(intent.depositAmount, capped, requested) };
}

/** `value * num / den` for a non-negative decimal string, exact to 18 places (floored), trailing zeros trimmed. */
function scaleDecimalString(value: string, num: bigint, den: bigint): string {
  const [whole, frac = ''] = value.trim().split('.');
  const scale = BigInt(10) ** BigInt(18);
  const scaled = BigInt(whole || '0') * scale + BigInt((frac + '0'.repeat(18)).slice(0, 18) || '0');
  const out = (scaled * num) / den;
  const outFrac = (out % scale).toString().padStart(18, '0').replace(/0+$/, '');
  return outFrac ? `${out / scale}.${outFrac}` : (out / scale).toString();
}

/**
 * Accounting V2 / A3: each credited leg carries its share of the cost basis (`cost_quote`), split across legs in
 * proportion to the input each leg spent, exactly (parts sum to the total). Recorded on the ledger leg; the
 * investor tables are unchanged.
 */
export function withLegCosts<T extends { input_raw: string }>(holdings: T[], totalCost: string): (Omit<T, 'input_raw'> & { cost_quote: string })[] {
  const costs = splitDecimal(totalCost, holdings.map((h) => BigInt(h.input_raw)));
  return holdings.map(({ input_raw: _input, ...h }, i) => ({ ...h, cost_quote: costs[i] }));
}

async function reconcilePartialExecution(admin: SupabaseClient, intent: PurchaseIntent): Promise<PurchaseIntent> {
  if (!intent.reconciliationAppliedAt) {
    assertCompletedSwapsCreditable(intent);
    const completedSwapHoldings = intent.steps
      .filter((s) => s.action === 'SWAP' && s.status === 'COMPLETED' && s.outputAmountRaw && s.outputDecimals !== null)
      .map((s) => ({
        chain: s.outputAsset.chain,
        address: s.outputAsset.address,
        decimals: s.outputDecimals as number,
        delta_raw: s.outputAmountRaw as string,
        input_raw: s.inputAmountRaw,
      }));
    const keepHoldings = intent.steps
      .filter((s) => s.action === 'KEEP' && s.outputDecimals !== null)
      .map((s) => ({
        chain: s.outputAsset.chain,
        address: s.outputAsset.address,
        decimals: s.outputDecimals as number,
        delta_raw: s.inputAmountRaw,
        input_raw: s.inputAmountRaw,
      }));

    // Shares and cost basis for the part that actually executed: pro rata
    // to the input spent by completed swaps plus KEEP allocations (never
    // failed or unsigned legs, whose input never left the wallet).
    const partial = partialPurchaseShare(intent);
    const { error: partialRpcError } = await admin.rpc('apply_partial_purchase_execution', {
      p_intent_id: intent.id,
      p_bag_id: intent.bagId,
      p_holdings: withLegCosts([...completedSwapHoldings, ...keepHoldings], partial.costBasis),
      p_user_id: intent.userId,
      p_shares_delta_raw: partial.sharesRaw,
      p_share_decimals: intent.shareDecimals,
      p_cost_basis_delta: partial.costBasis,
    });
    // Never advance to RECONCILIATION_REQUIRED (which implies "verified
    // holdings are now recorded") if the RPC itself reported an error —
    // that would misrepresent what actually happened. Left in
    // PARTIAL_SUCCESS, a retried verifyExecution() call re-enters this
    // same function and tries again (idempotent either way).
    if (partialRpcError) throw new Error(`apply_partial_purchase_execution failed: ${partialRpcError.message}`);

    await markReconciliationApplied(admin, intent.id);
  }

  const reconciled = await updatePurchaseIntentStatus(admin, {
    id: intent.id,
    from: 'PARTIAL_SUCCESS',
    to: 'RECONCILIATION_REQUIRED',
  });
  return reconciled ?? intent;
}

/**
 * Applies holdings + share-mint accounting for one fully-verified intent,
 * via the atomic, self-idempotent `apply_purchase_execution()` RPC
 * (supabase/migrations/0004_add_purchase_intents.sql — it takes its own row
 * lock on `purchase_intents` and checks `accounting_applied_at` itself, so
 * this function is safe to call even if two `verifyExecution()` calls race
 * — only one of them will actually write, the other gets `alreadyApplied:
 * true` back). `markAccountingApplied()` is still called afterwards purely
 * so the in-process `PurchaseIntent` this function's caller already holds
 * reflects the new state without a second round trip — it is belt-and-
 * suspenders, not the source of truth for the guard.
 */
/**
 * Invariant: a verified SWAP step always has an amount and decimals to
 * credit. `apply_purchase_execution()` credits holdings only for steps that
 * do but mints the intent's shares regardless, so an unusable step would
 * mint shares with no backing assets on the books. Refuse instead — the
 * intent stays verified-but-unapplied and visible rather than silently
 * mis-accounted.
 */
function assertCompletedSwapsCreditable(intent: PurchaseIntent): void {
  const bad = intent.steps.filter(
    (s) => s.action === 'SWAP' && s.status === 'COMPLETED' && (!s.outputAmountRaw || s.outputDecimals === null)
  );
  if (bad.length > 0) {
    throw new Error(
      `Intent ${intent.id}: completed SWAP step(s) ${bad.map((s) => s.stepIndex).join(', ')} lack output amount/decimals — refusing to apply accounting.`
    );
  }
}

async function applyAccountingIdempotently(admin: SupabaseClient, intent: PurchaseIntent): Promise<void> {
  if (intent.accountingAppliedAt) return;
  assertCompletedSwapsCreditable(intent);

  // SWAP steps credit the asset they actually swapped INTO.
  const swapHoldings = intent.steps
    .filter((s) => s.action === 'SWAP' && s.status === 'COMPLETED' && s.outputAmountRaw && s.outputDecimals !== null)
    .map((s) => ({
      chain: s.outputAsset.chain,
      address: s.outputAsset.address,
      decimals: s.outputDecimals as number,
      delta_raw: s.outputAmountRaw as string,
      input_raw: s.inputAmountRaw,
    }));

  // KEEP steps stay as the input asset itself — their value was never
  // routed anywhere, so they credit bag_holdings directly with the exact
  // portion of the deposit this step allocated. `outputDecimals` is set at
  // intent-creation time to the INPUT asset's decimals for every KEEP step
  // (see lib/blockchain/lifi-purchase-quote.ts — a KEEP step's
  // outputAsset === inputAsset by construction), so this never guesses.
  const keepHoldings = intent.steps
    .filter((s) => s.action === 'KEEP' && s.outputDecimals !== null)
    .map((s) => ({
      chain: s.outputAsset.chain,
      address: s.outputAsset.address,
      decimals: s.outputDecimals as number,
      delta_raw: s.inputAmountRaw,
      input_raw: s.inputAmountRaw,
    }));

  const holdings = withLegCosts([...swapHoldings, ...keepHoldings], intent.depositAmount);

  // Phase 22, Layer 3 — fork royalty. Resolved fresh here (never trusted
  // from the client): only paid when THIS bag has a root_bag_id (i.e. it's
  // a fork), and to the ROOT bag's creator specifically — not this bag's
  // own creator (a fork's own creatorId is whoever forked it, a different
  // person in the common case).
  let rootCreatorId: string | null = null;
  const bag = await getBagById(admin, intent.bagId);
  if (bag?.rootBagId) {
    const rootBag = await getBagById(admin, bag.rootBagId);
    rootCreatorId = rootBag?.creatorId ?? null;
  }

  const { error: rpcError } = await admin.rpc('apply_purchase_execution', {
    p_intent_id: intent.id,
    p_bag_id: intent.bagId,
    p_holdings: holdings,
    p_shares_delta_raw: intent.sharesRaw,
    p_share_decimals: intent.shareDecimals,
    p_user_id: intent.userId,
    // Phase 20 — this depositor's bag_investor_positions cost-basis delta;
    // see depositAmount's doc comment on PurchaseIntent for why this value
    // (not a sharePriceAtQuote * sharesRaw derivation) is used.
    p_cost_basis_delta: intent.depositAmount,
    p_fork_royalty_bps: rootCreatorId ? FORK_ROYALTY_BPS : 0,
    p_root_creator_id: rootCreatorId,
  });
  // Same reasoning as reconcilePartialExecution() above: never mark
  // accounting applied (-> COMPLETED) on the strength of an RPC call that
  // itself reported failure.
  //
  // 0017 — apply_purchase_execution() now inserts the matching
  // creator_reward_settlements row itself, atomically, in the SAME
  // transaction as the royalty's own activities row (see that migration's
  // module doc: an earlier version of this bridge done here in
  // TypeScript, as a second statement after this RPC call, had a real
  // crash-window bug — a process crash between the two statements meant
  // the royalty could never get a settlement row via the normal path
  // again). Nothing left to do here.
  if (rpcError) throw new Error(`apply_purchase_execution failed: ${rpcError.message}`);

  await markAccountingApplied(admin, intent.id);
}
