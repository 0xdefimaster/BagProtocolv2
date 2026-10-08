import type { CanonicalAsset } from '@/types/basket-protocol';
import { assetIdentityKey, isNativeAssetIdentity } from '@/lib/domain/basket-protocol/asset-identity';
import { getPriceProvider } from '@/lib/server/price-provider';
import { toProtocolPrice } from '@/lib/domain/basket-protocol/pricing/price-precision';
import { toDecimalString, SCALE } from '@/lib/domain/basket-protocol/pricing/decimal-math';

/** Mainnet WETH is used only as the price oracle identity for native ETH. */
export const ETHEREUM_WETH_ADDRESS = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';

/**
 * Returns the USD value of one unit of a payment asset.
 *
 * Settlement tokens keep the existing 1:1 USD assumption. Native ETH is
 * valued through the production price provider using WETH's ERC-20 identity;
 * the native zero-address sentinel is never sent to the token-price adapter.
 */
export async function getPaymentAssetUsdPrice(asset: CanonicalAsset): Promise<string> {
  if (!isNativeAssetIdentity({ chain: asset.chain, address: asset.address })) return '1';
  if (asset.chain !== 'ethereum') throw new Error(`Native ${asset.symbol} payments are not supported on ${asset.chain}.`);

  const price = await getPriceProvider().getPrice({ chain: 'ethereum', address: ETHEREUM_WETH_ADDRESS });
  if (price.quoteCurrency !== 'USD') {
    throw new Error(`Payment price for ${asset.symbol} is not quoted in USD.`);
  }
  return price.price;
}

/**
 * Converts a human payment amount into the protocol's USD quote currency.
 *
 * The input amount remains denominated in the payment asset for routing;
 * this function is only for share valuation, minimum-investment checks and
 * cost-basis accounting.
 */
export async function paymentAmountToQuoteCurrency(asset: CanonicalAsset, amount: string): Promise<string> {
  const amountScaled = toProtocolPrice(amount, asset.decimals);
  if (amountScaled <= 0n) return '0';

  const price = await getPaymentAssetUsdPrice(asset);
  const priceScaled = toProtocolPrice(price, SCALE);
  const amountAtScale =
    asset.decimals === SCALE
      ? amountScaled
      : asset.decimals < SCALE
        ? amountScaled * 10n ** BigInt(SCALE - asset.decimals)
        : amountScaled / 10n ** BigInt(asset.decimals - SCALE);

  return toDecimalString((amountAtScale * priceScaled) / 10n ** BigInt(SCALE));
}

/** Stable identity helper used by tests/callers that need to key a payment asset. */
export function paymentAssetKey(asset: CanonicalAsset): string {
  return assetIdentityKey({ chain: asset.chain, address: asset.address });
}
