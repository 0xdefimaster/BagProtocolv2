import type { AssetIdentity } from '@/types/basket-protocol';
import { BAG_CHAINS, isBagChain } from '@/lib/config/chains';
import { isNativeAssetIdentity } from '@/lib/domain/basket-protocol/asset-identity';
import type { PriceProvider } from '@/lib/domain/basket-protocol/pricing/provider';
import { isValidDecimalString, toProtocolPrice } from '@/lib/domain/basket-protocol/pricing/price-precision';
import { SCALE, toDecimalString } from '@/lib/domain/basket-protocol/pricing/decimal-math';

// -----------------------------------------------------------------------------
// A purchase's payment, in the Bag's quote currency (USD).
//
// Shares, the minimum investment and the investor's cost basis are all in
// USD. The settlement stablecoins (USDG / USDC) count 1:1, exactly as before,
// with no price lookup. Native ETH is valued at its wrapped token's oracle
// price (lib/config/chains.ts `wrappedNativeAddress`, through the production
// price router); the purchase itself still spends and routes wei. No price
// means no purchase: nothing is estimated.
// -----------------------------------------------------------------------------

export class PaymentValuationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaymentValuationError';
  }
}

/** USD per one whole unit of the payment asset: '1' for a settlement stablecoin, the wrapped-native oracle price for native ETH. */
export async function paymentAssetUsdPrice(asset: AssetIdentity, provider: PriceProvider): Promise<string> {
  if (!isNativeAssetIdentity(asset)) return '1';
  const weth = isBagChain(asset.chain) ? BAG_CHAINS[asset.chain].wrappedNativeAddress : null;
  if (!weth) throw new PaymentValuationError(`Native payments are not supported on ${asset.chain}.`);
  const price = await provider.getPrice({ chain: asset.chain, address: weth });
  if (price.quoteCurrency !== 'USD') throw new PaymentValuationError(`The native token price is quoted in ${price.quoteCurrency}, not USD.`);
  if (!isValidDecimalString(price.price) || toProtocolPrice(price.price, SCALE) <= BigInt(0)) {
    throw new PaymentValuationError('The native token price is not a positive number.');
  }
  return price.price;
}

/**
 * `amount` (human decimal, in the payment asset) × `usdPrice`, as a USD
 * decimal string. Exact bigint math at 18 decimals, floored, so a payment is
 * never valued above what it is worth.
 */
export function paymentAmountInQuoteCurrency(amount: string, usdPrice: string): string {
  if (usdPrice === '1') return amount.trim();
  const amountScaled = toProtocolPrice(amount.trim(), SCALE);
  const priceScaled = toProtocolPrice(usdPrice, SCALE);
  return toDecimalString((amountScaled * priceScaled) / BigInt(10) ** BigInt(SCALE));
}

/** The payment's USD value and the USD price it was valued at. A settlement stablecoin needs no network call. */
export async function valuePayment(
  asset: AssetIdentity,
  amount: string,
  provider: PriceProvider
): Promise<{ quoteAmount: string; inputUsdPrice: string }> {
  const inputUsdPrice = await paymentAssetUsdPrice(asset, provider);
  return { quoteAmount: paymentAmountInQuoteCurrency(amount, inputUsdPrice), inputUsdPrice };
}
