import { CanonicalAsset, ChainId } from '@/types/basket-protocol';
import { ROBINHOOD_REWARD_TOKEN } from '@/lib/config/robinhood-chain';
import { NATIVE_ASSET_ADDRESS } from '@/lib/domain/basket-protocol/asset-identity';

/**
 * The settlement token remains pinned per chain, but Ethereum additionally
 * exposes native ETH as a funding asset. Native ETH is a virtual registry
 * entry: it uses the protocol's canonical native sentinel and is never read
 * from the ERC-20 asset table.
 */
export const PAYMENT_TOKEN_BY_CHAIN: Partial<Record<ChainId, { symbol: string; address: string }>> = {
  robinhood: { symbol: ROBINHOOD_REWARD_TOKEN.symbol, address: ROBINHOOD_REWARD_TOKEN.address },
  ethereum: { symbol: 'USDC', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' },
  base: { symbol: 'USDC', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
  arbitrum: { symbol: 'USDC', address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831' },
};

export const NATIVE_PAYMENT_ASSET_ID_BY_CHAIN: Partial<Record<ChainId, string>> = {
  ethereum: 'native:ethereum:ETH',
};

function nativePaymentAssetFor(chain: ChainId): CanonicalAsset | null {
  if (chain !== 'ethereum') return null;
  return {
    id: NATIVE_PAYMENT_ASSET_ID_BY_CHAIN.ethereum!,
    chain,
    address: NATIVE_ASSET_ADDRESS,
    symbol: 'ETH',
    decimals: 18,
    name: 'Ether',
    status: 'VERIFIED',
    assetType: 'crypto',
    createdAt: '',
    updatedAt: '',
  };
}

export function paymentAssetsFor(assets: CanonicalAsset[], chain: ChainId): CanonicalAsset[] {
  const pinned = PAYMENT_TOKEN_BY_CHAIN[chain];
  const native = nativePaymentAssetFor(chain);
  const settlementAssets = pinned
    ? assets.filter(
    (a) =>
      a.status === 'VERIFIED' &&
      a.chain === chain &&
      a.assetType === 'crypto' &&
      a.address.toLowerCase() === pinned.address.toLowerCase()
      )
    : [];
  // Keep the settlement token first so existing purchase flows remain stable;
  // Ethereum buyers can explicitly switch the funding asset to native ETH.
  return native ? [...settlementAssets, native] : settlementAssets;
}
