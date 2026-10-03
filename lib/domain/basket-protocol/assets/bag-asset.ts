import { AssetPrice } from '@/types/basket-protocol';
import type { BagCryptoAsset } from '@/lib/blockchain/lifi-token-data';
import type { RobinhoodStockQuote, RobinhoodStockToken } from '@/lib/domain/basket-protocol/pricing/robinhood-stock-api';
import { isFractionallyTradable } from '@/lib/domain/basket-protocol/pricing/robinhood-stock-api';

// -----------------------------------------------------------------------------
// The unified asset object the frontend and portfolio engine receive, for
// every chain. Same shape, NOT the same semantics: a Stock Token carries a
// `stock` block (bid/ask, multiplier, halt, tradability) that crypto does not
// have. `priceUSD` is always INDICATIVE — execution amounts come from route
// quotes, never from here.
//
// Sources are reported as they actually were, including documented fallbacks
// (a price never claims "LIFI" when a TWAP produced it).
// -----------------------------------------------------------------------------

export type BagAssetType = 'CRYPTO' | 'STOCK_TOKEN';
export type BagPriceSource = 'LIFI' | 'ROBINHOOD_STOCK_API' | 'UNISWAP_V3_TWAP' | 'COINGECKO' | 'USDG_PEG' | 'MOCK';
export type BagMetadataSource = 'LIFI' | 'ROBINHOOD' | 'ONCHAIN';

export interface BagAsset {
  /** `${chainId}:${lowercase address}` */
  id: string;
  chainId: number;
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  logoURI?: string;
  assetType: BagAssetType;
  priceUSD?: string;
  priceSource?: BagPriceSource;
  /** Full source trail, e.g. "robinhood-api:prices:AAPL:mid×1.0|verify:chainlink:0x…:3bps". */
  priceSourceDetail?: string;
  priceAsOf?: string;
  priceKind: 'INDICATIVE';
  /** Set when no price could be produced (fail-closed reason, not a number). */
  priceUnavailable?: string;
  metadataSource: BagMetadataSource;
  stock?: {
    bid: string;
    ask: string;
    rawBid: string;
    rawAsk: string;
    currentMultiplier: string;
    pendingMultiplier: string | null;
    pendingMultiplierEffectiveTime: string | null;
    isTradingHalt: boolean;
    fractionallyTradable: boolean;
    quoteGeneratedAt: string;
  };
}

export const bagAssetId = (chainId: number, address: string) => `${chainId}:${address.toLowerCase()}`;

/** Maps an AssetPrice.source trail to the source that actually produced the number (fallbacks included). */
export function priceSourceOf(source: string): BagPriceSource {
  const head = source.split('|')[0];
  if (head.startsWith('robinhood-api:')) return 'ROBINHOOD_STOCK_API';
  if (head.startsWith('lifi:')) return 'LIFI';
  if (head.startsWith('uniswap-v3-twap:')) return 'UNISWAP_V3_TWAP';
  if (head.startsWith('peg:')) return 'USDG_PEG';
  if (head.startsWith('coingecko')) return 'COINGECKO';
  return 'MOCK';
}

function withPrice<T extends Omit<BagAsset, 'priceKind'>>(base: T, price: AssetPrice | null, unavailable?: string): BagAsset {
  return price
    ? { ...base, priceUSD: price.price, priceSource: priceSourceOf(price.source), priceSourceDetail: price.source, priceAsOf: price.timestamp, priceKind: 'INDICATIVE' }
    : { ...base, priceKind: 'INDICATIVE', priceUnavailable: unavailable ?? 'PRICE_UNAVAILABLE' };
}

export function bagAssetFromCrypto(t: BagCryptoAsset, price: AssetPrice | null, unavailable?: string): BagAsset {
  return withPrice(
    {
      id: bagAssetId(t.chainId, t.address),
      chainId: t.chainId,
      address: t.address,
      symbol: t.symbol,
      name: t.name,
      decimals: t.decimals,
      logoURI: t.logoURI,
      assetType: 'CRYPTO',
      metadataSource: 'LIFI',
    },
    price,
    unavailable
  );
}

export function bagAssetFromOnchain(
  meta: { chainId: number; address: string; symbol: string; name: string; decimals: number },
  price: AssetPrice | null,
  unavailable?: string
): BagAsset {
  return withPrice({ id: bagAssetId(meta.chainId, meta.address), ...meta, assetType: 'CRYPTO', metadataSource: 'ONCHAIN' }, price, unavailable);
}

export function bagAssetFromStockToken(
  chainId: number,
  token: RobinhoodStockToken,
  quote: RobinhoodStockQuote | null,
  price: AssetPrice | null,
  unavailable?: string
): BagAsset {
  return withPrice(
    {
      id: bagAssetId(chainId, token.address),
      chainId,
      address: token.address,
      symbol: token.symbol,
      name: token.name,
      decimals: token.decimals,
      logoURI: token.logoUrl ?? undefined,
      assetType: 'STOCK_TOKEN',
      metadataSource: 'ROBINHOOD',
      stock: quote
        ? {
            bid: quote.bid,
            ask: quote.ask,
            rawBid: quote.rawBid,
            rawAsk: quote.rawAsk,
            currentMultiplier: token.currentMultiplier,
            pendingMultiplier: token.pendingMultiplier,
            pendingMultiplierEffectiveTime: token.pendingMultiplierEffectiveTime,
            isTradingHalt: quote.isTradingHalt,
            fractionallyTradable: isFractionallyTradable(token),
            quoteGeneratedAt: quote.generatedAt,
          }
        : undefined,
    },
    price,
    unavailable
  );
}
