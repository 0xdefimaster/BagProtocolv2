import { AssetIdentity, AssetPrice } from '@/types/basket-protocol';

// -----------------------------------------------------------------------------
// The seam every future price source (Chainlink, Pyth, CoinGecko, DEX TWAP
// — spec section 6) is meant to implement. Phase 5 ships exactly one
// implementation, `MockPriceProvider` (./mock-provider.ts) — a real
// HTTP/RPC-backed provider is explicitly out of scope until a later phase
// names one (spec section 6/12: no CoinGecko wiring in this phase).
// -----------------------------------------------------------------------------

export interface PriceProvider {
  getPrice(asset: AssetIdentity): Promise<AssetPrice>;
}

/**
 * Why a price was refused, so callers can tell a buyer something true ("market closed") instead of a generic
 * "try again". Never used to accept a price: every cause still means "no price".
 * - `MARKET_CLOSED_OR_HALTED`: the source reports trading halted (e.g. Stock Tokens outside market hours).
 * - `SPREAD_TOO_WIDE`: bid/ask too far apart (or zero/crossed) to trust the mid.
 * - `STALE_QUOTE`: the source's last quote is older than allowed.
 * - `NOT_LISTED`: the source does not list this asset.
 * - `SOURCES_DISAGREE`: two independent sources disagree beyond the allowed deviation.
 * - `SOURCE_UNAVAILABLE`: the source could not be reached or answered unexpectedly.
 * - `NO_PRICE`: the source answered but has no price for this asset.
 */
export type PriceUnavailableCause =
  | 'MARKET_CLOSED_OR_HALTED'
  | 'SPREAD_TOO_WIDE'
  | 'STALE_QUOTE'
  | 'NOT_LISTED'
  | 'SOURCES_DISAGREE'
  | 'SOURCE_UNAVAILABLE'
  | 'NO_PRICE';

/** Thrown by a `PriceProvider` implementation when no price can be produced for an asset (unknown to the source, delisted, RPC failure, etc). Not thrown by `MockPriceProvider`, which always returns a deterministic price — reserved for real providers. */
export class PriceUnavailableError extends Error {
  constructor(
    public readonly asset: AssetIdentity,
    public readonly cause: PriceUnavailableCause = 'NO_PRICE'
  ) {
    super(`No price available for ${asset.chain}:${asset.address} (${cause})`);
    this.name = 'PriceUnavailableError';
  }
}

/**
 * The source is reachable and answered, but has no usable price for this
 * asset (unknown token, no price published). Only this — never an outage — may
 * trigger a documented fallback source (see lib/server/price-provider.ts).
 */
export class PriceDataGapError extends PriceUnavailableError {
  constructor(asset: AssetIdentity, public readonly source: string, public readonly reason: string) {
    super(asset, 'NO_PRICE');
    this.name = 'PriceDataGapError';
    this.message = `${source} has no price for ${asset.chain}:${asset.address} (${reason})`;
  }
}
