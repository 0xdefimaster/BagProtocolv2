import { AssetIdentity, BasketRecipe, RecipeAsset, ValidationIssue, ValidationSeverity } from '@/types/basket-protocol';
import { assetIdentityKey, recipeAssetIdentity } from '../asset-identity';
import { VALIDATION_CODES } from './codes';

// -----------------------------------------------------------------------------
// External (registry-backed) validation — deliberately NOT one of the
// `VALIDATORS` composed by `validateBasketRecipe()` in ./index.ts.
// `validateBasketRecipe()` must stay pure structural validation (spec
// section 10: "Bunu database'e bağlayıp pure validator'ı bozma") — this is
// a SEPARATE pure function instead: it still takes plain data in and
// returns plain data out (no Supabase call happens here), it's just that
// the caller is expected to have already fetched that data from
// `lib/server/asset-repo.ts`'s `getVerifiedIdentityKeys()` before calling
// this. The split is:
//
//   pure structural validation      →  validateBasketRecipe()      (./index.ts)
//   + external registry validation  →  validateRecipeAssetsAgainstRegistry() (here)
//
// Callers run both and merge the issues, the same way `getErrors()`/
// `getWarnings()` already merge issues from multiple validators.
// -----------------------------------------------------------------------------

/**
 * The actual "is this identity verified" check, extracted so
 * `lib/server/bag-holdings.ts`'s holdings-vs-registry check (Phase 7) can
 * reuse the exact same logic instead of re-implementing it — spec section
 * 8: "Aynı validation mantığını yeniden yazma." `validateRecipeAssetsAgainstRegistry`
 * below is now a thin wrapper that turns this into recipe-shaped
 * `ValidationIssue`s; a holdings check can call this directly and shape
 * its own result differently, since a `BagHolding` isn't a `RecipeAsset`
 * and has no `symbol`/`path` to report.
 */
export function findUnverifiedIdentities(
  identities: AssetIdentity[],
  verifiedIdentityKeys: Set<string>
): AssetIdentity[] {
  return identities.filter((identity) => !verifiedIdentityKeys.has(assetIdentityKey(identity)));
}

export interface RegistryValidationOptions {
  /** Set of `assetIdentityKey()` strings for VERIFIED assets, scoped to (at least) every asset this recipe references — see `lib/server/asset-repo.ts`'s `getVerifiedIdentityKeys()`. */
  verifiedIdentityKeys: Set<string>;
  /**
   * Draft saves only need a WARNING (spec section 14 — "Draft aşamasında
   * warning olabilir"); publish/deploy must reject with an ERROR. Defaults
   * to 'ERROR' to match publish/deploy semantics — pass 'WARNING'
   * explicitly for a draft-save code path.
   */
  severity?: ValidationSeverity;
}

export function validateRecipeAssetsAgainstRegistry(
  recipe: BasketRecipe,
  options: RegistryValidationOptions
): ValidationIssue[] {
  const severity = options.severity ?? 'ERROR';
  const unverified = new Set(findUnverifiedIdentities(recipe.assets.map(recipeAssetIdentity), options.verifiedIdentityKeys).map(assetIdentityKey));

  const issues: ValidationIssue[] = [];
  recipe.assets.forEach((asset: RecipeAsset, i: number) => {
    if (unverified.has(assetIdentityKey(recipeAssetIdentity(asset)))) {
      issues.push({
        code: VALIDATION_CODES.ASSET_NOT_VERIFIED,
        severity,
        message: `Asset "${asset.symbol}" (${asset.chain}:${asset.address}) is not a verified asset in the registry.`,
        path: `assets[${i}]`,
      });
    }
  });

  return issues;
}
