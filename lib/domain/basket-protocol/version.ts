import { BagVersion, RecipeAsset } from '@/types/basket-protocol';

// -----------------------------------------------------------------------------
// Versioning for a Bag's composition. `UpdateLog` (types/index.ts) already
// tracks free-text change/reason entries for the existing mock bags — this
// module is additive: it produces a `BagVersion` record meant to be written
// *alongside* an UpdateLog entry once bags are backed by the registry
// (Phase 3), not a replacement for UpdateLog.
// -----------------------------------------------------------------------------

/**
 * Canonical, order-independent serialization of a composition — sorted by
 * symbol so re-ordering `assets` alone never changes the output. Shared by
 * `computeCompositionHash()` below (off-chain, non-cryptographic) and
 * `lib/domain/basket-protocol/onchain.ts`'s `computeOnChainCompositionHash()`
 * (keccak256 of this same string, for the bytes32 sent to BagFactory) —
 * both hashes are guaranteed order-independent for the same reason, from
 * the same source of truth, rather than two separately-maintained sort
 * rules that could drift apart.
 */
export function canonicalCompositionString(assets: RecipeAsset[]): string {
  return [...assets]
    .sort((a, b) => a.symbol.localeCompare(b.symbol))
    .map((a) => `${a.chain}:${a.address}:${a.symbol}:${a.decimals}:${a.weightBps}`)
    .join('|');
}

/**
 * Deterministic, dependency-free hash of a composition. Not cryptographic —
 * good enough to detect "did the composition actually change between
 * versions" and to give a short fingerprint for display/registry lookups.
 * Sorts by symbol first so asset re-ordering alone never changes the hash.
 */
export function computeCompositionHash(assets: RecipeAsset[]): string {
  const canonical = canonicalCompositionString(assets);

  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < canonical.length; i++) {
    const ch = canonical.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = (Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)) >>> 0;
  h2 = (Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)) >>> 0;
  return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0'));
}

export interface CreateBagVersionInput {
  bagId: string;
  parentVersion: number | null;
  composition: RecipeAsset[];
  reason: string;
}

/** Builds the next `BagVersion` record. Pure — caller is responsible for persisting it (Phase 3: Bag Registry). */
export function createBagVersion(input: CreateBagVersionInput): BagVersion {
  return {
    bagId: input.bagId,
    version: (input.parentVersion ?? 0) + 1,
    parentVersion: input.parentVersion,
    composition: input.composition,
    compositionHash: computeCompositionHash(input.composition),
    reason: input.reason,
    createdAt: new Date().toISOString(),
  };
}

/** True if two compositions are identical (same hash) — use before creating a no-op version bump. */
export function compositionsAreEqual(a: RecipeAsset[], b: RecipeAsset[]): boolean {
  return computeCompositionHash(a) === computeCompositionHash(b);
}
