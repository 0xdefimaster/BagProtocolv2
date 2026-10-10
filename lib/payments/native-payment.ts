import { BAG_CHAINS, isBagChain } from '@/lib/config/chains';

// -----------------------------------------------------------------------------
// Paying for a Bag with the chain's native token (ETH). Client-safe: the
// purchase modal and the Create page read the same rule the server enforces
// (lib/server/payment-assets.ts).
//
// Native payments are on wherever lib/config/chains.ts names a wrapped native
// token (`wrappedNativeAddress`): that token is how the payment is valued in
// USD. Native ETH is never an ERC-20 registry row; it is the protocol's
// zero-address native sentinel (NATIVE_ASSET_ADDRESS).
// -----------------------------------------------------------------------------

/** True when a Bag on `chain` can be bought with that chain's native token. */
export function isNativePaymentChain(chain: string): boolean {
  return isBagChain(chain) && BAG_CHAINS[chain].wrappedNativeAddress !== null;
}

/** Stable id of the native payment option offered on `chain` (it has no registry row to take an id from). */
export function nativePaymentAssetId(chain: string): string {
  return `native:${chain}`;
}
