import { CanonicalAsset, ChainId } from '@/types/basket-protocol';
import { ROBINHOOD_REWARD_TOKEN } from '@/lib/config/robinhood-chain';

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
