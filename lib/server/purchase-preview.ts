import { AssetIdentity, BasketRecipe, DepositAllocation, DepositPlan, DepositQuote, ExecutionPlan, NavResult, ShareSupply } from '@/types/basket-protocol';
import { calculateDepositAllocation, InvalidRecipeWeightsError } from '@/lib/domain/basket-protocol/deposit/allocation';
import { buildExecutionPlan } from '@/lib/domain/basket-protocol/deposit/execution-plan';
import { getDepositQuote, OrphanedNavError, ZeroNavError, ZeroShareSupplyError } from '@/lib/domain/basket-protocol/shares/shares';
import { isValidDecimalString, toProtocolPrice } from '@/lib/domain/basket-protocol/pricing/price-precision';
import { assetIdentitiesEqual } from '@/lib/domain/basket-protocol/asset-identity';

// -----------------------------------------------------------------------------
// Phase 12 — One-click Bag purchase PREVIEW. The only new "business logic"
// in this file is wiring four existing, independently-tested pure domain
// functions together in the documented order (see the DepositRequest ->
// ... -> ExecutionPlan pipeline in types/basket-protocol.ts's Phase 10
// module doc); no NAV, allocation, or share math is written here. Nothing
// in this module sends a transaction, calls a router/aggregator, or mints
// a share — see PREVIEW_DISCLAIMER below, surfaced verbatim to the UI.
//
// Share supply (Phase 13): `shareSupply` is supplied by the caller — see
// `ComputePurchasePreviewInput` — sourced from `lib/server/
// bag-share-state-repo.ts`'s `getShareSupply()`, never hardcoded here.
// Before Phase 13, every Bag was silently priced as zero-supply
// (bootstrap) because no persistence for share state existed yet; now
// that it does, a Bag that has actually had shares minted correctly
// leaves the bootstrap branch of `getDepositQuote()` and prices against
// its real NAV/share instead. `PurchasePreviewResult.isBootstrap` still
// exists and is still accurate — it now reflects the Bag's REAL state,
// not a value this file assumed.
// -----------------------------------------------------------------------------

export const PREVIEW_DISCLAIMER =
  'Preview only — no funds move, no swap is quoted or executed, and no BAG shares are minted.';

export type PurchasePreviewError =
  | { kind: 'INVALID_AMOUNT' }
  | { kind: 'ZERO_AMOUNT' }
  | { kind: 'INVALID_RECIPE'; message: string }
  | { kind: 'NAV_UNAVAILABLE'; message: string }
  | { kind: 'BELOW_MIN_INVESTMENT'; minimum: number; message: string };

export interface PurchasePreviewResult {
  ok: true;
  disclaimer: string;
  inputAsset: AssetIdentity;
  inputSymbol: string;
  inputAmountRaw: string;
  inputAmountDisplay: string;
  depositPlan: DepositPlan;
  depositQuote: DepositQuote;
  executionPlan: ExecutionPlan;
  navQuoteCurrency: string;
  navGross: string;
  isBootstrap: boolean;
}

export type PurchasePreviewOutcome = PurchasePreviewResult | { ok: false; error: PurchasePreviewError };

export interface ComputePurchasePreviewInput {
  recipe: BasketRecipe;
  inputAsset: AssetIdentity;
  inputSymbol: string;
  inputDecimals: number;
  /** Human decimal string, e.g. "100" — never a raw/scaled unit. */
  amount: string;
  /**
   * The Bag's CURRENT NAV — computed by the caller via `getBagNav()`
   * (lib/server/bag-nav.ts) from actual `bag_holdings`, never derived here
   * from recipe weights (see this file's module doc on why that
   * distinction matters). Passed in rather than computed inside this
   * function so this stays a pure, synchronous, easily-testable pipeline —
   * fetching holdings is the caller's job, exactly like every other
   * function in this Phase 10 pipeline already keeps I/O at its edges.
   */
  nav: NavResult;
  /**
   * The Bag's CURRENT share supply (Phase 13) — computed by the caller via
   * `getShareSupply()` (lib/server/bag-share-state-repo.ts), same
   * caller-supplies-the-I/O convention as `nav` above. A Bag that has
   * never had a row written returns a zero-supply `ShareSupply` from that
   * function (never from this one) — this file has no bootstrap default
   * of its own to fall back to, by design, so it can never silently drift
   * from whatever the persistence layer actually decides "no data yet"
   * means.
   */
  shareSupply: ShareSupply;
}

/**
 * The full Phase 10 pipeline (DepositRequest -> DepositPlan -> DepositQuote
 * -> ExecutionPlan). Pure and synchronous — no Supabase, no I/O, nothing
 * mutated; `nav` is supplied by the caller (see `ComputePurchasePreviewInput`).
 */
export function computePurchasePreview(input: ComputePurchasePreviewInput): PurchasePreviewOutcome {
  const amount = input.amount.trim();
  if (!isValidDecimalString(amount) || amount.startsWith('-')) {
    return { ok: false, error: { kind: 'INVALID_AMOUNT' } };
  }
  const amountRaw = toProtocolPrice(amount, input.inputDecimals);
  if (amountRaw <= BigInt(0)) {
    return { ok: false, error: { kind: 'ZERO_AMOUNT' } };
  }

  const depositRequest = {
    bagId: input.recipe.bagId,
    inputAsset: input.inputAsset,
    amountRaw: amountRaw.toString(),
  };

  let depositPlan: DepositPlan;
  try {
    depositPlan = calculateDepositAllocation(depositRequest, input.recipe);
  } catch (err) {
    if (err instanceof InvalidRecipeWeightsError) {
      return { ok: false, error: { kind: 'INVALID_RECIPE', message: err.message } };
    }
    throw err;
  }

  const executionPlan = buildExecutionPlan(depositPlan);

  let depositQuote: DepositQuote;
  try {
    depositQuote = getDepositQuote(input.nav, input.shareSupply, amount);
  } catch (err) {
    if (err instanceof OrphanedNavError || err instanceof ZeroNavError) {
      return { ok: false, error: { kind: 'NAV_UNAVAILABLE', message: err.message } };
    }
    if (err instanceof ZeroShareSupplyError) {
      // Should be unreachable — getDepositQuote() bootstraps at zero
      // supply rather than throwing this — but handled explicitly rather
      // than left to bubble up as a 500 if that invariant ever changes.
      return { ok: false, error: { kind: 'NAV_UNAVAILABLE', message: 'Share quote unavailable.' } };
    }
    throw err;
  }

  // The creator's minimum deposit (recipe.minInvestment, quote currency).
  // Enforced here so the preview and the purchase paths apply the same rule.
  const minimum = input.recipe.minInvestment ?? 0;
  if (minimum > 0 && Number(depositQuote.depositAmount) < minimum) {
    return {
      ok: false,
      error: { kind: 'BELOW_MIN_INVESTMENT', minimum, message: `The minimum investment for this Bag is $${minimum}.` },
    };
  }

  return {
    ok: true,
    disclaimer: PREVIEW_DISCLAIMER,
    inputAsset: input.inputAsset,
    inputSymbol: input.inputSymbol,
    inputAmountRaw: amountRaw.toString(),
    inputAmountDisplay: amount,
    depositPlan,
    depositQuote,
    executionPlan,
    navQuoteCurrency: input.nav.quoteCurrency,
    navGross: input.nav.grossNav,
    isBootstrap: depositQuote.isBootstrap,
  };
}

/** True iff `allocation.action === 'KEEP'` because its target asset is the deposit's own input asset — mirrors the identity check `calculateDepositAllocation()` already applies (never re-derived from symbols). */
export function isKeepAllocation(allocation: DepositAllocation, inputAsset: AssetIdentity): boolean {
  return allocation.action === 'KEEP' && assetIdentitiesEqual(allocation.targetAsset, inputAsset);
}
