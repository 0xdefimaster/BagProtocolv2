import { SupabaseClient } from '@supabase/supabase-js';
import { BagVersionRecord, CanonicalAsset } from '@/types/basket-protocol';
import { assetIdentityKey } from '@/lib/domain/basket-protocol/asset-identity';
import { getAssetsByIdentities } from './asset-repo';

/**
 * Registry rows for every asset in the given versions' recipes, keyed by
 * `assetIdentityKey`, for `mapBagRecordToApiResponse`'s `assetsByKey`. One
 * query for all of them. Display-only, so it never throws: a failed lookup
 * just returns an empty map and the Bag renders without asset types/logos.
 */
export async function loadRecipeAssets(
  admin: SupabaseClient,
  versions: (BagVersionRecord | null)[]
): Promise<Map<string, CanonicalAsset>> {
  const identities = versions.flatMap((v) =>
    (v?.recipe.assets ?? [])
      .filter((a) => a.address && a.address !== '__PENDING__')
      .map((a) => ({ chain: a.chain, address: a.address }))
  );
  try {
    const assets = await getAssetsByIdentities(admin, identities);
    return new Map(assets.map((a) => [assetIdentityKey({ chain: a.chain, address: a.address }), a]));
  } catch {
    return new Map();
  }
}
