import { AssetIdentity, AssetPrice } from '@/types/basket-protocol';
import { assetIdentityKey, normalizeAssetIdentity } from '../asset-identity';
import { PriceProvider } from './provider';

// -----------------------------------------------------------------------------
// Deterministic mock provider — the ONLY `PriceProvider` implementation
// this phase ships (spec section 6/12). The same `AssetIdentity` always
// yields the same price (until overridden via `setPrice()`), so tests and
// demo/paper-mode UI never see price data jump around between calls. This
// is NOT a source of real market data; nothing that touches a user's money
// should ever price against it.
// -----------------------------------------------------------------------------

const SOURCE = 'mock';

/**
 * Deterministic pseudo-price derived from the identity key itself, in the
 * $0.01–$100,000.00 range. Same FNV-1a-style hashing approach as
 * `computeCompositionHash()` (lib/domain/basket-protocol/version.ts) — good
 * enough for a stable, non-cryptographic fixture, and built entirely from
 * integer arithmetic so it never touches float precision.
 */
function deterministicPrice(key: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  }
  const unsigned = h >>> 0;
  const cents = 1 + (unsigned % 10_000_000); // 1..10,000,000 cents => $0.01..$100,000.00
  const dollars = Math.floor(cents / 100);
  const remainderCents = cents % 100;
  return `${dollars}.${remainderCents.toString().padStart(2, '0')}`;
}

export interface MockPriceProviderOptions {
  /** Explicit price overrides keyed by `assetIdentityKey()` — set a known price for a specific test/demo asset instead of the deterministic default. Prefer `setPrice()` over constructing this map by hand. */
  overrides?: Map<string, string>;
  /** Injectable clock, defaults to `() => new Date()` — lets tests assert exact timestamps. */
  now?: () => Date;
  quoteCurrency?: string;
}

export class MockPriceProvider implements PriceProvider {
  private readonly overrides: Map<string, string>;
  private readonly now: () => Date;
  private readonly quoteCurrency: string;

  constructor(options: MockPriceProviderOptions = {}) {
    this.overrides = options.overrides ?? new Map();
    this.now = options.now ?? (() => new Date());
    this.quoteCurrency = options.quoteCurrency ?? 'USD';
  }

  async getPrice(asset: AssetIdentity): Promise<AssetPrice> {
    const identity = normalizeAssetIdentity(asset);
    const key = assetIdentityKey(identity);
    const price = this.overrides.get(key) ?? deterministicPrice(key);

    return {
      asset: identity,
      price,
      quoteCurrency: this.quoteCurrency,
      timestamp: this.now().toISOString(),
      source: SOURCE,
    };
  }

  /** Sets/overrides the deterministic price for a specific asset — useful for scenario tests (e.g. "what if BTC craters"). */
  setPrice(asset: AssetIdentity, price: string): void {
    this.overrides.set(assetIdentityKey(asset), price);
  }
}
