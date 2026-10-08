import type { CanonicalAsset } from '@/types/basket-protocol';
import { assetIdentityKey, isNativeAssetIdentity } from '@/lib/domain/basket-protocol/asset-identity';
import { getPriceProvider } from '@/lib/server/price-provider';
import { toProtocolPrice } from '@/lib/domain/basket-protocol/pricing/price-precision';
import { toDecimalString, SCALE } from '@/lib/domain/basket-protocol/pricing/decimal-math';

/**
 * Converts a human payment amount into the protocol's USD quote currency.
 *
 * Existing payment tokens (USDG/USDC) intentionally retain the protocol's
 * historical 1:1 settlement assumption. Native ETH is different: its USD
 * value is read from the production PriceProvider (LI.FI first, with the
 * configured fallback policy) and multiplied using exact bigint decimal math.
 */
export async function paymentAmountToQuoteCurrency(asset: CanonicalAsset, amount: string): Promise<string> {
  if (!isNativeAssetIdentity({ chain: asset.chain, address: asset.address })) return amount;

  const amountScaled = toProtocolPrice(amount, asset.decimals);
  if (amountScaled <= 0n) return '0';

  const price = await getPriceProvider().getPrice({ chain: asset.chain, address: asset.address });
  if (price.quoteCurrency !== 'USD') {
    throw new Error(`Payment price for ${asset.symbol} is not quoted in USD.`);
  }

  const priceScaled = toProtocolPrice(price.price, SCALE);
  const amountAtScale = asset.decimals === SCALE
    ? amountScaled
    : amountScaled * 10n ** BigInt(SCALE - asset.decimals);
  return toDecimalString((amountAtScale * priceScaled) / 10n ** BigInt(SCALE));
}

/** Stable identity helper used by tests/callers that need to key a payment asset. */
export function paymentAssetKey(asset: CanonicalAsset): string {
  return assetIdentityKey({ chain: asset.chain, address: asset.address });
}
