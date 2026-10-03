import { AssetIdentity, AssetPrice, ChainId } from '@/types/basket-protocol';
import { PriceDataGapError, PriceProvider, PriceUnavailableError } from './provider';
import { deviationBps, parseUnsignedDecimal } from './decimal-math';
import { ChainlinkFeedPriceProvider } from './chainlink-feed-provider';
import { RobinhoodApiPriceProvider, RobinhoodStockApi } from './robinhood-stock-api';

// -----------------------------------------------------------------------------
// BAG price router — the ONE PriceProvider production code uses, for every
// chain. Explicit source priority, never "whichever answered":
//
//   STOCK TOKEN (address listed ACTIVE on chain 4663 in Robinhood /rhj/assets)
//     1. Robinhood Stock Token API: /rhj/prices mid × currentMultiplier
//     2. Chainlink feed, when configured: VERIFIES the API price on-chain
//        (per-token vs per-token; disagreement > maxDeviationBps fails closed).
//        It never substitutes for a failed API price.
//   CRYPTO (everything else, any chain)
//     1. LI.FI token priceUSD
//     2. a per-chain fallback ONLY on a LI.FI data gap (token unknown to LI.FI
//        or no priceUSD) — never on a LI.FI outage. Robinhood Chain: the
//        Uniswap v3 TWAP (pools must be configured); other chains: CoinGecko
//        only if CRYPTO_PRICE_FALLBACK=coingecko. The source string records it.
//
// A Robinhood address the registry does not list is crypto, whatever its
// ticker; a Chainlink feed configured for such an address is refused (an
// impostor or a misconfiguration). If the registry has never loaded, no
// Robinhood asset can be classified, so only USDG (known non-stock) is priced.
// -----------------------------------------------------------------------------

export const DEFAULT_MAX_DEVIATION_BPS = 200;

export interface BagPriceRouterConfig {
  stockApi: RobinhoodStockApi;
  stockPrices: RobinhoodApiPriceProvider;
  chainlink: ChainlinkFeedPriceProvider;
  crypto: PriceProvider;
  /** Used only after a PriceDataGapError from `crypto`. */
  cryptoFallbacks?: Partial<Record<ChainId, PriceProvider>>;
  usdgAddress: string;
  maxDeviationBps?: number;
}

export class PriceSourceDisagreementError extends PriceUnavailableError {
  constructor(asset: AssetIdentity, public readonly deviationBps: bigint, public readonly primary: string, public readonly secondary: string) {
    super(asset, 'SOURCES_DISAGREE');
    this.name = 'PriceSourceDisagreementError';
    this.message = `Price sources disagree by ${deviationBps} bps for ${asset.chain}:${asset.address} (${primary} vs ${secondary})`;
  }
}

export type AssetClass = 'STOCK_TOKEN' | 'CRYPTO';

export class BagPriceRouter implements PriceProvider {
  private readonly maxDeviationBps: bigint;
  constructor(private readonly config: BagPriceRouterConfig) {
    this.maxDeviationBps = BigInt(config.maxDeviationBps ?? DEFAULT_MAX_DEVIATION_BPS);
  }

  /** STOCK_TOKEN only when the Robinhood registry lists the address; throws PriceUnavailableError if that cannot be decided. */
  async classify(asset: AssetIdentity): Promise<AssetClass> {
    if (asset.chain !== 'robinhood') return 'CRYPTO';
    let token;
    try {
      token = await this.config.stockApi.tokenByAddress(asset.address);
    } catch {
      if (asset.address.toLowerCase() === this.config.usdgAddress.toLowerCase()) return 'CRYPTO';
      throw new PriceUnavailableError(asset, 'SOURCE_UNAVAILABLE');
    }
    if (token) return 'STOCK_TOKEN';
    if (this.config.chainlink.hasFeed(asset)) throw new PriceUnavailableError(asset); // feed for a non-registry address
    return 'CRYPTO';
  }

  async getPrice(asset: AssetIdentity): Promise<AssetPrice> {
    return (await this.classify(asset)) === 'STOCK_TOKEN' ? this.stockPrice(asset) : this.cryptoPrice(asset);
  }

  private async cryptoPrice(asset: AssetIdentity): Promise<AssetPrice> {
    try {
      return await this.config.crypto.getPrice(asset);
    } catch (err) {
      const fallback = this.config.cryptoFallbacks?.[asset.chain];
      if (!(err instanceof PriceDataGapError) || !fallback) throw err;
      const p = await fallback.getPrice(asset);
      return { ...p, source: `${p.source}|fallback:${err.source}-data-gap` };
    }
  }

  private async stockPrice(asset: AssetIdentity): Promise<AssetPrice> {
    const primary = await this.config.stockPrices.getPrice(asset);
    if (!this.config.chainlink.hasFeed(asset)) return primary;
    let onchain: AssetPrice;
    try {
      onchain = await this.config.chainlink.getPrice(asset);
    } catch {
      return { ...primary, source: `${primary.source}|verify:chainlink-unavailable`, confidence: 0.5 };
    }
    const a = parseUnsignedDecimal(primary.price)!;
    const b = parseUnsignedDecimal(onchain.price)!;
    if (a === BigInt(0) || b === BigInt(0)) throw new PriceUnavailableError(asset);
    const dev = deviationBps(a, b);
    if (dev > this.maxDeviationBps) throw new PriceSourceDisagreementError(asset, dev, primary.source, onchain.source);
    return { ...primary, source: `${primary.source}|verify:${onchain.source}:${dev}bps`, confidence: 1 };
  }
}
