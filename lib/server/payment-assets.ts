import { CanonicalAsset, ChainId } from '@/types/basket-protocol';
import { ROBINHOOD_REWARD_TOKEN } from '@/lib/config/robinhood-chain';
import { BAG_CHAINS, isBagChain } from '@/lib/config/chains';
import { NATIVE_ASSET_ADDRESS } from '@/lib/domain/basket-protocol/asset-identity';
import { isNativePaymentChain, nativePaymentAssetId } from '@/lib/payments/native-payment';

/**
 * The one token a buyer pays with (and a redeemer receives) on each chain:
 * the chain's settlement stablecoin, matched by its PINNED CONTRACT ADDRESS —
 * never by symbol, so a registry row that merely calls itself "USDG"/"USDC"
 * can never become the payment token. On Robinhood Chain that is USDG, the
 * protocol's settlement/reward token (lib/config/robinhood-chain.ts); on the
 * other chains, Circle's native USDC.
 */
export const PAYMENT_TOKEN_BY_CHAIN: Partial<Record<ChainId, { symbol: string; address: string }>> = {
  robinhood: { symbol: ROBINHOOD_REWARD_TOKEN.symbol, address: ROBINHOOD_REWARD_TOKEN.address },
  ethereum: { symbol: 'USDC', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' },
  base: { symbol: 'USDC', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
  arbitrum: { symbol: 'USDC', address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831' },
};

/**
 * The settlement token on `chain`, from the registry: the first purchase and sale option, and the only output of a
 * sale that pays a performance fee.
 */
export function paymentAssetsFor(assets: CanonicalAsset[], chain: ChainId): CanonicalAsset[] {
  const pinned = PAYMENT_TOKEN_BY_CHAIN[chain];
  if (!pinned) return [];
  return assets.filter(
    (a) =>
      a.status === 'VERIFIED' &&
      a.chain === chain &&
      a.assetType === 'crypto' &&
      a.address.toLowerCase() === pinned.address.toLowerCase()
  );
}

/**
 * The chain's native token as a purchase input (lib/payments/native-payment.ts),
 * or null where native payments are off. A virtual asset: the protocol's
 * native sentinel address, symbol and decimals from lib/config/chains.ts.
 */
export function nativePaymentAssetFor(chain: ChainId): CanonicalAsset | null {
  if (!isBagChain(chain) || !isNativePaymentChain(chain)) return null;
  const native = BAG_CHAINS[chain].nativeCurrency;
  return {
    id: nativePaymentAssetId(chain),
    chain,
    address: NATIVE_ASSET_ADDRESS,
    symbol: native.symbol,
    decimals: native.decimals,
    name: native.name,
    status: 'VERIFIED',
    assetType: 'crypto',
    createdAt: '',
    updatedAt: '',
  };
}

/** True for the pinned settlement stablecoin of `asset.chain` (counted 1:1 in USD, no price lookup). */
export function isSettlementToken(asset: { chain: string; address: string }): boolean {
  const pinned = PAYMENT_TOKEN_BY_CHAIN[asset.chain as ChainId];
  return !!pinned && pinned.address.toLowerCase() === asset.address.toLowerCase();
}

/**
 * Every other registry-VERIFIED token on `chain` (crypto and stock tokens), by symbol. Only the registry's
 * verified list, never an arbitrary address; each one is valued at its USD oracle price when used, and without a
 * price the purchase or sale is refused (lib/server/payment-value.ts), never estimated.
 */
function otherVerifiedAssets(assets: CanonicalAsset[], chain: ChainId): CanonicalAsset[] {
  return assets
    // A registry row at the native sentinel is never a token: native ETH is offered only as nativePaymentAssetFor().
    .filter((a) => a.status === 'VERIFIED' && a.chain === chain && !isSettlementToken(a) && a.address.toLowerCase() !== NATIVE_ASSET_ADDRESS.toLowerCase())
    .sort((x, y) => x.symbol.localeCompare(y.symbol) || x.address.localeCompare(y.address));
}

/**
 * What a buyer can pay with on `chain`: the settlement token first (so the default purchase stays exactly as
 * before), then the native token where it is enabled, then any other verified token. LI.FI Composer routes from
 * each into the Bag's assets; a token that is itself a Bag asset is kept as is (KEEP leg).
 */
export function purchaseInputAssetsFor(assets: CanonicalAsset[], chain: ChainId): CanonicalAsset[] {
  const native = nativePaymentAssetFor(chain);
  const settlement = paymentAssetsFor(assets, chain);
  return [...settlement, ...(native ? [native] : []), ...otherVerifiedAssets(assets, chain)];
}

/**
 * What a seller can receive on `chain`. A sale that pays a performance fee settles in the settlement token only
 * (RedeemSettlement / RedeemFeeRouter pay the fee in it). A free sale may receive the settlement token, native ETH
 * where native payments are on (one Composer transaction only), or any other verified token.
 */
export function redeemOutputAssetsFor(assets: CanonicalAsset[], chain: ChainId, opts: { paysFee: boolean }): CanonicalAsset[] {
  const settlement = paymentAssetsFor(assets, chain);
  if (opts.paysFee) return settlement;
  const native = nativePaymentAssetFor(chain);
  return [...settlement, ...(native ? [native] : []), ...otherVerifiedAssets(assets, chain)];
}
