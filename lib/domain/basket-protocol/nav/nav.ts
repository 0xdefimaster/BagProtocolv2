import { AssetHolding, AssetIdentity, AssetPrice, NavComponent, NavResult } from '@/types/basket-protocol';
import { assetIdentityKey } from '../asset-identity';
import { PriceProvider, PriceUnavailableError } from '../pricing/provider';
import { DEFAULT_MAX_PRICE_AGE_MS, priceAgeMs } from '../pricing/staleness';
import { toProtocolPrice } from '../pricing/price-precision';

// -----------------------------------------------------------------------------
// NAV = Σ (holding quantity × price), computed from ACTUAL holdings, never
// from a BasketRecipe's target weights. This is the single most important
// invariant in this file (spec section 2): `RecipeAsset.weightBps` says
// what a Bag SHOULD hold — for initial allocation, rebalance targets, and
// UI display — not what it DOES hold. Nothing in this file imports
// `BasketRecipe` or reads `weightBps` for any purpose other than the
// explicitly-separate `findMissingHoldings()` cross-check at the bottom of
// this file, which exists to flag a mismatch, not to fill one in with a
// weight-derived guess.
//
// No JS `number` appears anywhere in the value-calculation path — every
// quantity/price/value is a `bigint` internally, exposed as an exact
// decimal string (spec section 6/7). See `NAV_VALUE_DECIMALS` below for the
// fixed-point scale everything is normalized to before being summed.
// -----------------------------------------------------------------------------

/**
 * Internal fixed-point scale (in decimal places) every asset's value is
 * normalized to before being summed into a NAV total, and the scale
 * `grossNav`/`netNav`/component `value` strings are expressed at. Chosen
 * to equal the maximum asset `decimals` this protocol allows (`RecipeAsset`/
 * `CanonicalAsset` both cap `decimals` at 18 — see supabase/schema.sql's
 * `assets` table check constraint) — see `toNavValue()` below for why that
 * specific equality is what makes the whole calculation exact with no
 * remainder, for ANY combination of asset decimals and price precision up
 * to 18 digits.
 */
export const NAV_VALUE_DECIMALS = 18;

export class StalePriceError extends Error {
  constructor(
    public readonly asset: AssetIdentity,
    public readonly ageMs: number,
    public readonly maxAgeMs: number
  ) {
    super(
      `Price for ${asset.chain}:${asset.address} is stale (${ageMs}ms old, max allowed ${maxAgeMs}ms) — refusing to compute NAV on it.`
    );
    this.name = 'StalePriceError';
  }
}

export class ZeroShareSupplyError extends Error {
  constructor() {
    super('Cannot compute NAV per share: share supply is zero.');
    this.name = 'ZeroShareSupplyError';
  }
}

export class InvalidQuantityError extends Error {
  constructor(quantityRaw: string) {
    super(`"${quantityRaw}" is not a valid non-negative integer raw quantity.`);
    this.name = 'InvalidQuantityError';
  }
}

const NON_NEGATIVE_INTEGER_RE = /^\d+$/;

function parseRawQuantity(quantityRaw: string): bigint {
  if (!NON_NEGATIVE_INTEGER_RE.test(quantityRaw.trim())) {
    throw new InvalidQuantityError(quantityRaw);
  }
  return BigInt(quantityRaw);
}

/**
 * Formats a `NAV_VALUE_DECIMALS`-scaled bigint back into an exact decimal
 * string — the inverse of the scaling `toNavValue()` produces. No
 * rounding: every digit the bigint carries is preserved, unlike
 * `toDisplayPrice()` (Phase 5, lib/domain/basket-protocol/pricing/
 * price-precision.ts), which deliberately rounds for UI display. This is
 * the PROTOCOL-precision form — see that file's "Display price ≠ Protocol
 * price" distinction, which applies here identically to "Display NAV ≠
 * Protocol NAV".
 */
export function formatNavValue(scaled: bigint, decimals: number = NAV_VALUE_DECIMALS): string {
  const negative = scaled < BigInt(0);
  const abs = negative ? -scaled : scaled;
  const str = abs.toString().padStart(decimals + 1, '0');
  const whole = str.slice(0, str.length - decimals) || '0';
  const fraction = str.slice(str.length - decimals);
  const result = decimals > 0 ? `${whole}.${fraction}` : whole;
  return negative ? `-${result}` : result;
}

/**
 * Converts one holding's (quantityRaw, decimals) + price into a value at
 * `NAV_VALUE_DECIMALS` fixed-point scale — exactly, with no remainder.
 *
 * Why this is always exact: `priceScaled = toProtocolPrice(price, 18)` is
 * `price_human * 10^18` (an exact integer — see price-precision.ts, which
 * truncates only beyond 18 decimal digits of the SOURCE price string, a
 * documented practical limit). `quantityRaw * priceScaled` is therefore
 * `quantity_human * price_human * 10^(decimals + 18)`. Dividing by
 * `10^decimals` — which is always an EXACT power-of-ten division here,
 * because `decimals` (an asset's on-chain decimals) can never exceed 18
 * (the schema-enforced max — same bound `NAV_VALUE_DECIMALS` was chosen to
 * match) — leaves `quantity_human * price_human * 10^18`, i.e. the exact
 * asset value at 18-decimal fixed-point precision. No terms are ever
 * dropped; this is integer bigint arithmetic throughout.
 */
function toNavValue(quantityRaw: bigint, decimals: number, price: string): bigint {
  if (decimals > NAV_VALUE_DECIMALS) {
    // Can't happen through this codebase's own asset registry (decimals is
    // schema-capped at 18 = NAV_VALUE_DECIMALS), but this function takes
    // plain arguments, not a validated CanonicalAsset — fail loudly rather
    // than silently producing a wrong (truncated) value for a hypothetical
    // future asset with >18 decimals.
    throw new Error(`toNavValue: asset decimals (${decimals}) exceeds NAV_VALUE_DECIMALS (${NAV_VALUE_DECIMALS}).`);
  }
  const priceScaled = toProtocolPrice(price, NAV_VALUE_DECIMALS);
  return (quantityRaw * priceScaled) / BigInt(10) ** BigInt(decimals);
}

export interface CalculateNavOptions {
  quoteCurrency?: string;
  /** Prices older than this are rejected with `StalePriceError` rather than silently used. Defaults to the same 5-minute window `isPriceStale()` (Phase 5) defaults to. */
  maxPriceAgeMs?: number;
  /** Injectable clock — defaults to `new Date()`. Pass explicitly for deterministic staleness tests, same convention `MockPriceProvider` uses. */
  now?: Date;
}

/**
 * Pure, synchronous NAV calculation from already-fetched prices. This is
 * the function unit tests should call directly (spec section 17's exact-
 * arithmetic cases) — `calculateNav()` below is a thin async wrapper that
 * fetches prices from a `PriceProvider` and delegates here.
 *
 * Fails LOUD, never partially: a missing or stale price for ANY holding
 * throws immediately rather than returning a NAV computed from whichever
 * holdings happened to have usable prices (spec section 10 — "BTC + ETH
 * calculated, SOL skipped" would be financially misleading). Empty
 * `holdings` is the one case that legitimately produces a zero-value
 * result rather than an error (spec section 11).
 */
export function calculateNavFromPrices(
  holdings: AssetHolding[],
  prices: ReadonlyMap<string, AssetPrice>,
  options: CalculateNavOptions = {}
): NavResult {
  const quoteCurrency = options.quoteCurrency ?? 'USD';
  const maxPriceAgeMs = options.maxPriceAgeMs ?? DEFAULT_MAX_PRICE_AGE_MS;
  const now = options.now ?? new Date();

  let total = BigInt(0);
  const components: NavComponent[] = holdings.map((holding) => {
    const quantityRaw = parseRawQuantity(holding.quantityRaw);
    const key = assetIdentityKey(holding.asset);
    const price = prices.get(key);
    if (!price) {
      throw new PriceUnavailableError(holding.asset);
    }

    const ageMs = priceAgeMs(price, now);
    if (ageMs > maxPriceAgeMs) {
      throw new StalePriceError(holding.asset, ageMs, maxPriceAgeMs);
    }

    const valueScaled = toNavValue(quantityRaw, holding.decimals, price.price);
    total += valueScaled;

    return {
      asset: holding.asset,
      quantityRaw: holding.quantityRaw,
      decimals: holding.decimals,
      price,
      value: formatNavValue(valueScaled),
    };
  });

  const grossNav = formatNavValue(total);
  return {
    asOf: now.toISOString(),
    quoteCurrency,
    components,
    grossNav,
    netNav: grossNav, // no fee logic yet — spec section 13
  };
}

/**
 * Fetches a price for every holding from `priceProvider` (spec section 3 —
 * "NAV Engine kendi price feed'ini oluşturmasın", it uses the Phase 5
 * `PriceProvider` abstraction), then delegates to the pure
 * `calculateNavFromPrices()`. Duplicate holdings for the same asset only
 * trigger one `getPrice()` call.
 */
export async function calculateNav(
  holdings: AssetHolding[],
  priceProvider: PriceProvider,
  options: CalculateNavOptions = {}
): Promise<NavResult> {
  const uniqueAssets = new Map<string, AssetIdentity>();
  for (const holding of holdings) {
    uniqueAssets.set(assetIdentityKey(holding.asset), holding.asset);
  }

  const prices = new Map<string, AssetPrice>();
  for (const [key, asset] of uniqueAssets) {
    prices.set(key, await priceProvider.getPrice(asset));
  }

  return calculateNavFromPrices(holdings, prices, options);
}

/**
 * NAV per share = Gross NAV / share supply — pure domain math, no ERC-20 or
 * token contract involved (spec section 12: this is the abstraction a
 * later mint/redeem phase builds on, not an implementation of it yet).
 * `shareSupplyRaw`/`shareDecimals` follow the same raw-units convention as
 * `AssetHolding` — never a human "100 shares" written directly in.
 *
 * Throws `ZeroShareSupplyError` rather than returning `Infinity`/`NaN` —
 * NAV per share is genuinely undefined at zero supply (before any shares
 * have ever been minted), and financial code should fail loudly on an
 * undefined result rather than let a bogus value propagate (spec section
 * 12: "Supply sıfırsa davranışı tanımla" — this is that definition).
 *
 * Division here is NOT always exact the way `toNavValue()`'s is (dividing
 * by an arbitrary share supply, not a power of ten, can produce a
 * genuinely repeating decimal — e.g. NAV 1000 / 3 shares) — the result is
 * truncated at `NAV_VALUE_DECIMALS`, the same "truncate, never round"
 * policy `toProtocolPrice()` (Phase 5) already uses for the same reason:
 * inventing a rounded-up digit would manufacture value that isn't there.
 */
export function calculateNavPerShare(nav: NavResult, shareSupplyRaw: string, shareDecimals: number): string {
  const supply = parseRawQuantity(shareSupplyRaw);
  if (supply === BigInt(0)) {
    throw new ZeroShareSupplyError();
  }

  const navScaled = toProtocolPrice(nav.grossNav, NAV_VALUE_DECIMALS);
  // navScaled is at NAV_VALUE_DECIMALS; supply is at shareDecimals. Scale
  // the numerator up by 10^shareDecimals before dividing by raw supply so
  // the quotient lands back at NAV_VALUE_DECIMALS precision.
  const perShareScaled = (navScaled * BigInt(10) ** BigInt(shareDecimals)) / supply;
  return formatNavValue(perShareScaled);
}

// ----------------------------- Recipe/holdings cross-check ------------------------

/**
 * Returns every `AssetIdentity` a recipe's target composition references
 * that has NO corresponding entry in `holdings` — a legitimate situation
 * to flag (spec section 11: "recipe'de asset var ama holdings eksikse")
 * WITHOUT feeding a weight-derived guess into `calculateNav()` itself.
 * Purely informational: `calculateNav()`/`calculateNavFromPrices()` never
 * call this — they only ever see `holdings`, never a recipe, keeping the
 * "weights are not holdings" separation absolute (see this file's module
 * doc). A caller (e.g. a future Bag detail page) can run this alongside
 * `calculateNav()` and surface a warning without it ever affecting the
 * NAV figure itself.
 */
export function findMissingHoldings(
  recipeAssets: ReadonlyArray<AssetIdentity>,
  holdings: ReadonlyArray<AssetHolding>
): AssetIdentity[] {
  const heldKeys = new Set(holdings.map((h) => assetIdentityKey(h.asset)));
  const seen = new Set<string>();
  const missing: AssetIdentity[] = [];
  for (const asset of recipeAssets) {
    const key = assetIdentityKey(asset);
    if (!heldKeys.has(key) && !seen.has(key)) {
      seen.add(key);
      missing.push(asset);
    }
  }
  return missing;
}
