import { AssetIdentity, ChainId, RecipeAsset } from '@/types/basket-protocol';

// -----------------------------------------------------------------------------
// Pure identity model for an on-chain asset. No I/O — this is the seam both
// `lib/server/asset-repo.ts` (persistence) and
// `lib/domain/basket-protocol/validation/registry-validation.ts` (recipe
// checks) build on, so "same asset" means exactly the same thing
// everywhere it's checked.
//
// Identity is `chain + address`, NEVER `symbol` (see the module doc on
// `AssetIdentity` in types/basket-protocol.ts). Two assets with the same
// symbol on different chains, or two different tokens that happen to share
// a symbol on the same chain, are different assets; two references to the
// same (chain, address) — no matter how the address is capitalized — are
// the same asset.
// -----------------------------------------------------------------------------

// Robinhood Chain is an Arbitrum Orbit L2 (fully EVM-compatible, chain id
// 4663) — see docs.robinhood.com/chain — so it gets the same
// case-insensitive address normalization as the other EVM chains here.
const EVM_CHAINS: ChainId[] = ['ethereum', 'base', 'arbitrum', 'robinhood'];

/**
 * Sentinel address used for a chain's native asset (ETH, SOL, ...). Keeps
 * `AssetIdentity` a single `(chain, address)` pair everywhere, rather than
 * needing a separate `isNative` boolean threaded through every place
 * identity is compared, stored, or keyed on — the same convention several
 * real protocols use for representing native ETH in an ERC-20-shaped
 * interface.
 */
export const NATIVE_ASSET_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * Canonical form of an address for a given chain. EVM addresses are
 * case-insensitive at the protocol level — checksum casing (EIP-55) is a
 * display/typo-detection convention layered on top, not a different
 * address — so this normalizes to lowercase, meaning `0xAbC...` and
 * `0xabc...` collapse to the same identity. Solana addresses ARE
 * case-sensitive (base58), so they pass through unchanged. Any future
 * chain added to `SUPPORTED_CHAINS` without a case rule here falls back to
 * "leave as-is", which is always correct to add a rule for later but never
 * silently wrong (worst case: two identities that should collide don't
 * yet, never the reverse).
 */
export function normalizeAssetAddress(chain: ChainId, address: string): string {
  const trimmed = address.trim();
  if (EVM_CHAINS.includes(chain)) return trimmed.toLowerCase();
  return trimmed;
}

/** Returns a normalized copy of an `AssetIdentity` — run identity through this before comparing, storing, or keying on it. */
export function normalizeAssetIdentity(identity: AssetIdentity): AssetIdentity {
  return { chain: identity.chain, address: normalizeAssetAddress(identity.chain, identity.address) };
}

/**
 * True if `identity`, once normalized, is this chain's native-asset
 * sentinel. Only the EVM family has a sentinel registered so far — the
 * abstraction lives here specifically so a Solana (or future chain) native
 * sentinel can be added later without touching any call site that already
 * checks identity, per spec section 11 ("Solana desteği yazma, sadece
 * AssetIdentity modelinin chain-agnostic olmasını sağla").
 */
export function isNativeAssetIdentity(identity: AssetIdentity): boolean {
  if (EVM_CHAINS.includes(identity.chain)) {
    return normalizeAssetAddress(identity.chain, identity.address) === NATIVE_ASSET_ADDRESS;
  }
  return false;
}

/**
 * Deterministic string key for an `AssetIdentity` — use for Map/Set keys,
 * duplicate detection, and registry lookups. Two identities produce the
 * same key iff `assetIdentitiesEqual()` would return true for them.
 */
export function assetIdentityKey(identity: AssetIdentity): string {
  const normalized = normalizeAssetIdentity(identity);
  return `${normalized.chain}:${normalized.address}`;
}

export function assetIdentitiesEqual(a: AssetIdentity, b: AssetIdentity): boolean {
  return assetIdentityKey(a) === assetIdentityKey(b);
}

/**
 * Extracts the `AssetIdentity` a `RecipeAsset` claims to have. This is a
 * CLAIM, not a verified fact — a recipe can list any `chain`/`address` it
 * wants. See `validateRecipeAssetsAgainstRegistry()` for checking a
 * recipe's claimed identities against actual `CanonicalAsset` records.
 */
export function recipeAssetIdentity(asset: RecipeAsset): AssetIdentity {
  return { chain: asset.chain, address: asset.address };
}
