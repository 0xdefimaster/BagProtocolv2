import { SupabaseClient } from '@supabase/supabase-js';
import { AssetIdentity, CanonicalAsset, RecipeAsset, ValidationIssue } from '@/types/basket-protocol';
import { assetIdentityKey } from '@/lib/domain/basket-protocol/asset-identity';
import { getAssetsByIdentities } from '@/lib/server/asset-repo';
import { getBagById, getCurrentBagVersion } from '@/lib/server/bag-repo';
import type { VersionChange } from '@/lib/server/bag-versioning';

// -----------------------------------------------------------------------------
// "Edit strategy": the creator changes only WHICH assets the Bag holds and their target weights; the client sends
// only (address, weightBps). Each asset's symbol and decimals come from the registry (VERIFIED, on the Bag's chain),
// or from the current recipe for an asset it already holds. Everything else in the recipe is derived from the current
// version by bag-versioning.ts (deriveVersionBody), never taken from the request.
//
// Deterministic for a given current version, so prepare and confirm rebuild the same assets (and composition hash)
// from the same request body.
// -----------------------------------------------------------------------------

export interface CompositionEdit {
  address: string;
  weightBps: number;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const MAX_EDIT_ASSETS = 50;

export function parseCompositionEdit(value: unknown): CompositionEdit[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_EDIT_ASSETS) return null;
  const out: CompositionEdit[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') return null;
    const { address, weightBps } = entry as { address?: unknown; weightBps?: unknown };
    if (typeof address !== 'string' || !ADDRESS_RE.test(address)) return null;
    if (typeof weightBps !== 'number' || !Number.isInteger(weightBps) || weightBps < 0 || weightBps > 10_000) return null;
    out.push({ address, weightBps });
  }
  return out;
}

export type EditedRecipeResult =
  | { ok: true; recipe: VersionChange }
  | { ok: false; error: 'BAG_NOT_FOUND' }
  | { ok: false; error: 'VALIDATION_FAILED'; issues: ValidationIssue[] };

const issue = (code: string, message: string): ValidationIssue => ({ severity: 'ERROR', code, message, field: 'assets' }) as ValidationIssue;

export interface StrategyEditDeps {
  lookupAssets?: (admin: SupabaseClient, identities: AssetIdentity[]) => Promise<CanonicalAsset[]>;
}

export async function buildEditedRecipe(admin: SupabaseClient, bagId: string, edit: CompositionEdit[], deps: StrategyEditDeps = {}): Promise<EditedRecipeResult> {
  const bag = await getBagById(admin, bagId);
  if (!bag) return { ok: false, error: 'BAG_NOT_FOUND' };
  const current = await getCurrentBagVersion(admin, bag.id);
  if (!current) return { ok: false, error: 'BAG_NOT_FOUND' };

  const keys = edit.map((e) => assetIdentityKey({ chain: bag.chain, address: e.address }));
  if (new Set(keys).size !== keys.length) return { ok: false, error: 'VALIDATION_FAILED', issues: [issue('DUPLICATE_ASSET', 'An asset is listed twice.')] };

  const held = new Map(current.recipe.assets.map((a) => [assetIdentityKey(a), a]));
  const registry = new Map(
    (await (deps.lookupAssets ?? getAssetsByIdentities)(admin, edit.map((e) => ({ chain: bag.chain, address: e.address })))).map((a) => [assetIdentityKey(a), a])
  );

  const assets: RecipeAsset[] = [];
  const issues: ValidationIssue[] = [];
  edit.forEach((e, i) => {
    const key = keys[i];
    const known = held.get(key);
    if (known) {
      assets.push({ ...known, weightBps: e.weightBps });
      return;
    }
    const listed = registry.get(key);
    if (!listed || listed.status !== 'VERIFIED') {
      issues.push(issue('UNVERIFIED_ASSET', `${e.address} is not a verified asset on ${bag.chain}.`));
      return;
    }
    assets.push({ chain: listed.chain, address: listed.address, symbol: listed.symbol, decimals: listed.decimals, weightBps: e.weightBps });
  });
  if (issues.length > 0) return { ok: false, error: 'VALIDATION_FAILED', issues };

  return { ok: true, recipe: { assets } };
}
