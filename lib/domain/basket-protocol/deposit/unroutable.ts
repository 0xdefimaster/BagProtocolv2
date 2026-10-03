import {
  AssetIdentity,
  BasketRecipe,
  DEFAULT_UNROUTABLE_POLICY,
  MAX_UNROUTABLE_WEIGHT_BPS,
  RecipeAsset,
  UnroutablePolicy,
} from '@/types/basket-protocol';
import { assetIdentitiesEqual } from '../asset-identity';

// -----------------------------------------------------------------------------
// Applies a Bag's unroutable-asset policy (types/basket-protocol.ts,
// `UNROUTABLE_POLICIES`) to its recipe for ONE purchase, producing the
// "effective" recipe the rest of the unchanged deposit pipeline runs on:
//
//   HOLD_INPUT — each unroutable asset's weight moves onto the payment
//                (input) asset. calculateDepositAllocation() then marks that
//                entry KEEP, so the stablecoin is credited to holdings as-is
//                and shares are minted for the full deposit.
//   REFUND     — unroutable assets are dropped and the remaining weights are
//                renormalized to 100%; the deposit amount is scaled by the
//                routable share (`amountScaleBps`), so each routable asset
//                still receives the same value it would have in a full buy.
//
// Pure and deterministic: create-intent and prepareExecution both call it
// with the same stored inputs, so the plan fingerprint re-derives exactly.
// -----------------------------------------------------------------------------

const TOTAL_BPS = 10_000;

export interface UnroutableInputAsset extends AssetIdentity {
  symbol: string;
  decimals: number;
}

export type ApplyUnroutablePolicyResult =
  | {
      ok: true;
      recipe: BasketRecipe;
      /** Share of the typed amount actually spent, in bps (10000 = all of it). Below 10000 only for REFUND. */
      amountScaleBps: number;
      /** Recipe weight of the assets that were held or refunded (0 when nothing was unroutable). */
      unroutableWeightBps: number;
      /** The recipe assets the policy applied to, in recipe order. */
      affected: RecipeAsset[];
    }
  | { ok: false; reason: 'BLOCKED' | 'TOO_MUCH_UNROUTABLE'; unroutableWeightBps: number; affected: RecipeAsset[] };

export function applyUnroutablePolicy(
  recipe: BasketRecipe,
  inputAsset: UnroutableInputAsset,
  unroutable: AssetIdentity[],
  policy: UnroutablePolicy = recipe.unroutablePolicy ?? DEFAULT_UNROUTABLE_POLICY
): ApplyUnroutablePolicyResult {
  const isInput = (a: AssetIdentity) => assetIdentitiesEqual(a, inputAsset);
  const affected = recipe.assets.filter((a) => !isInput(a) && unroutable.some((u) => assetIdentitiesEqual(u, a)));
  const unroutableWeightBps = affected.reduce((sum, a) => sum + a.weightBps, 0);

  if (affected.length === 0 || unroutableWeightBps === 0) {
    return { ok: true, recipe, amountScaleBps: TOTAL_BPS, unroutableWeightBps: 0, affected: [] };
  }
  if (policy === 'BLOCK') return { ok: false, reason: 'BLOCKED', unroutableWeightBps, affected };
  if (unroutableWeightBps > MAX_UNROUTABLE_WEIGHT_BPS) {
    return { ok: false, reason: 'TOO_MUCH_UNROUTABLE', unroutableWeightBps, affected };
  }

  const remaining = recipe.assets.filter((a) => !affected.includes(a));

  if (policy === 'HOLD_INPUT') {
    const existingInput = remaining.find(isInput);
    const assets = existingInput
      ? remaining.map((a) => (a === existingInput ? { ...a, weightBps: a.weightBps + unroutableWeightBps } : a))
      : [
          ...remaining,
          {
            chain: inputAsset.chain,
            address: inputAsset.address,
            symbol: inputAsset.symbol,
            decimals: inputAsset.decimals,
            weightBps: unroutableWeightBps,
          },
        ];
    return { ok: true, recipe: { ...recipe, assets }, amountScaleBps: TOTAL_BPS, unroutableWeightBps, affected };
  }

  // REFUND: renormalize the routable weights to 100% (floor, remainder to the
  // largest weight so the sum is exact).
  const routableBps = TOTAL_BPS - unroutableWeightBps;
  const scaled = remaining.map((a) => ({ ...a, weightBps: Math.floor((a.weightBps * TOTAL_BPS) / routableBps) }));
  const remainder = TOTAL_BPS - scaled.reduce((sum, a) => sum + a.weightBps, 0);
  if (remainder !== 0) {
    const largest = scaled.reduce((best, a, i) => (a.weightBps > scaled[best].weightBps ? i : best), 0);
    scaled[largest] = { ...scaled[largest], weightBps: scaled[largest].weightBps + remainder };
  }
  return {
    ok: true,
    // The creator's minimum applies to what the buyer typed, not the reduced
    // spend, so scale it by the same factor for this purchase.
    recipe: { ...recipe, assets: scaled, minInvestment: (recipe.minInvestment * routableBps) / TOTAL_BPS },
    amountScaleBps: routableBps,
    unroutableWeightBps,
    affected,
  };
}

/** `amountRaw * scaleBps / 10000`, floored — the part of a deposit REFUND actually spends. */
export function scaleAmountRaw(amountRaw: string, scaleBps: number): string {
  return ((BigInt(amountRaw) * BigInt(scaleBps)) / BigInt(TOTAL_BPS)).toString();
}

/** Exact raw -> human decimal string ("1500000", 6 -> "1.5"), no float. */
export function rawToDecimalString(amountRaw: string, decimals: number): string {
  const raw = BigInt(amountRaw);
  if (decimals === 0) return raw.toString();
  const base = BigInt(10) ** BigInt(decimals);
  const frac = (raw % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return frac ? `${raw / base}.${frac}` : (raw / base).toString();
}
