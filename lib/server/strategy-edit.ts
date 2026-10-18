import { SupabaseClient } from '@supabase/supabase-js';
import { AssetIdentity, CanonicalAsset, ChainId, RecipeAsset, ValidationIssue } from '@/types/basket-protocol';
import { assetIdentityKey } from '@/lib/domain/basket-protocol/asset-identity';
import { getAssetsByIdentities } from '@/lib/server/asset-repo';
import { getBagById, getCurrentBagVersion } from '@/lib/server/bag-repo';
import type { VersionChange } from '@/lib/server/bag-versioning';

// -----------------------------------------------------------------------------
// "Edit strategy" (and "Fork", which starts a new Bag from an edited copy): the client sends
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

export type ResolvedAssets = { ok: true; assets: RecipeAsset[] } | { ok: false; error: 'VALIDATION_FAILED'; issues: ValidationIssue[] };

/**
 * (address, weightBps) pairs → recipe assets on `chain`: an asset `held` already keeps its stored symbol and
 * decimals; any other must be VERIFIED in the registry on that chain. Shared by Edit strategy and Fork, so both accept
 * exactly the same assets.
 */
export async function resolveCompositionAssets(
  admin: SupabaseClient,
  chain: ChainId,
  heldAssets: RecipeAsset[],
  edit: CompositionEdit[],
  deps: StrategyEditDeps = {}
): Promise<ResolvedAssets> {
  const keys = edit.map((e) => assetIdentityKey({ chain, address: e.address }));
  if (new Set(keys).size !== keys.length) return { ok: false, error: 'VALIDATION_FAILED', issues: [issue('DUPLICATE_ASSET', 'An asset is listed twice.')] };

  const held = new Map(heldAssets.map((a) => [assetIdentityKey(a), a]));
  const registry = new Map((await (deps.lookupAssets ?? getAssetsByIdentities)(admin, edit.map((e) => ({ chain, address: e.address })))).map((a) => [assetIdentityKey(a), a]));

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
      issues.push(issue('UNVERIFIED_ASSET', `${e.address} is not a verified asset on ${chain}.`));
      return;
    }
    assets.push({ chain: listed.chain, address: listed.address, symbol: listed.symbol, decimals: listed.decimals, weightBps: e.weightBps });
  });
  return issues.length > 0 ? { ok: false, error: 'VALIDATION_FAILED', issues } : { ok: true, assets };
}

export async function buildEditedRecipe(admin: SupabaseClient, bagId: string, edit: CompositionEdit[], deps: StrategyEditDeps = {}): Promise<EditedRecipeResult> {
  const bag = await getBagById(admin, bagId);
  if (!bag) return { ok: false, error: 'BAG_NOT_FOUND' };
  const current = await getCurrentBagVersion(admin, bag.id);
  if (!current) return { ok: false, error: 'BAG_NOT_FOUND' };
  const resolved = await resolveCompositionAssets(admin, bag.chain, current.recipe.assets, edit, deps);
  return resolved.ok ? { ok: true, recipe: { assets: resolved.assets } } : resolved;
}
