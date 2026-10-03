import { encodeAbiParameters, keccak256, stringToHex, type Hex } from 'viem';
import { RecipeAsset } from '@/types/basket-protocol';
import { canonicalCompositionString } from './version';

// -----------------------------------------------------------------------------
// Derives the bytes32 values BagFactory.createBag() needs (offChainRef,
// compositionHash) from off-chain identifiers, and re-derives the
// creator-bound on-chain `bagId` the factory computes itself. Pure functions — no RPC, no
// network, safe to unit test directly (see onchain.test.ts).
//
// Deliberately NOT the same hash as `computeCompositionHash()`
// (lib/domain/basket-protocol/version.ts): that one is explicitly
// documented as non-cryptographic (a 64-bit FNV-style mix, good enough for
// "did this change" checks and DB fingerprints). A value that gets written
// on-chain and treated as a collision-resistant identity commitment needs
// an actual cryptographic hash — both functions here start from the exact
// same `canonicalCompositionString()` (so both are guaranteed
// order-independent for the same reason) and pipe it through keccak256
// instead.
// -----------------------------------------------------------------------------

/**
 * bytes32 compositionHash for BagFactory.createBag() / Bag.compositionHash.
 * Same order-independence guarantee as `computeCompositionHash()` — a
 * reordered `assets` array (or a JSONB round-trip that reorders object
 * keys) never changes this value; only an actual change in chain, address,
 * symbol, decimals, or weight does.
 */
export function computeOnChainCompositionHash(assets: RecipeAsset[]): Hex {
  return keccak256(stringToHex(canonicalCompositionString(assets)));
}

/**
 * bytes32 `offChainRef` for BagFactory.createBag() / Bag.offChainRef — the
 * off-chain Supabase `bags.id` (a UUID string) encoded directly,
 * NOT hashing it: the UUID's 32 hex digits (dashes stripped) become the
 * low 16 bytes of the bytes32, left-padded with zero bytes. This is
 * deliberately round-trippable — `decodeOnChainBagId()` below recovers the
 * original UUID — so a Bag contract or an indexed `BagCreated` event can
 * be mapped straight back to its Supabase row without a reverse-lookup
 * table. (Unlike `computeOnChainCompositionHash`, there's no
 * order-independence property to preserve here, and no collision-
 * resistance need either — a UUID is already unique — so keccak256 would
 * only cost the round-trip property for no benefit.)
 */
export function computeOnChainBagId(bagId: string): Hex {
  const hex = bagId.replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) {
    throw new Error(`computeOnChainBagId: "${bagId}" is not a valid UUID.`);
  }
  return `0x${hex.padStart(64, '0')}`;
}

/**
 * The creator-bound on-chain bag id: `keccak256(abi.encode(creator, offChainRef))`.
 * Byte-for-byte what `BagFactory.deriveBagId()` computes on-chain. Because the
 * id depends on the creator, nobody but the real creator can register the
 * Bag under `offChainRef` (no squatting). Server verification re-derives this
 * from the event's creator and refuses any mismatch; execution never derives
 * it — it reads the persisted `bag_deployments.on_chain_bag_id`.
 */
export function deriveOnChainBagId(creator: string, offChainRef: Hex): Hex {
  if (!/^0x[0-9a-fA-F]{40}$/.test(creator)) {
    throw new Error(`deriveOnChainBagId: creator "${creator}" is not a 0x-prefixed address.`);
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(offChainRef)) {
    throw new Error(`deriveOnChainBagId: offChainRef "${offChainRef}" is not a 0x-prefixed bytes32.`);
  }
  return keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [creator.toLowerCase() as Hex, offChainRef]));
}

/** Inverse of `computeOnChainBagId()` — recovers the Supabase `bags.id` UUID from an on-chain bytes32 `offChainRef` (e.g. read off a `BagCreated` event). NOT applicable to the creator-bound `bagId`, which is a hash. */
export function decodeOnChainBagId(onChainBagId: Hex): string {
  const hex = onChainBagId.slice(2).replace(/^0+/, '').padStart(32, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
