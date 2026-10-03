import { BagMutability, BasketRecipe, DEFAULT_UNROUTABLE_POLICY, MAX_PERFORMANCE_FEE_BPS, MAX_UNROUTABLE_WEIGHT_BPS } from '@/types/basket-protocol';
import { MAX_ACCEPTABLE_PRICE_IMPACT_BPS } from '@/types/purchase-intent';
import { CompositionChangeMode, STRATEGY_POLICY_SCHEMA_VERSION, StrategyPolicy } from '@/types/strategy-policy';
import { bagSlippageBps } from '@/lib/server/purchase-execution';

// -----------------------------------------------------------------------------
// Builds a Bag's StrategyPolicy (types/strategy-policy.ts) from the rules BAG
// already applies — each value is read exactly the way the code path that
// enforces it reads it:
//   max/min weight, max assets  → validateBasketRecipe() at version creation
//   min investment              → purchase-preview.ts (preview + purchase)
//   max slippage                → bagSlippageBps(), the per-swap minimum output in the tx
//   max price impact            → LI.FI Composer's compile limit (Composer purchases only)
//   consent ceiling             → MAX_ACCEPTABLE_PRICE_IMPACT_BPS, checked by the purchase-intent route
//   performance fee             → recipe_performance_fee_bps() cap + 0033 lock triggers
//   no-route policy             → applyUnroutablePolicy() at purchase creation
//   composition changes         → create_bag_version() triggers (immutable / deployed)
//   rebalance rule              → stored only; nothing executes it
// -----------------------------------------------------------------------------

/** LI.FI Composer's own default whole-transaction price-impact limit (see lifi-composer-adapter.ts). */
export const COMPOSER_DEFAULT_MAX_PRICE_IMPACT_BPS = 500;

export type PolicyRecipe = Pick<BasketRecipe, 'maxWeightBps' | 'minWeightBps' | 'maxAssets' | 'minInvestment' | 'rebalanceRule'> &
  Partial<Pick<BasketRecipe, 'performanceFeeBps' | 'unroutablePolicy'>>;

export interface PolicyContext {
  mutability: BagMutability;
  /** True once the Bag is deployed on-chain. */
  deployed: boolean;
  /** Non-null once the fee locked (first external investor). */
  performanceFeeBpsLocked: number | null;
}

export function deriveStrategyPolicy(recipe: PolicyRecipe, ctx: PolicyContext): StrategyPolicy {
  const chosenSlippage = recipe.rebalanceRule?.maxSlippageBps;
  const slippageFromRecipe = typeof chosenSlippage === 'number' && Number.isFinite(chosenSlippage) && chosenSlippage > 0;
  const feeLocked = ctx.performanceFeeBpsLocked !== null;
  const compositionMode: CompositionChangeMode =
    ctx.mutability === 'IMMUTABLE' ? 'IMMUTABLE' : ctx.deployed ? 'ONCHAIN_VERSION_ONLY' : 'CREATOR_EDITABLE';

  const version = { flows: ['VERSION' as const], providers: null };
  const purchase = { flows: ['PURCHASE' as const], providers: null };
  const composerPurchase = { flows: ['PURCHASE' as const], providers: ['LIFI_COMPOSER' as const] };

  return {
    schemaVersion: STRATEGY_POLICY_SCHEMA_VERSION,
    maxSingleAssetWeightBps: { value: recipe.maxWeightBps, scope: version, source: 'CREATOR_RECIPE', enforcement: 'SERVER_ENFORCED', enforcedAt: ['VERSION_CREATE'], status: 'ACTIVE' },
    minSingleAssetWeightBps: { value: recipe.minWeightBps, scope: version, source: 'CREATOR_RECIPE', enforcement: 'SERVER_ENFORCED', enforcedAt: ['VERSION_CREATE'], status: 'ACTIVE' },
    maxAssets: { value: recipe.maxAssets, scope: version, source: 'CREATOR_RECIPE', enforcement: 'SERVER_ENFORCED', enforcedAt: ['VERSION_CREATE'], status: 'ACTIVE' },
    minInvestmentUsd: {
      value: recipe.minInvestment ?? 0,
      scope: purchase,
      source: 'CREATOR_RECIPE',
      enforcement: 'SERVER_ENFORCED',
      enforcedAt: ['PURCHASE_CREATE'],
      status: 'ACTIVE',
      measuredAs: 'PAYMENT_TOKEN_AMOUNT',
    },
    maxSlippageBps: {
      value: bagSlippageBps({ recipe: recipe as BasketRecipe }),
      // Every purchase provider builds its per-swap minimum from bagSlippageBps; redeem swaps do not use it.
      scope: purchase,
      source: slippageFromRecipe ? 'CREATOR_RECIPE' : 'BAG_PROTOCOL',
      enforcement: 'ONCHAIN_ENFORCED',
      enforcedAt: ['PURCHASE_TRANSACTION'],
      status: 'ACTIVE',
    },
    maxPriceImpactBps: {
      value: COMPOSER_DEFAULT_MAX_PRICE_IMPACT_BPS,
      // Only LI.FI Composer computes and limits price impact; the BAG Router and sequential paths do not.
      scope: composerPurchase,
      source: 'LIFI_COMPOSER',
      enforcement: 'COMPOSER_ENFORCED',
      enforcedAt: ['COMPOSER_COMPILE'],
      status: 'ACTIVE',
    },
    priceImpactConsentCeilingBps: {
      value: MAX_ACCEPTABLE_PRICE_IMPACT_BPS,
      scope: composerPurchase,
      source: 'BAG_PROTOCOL',
      enforcement: 'SERVER_ENFORCED',
      enforcedAt: ['PURCHASE_CREATE'],
      status: 'ACTIVE',
    },
    performanceFeeBps: {
      value: feeLocked ? (ctx.performanceFeeBpsLocked as number) : (recipe.performanceFeeBps ?? 0),
      scope: version,
      source: 'CREATOR_RECIPE',
      enforcement: 'DATABASE_TRIGGER',
      enforcedAt: ['DATABASE_WRITE'],
      status: feeLocked ? 'LOCKED' : 'ACTIVE',
      maxBps: MAX_PERFORMANCE_FEE_BPS,
    },
    noRouteAssetPolicy: {
      value: recipe.unroutablePolicy ?? DEFAULT_UNROUTABLE_POLICY,
      scope: purchase,
      source: recipe.unroutablePolicy ? 'CREATOR_RECIPE' : 'BAG_PROTOCOL',
      enforcement: 'SERVER_ENFORCED',
      enforcedAt: ['PURCHASE_CREATE'],
      status: 'ACTIVE',
      maxUnroutableWeightBps: MAX_UNROUTABLE_WEIGHT_BPS,
    },
    rebalanceRule: {
      value: { frequency: recipe.rebalanceRule.frequency, driftThresholdBps: recipe.rebalanceRule.driftThresholdBps },
      scope: { flows: [], providers: null },
      source: 'CREATOR_RECIPE',
      enforcement: 'DECLARED_ONLY',
      enforcedAt: [],
      status: 'NOT_EXECUTED',
    },
    compositionChanges: {
      value: compositionMode,
      scope: version,
      source: compositionMode === 'ONCHAIN_VERSION_ONLY' ? 'BAG_PROTOCOL' : 'CREATOR_RECIPE',
      enforcement: 'DATABASE_TRIGGER',
      enforcedAt: ['DATABASE_WRITE'],
      status: compositionMode === 'IMMUTABLE' ? 'LOCKED' : 'ACTIVE',
    },
  };
}
