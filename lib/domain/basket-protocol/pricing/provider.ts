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

/** Thrown by a `PriceProvider` implementation when no price can be produced for an asset (unknown to the source, delisted, RPC failure, etc). Not thrown by `MockPriceProvider`, which always returns a deterministic price — reserved for real providers. */
export class PriceUnavailableError extends Error {
  constructor(public readonly asset: AssetIdentity) {
    super(`No price available for ${asset.chain}:${asset.address}`);
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
    super(asset);
    this.name = 'PriceDataGapError';
    this.message = `${source} has no price for ${asset.chain}:${asset.address} (${reason})`;
  }
}
