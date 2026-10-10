import { AssetHolding, AssetIdentity, AssetPrice, NavResult } from '@/types/basket-protocol';
import { assetIdentitiesEqual, assetIdentityKey } from '@/lib/domain/basket-protocol/asset-identity';
import { calculateNavFromPrices, NAV_VALUE_DECIMALS } from '@/lib/domain/basket-protocol/nav/nav';
import { toProtocolPrice } from '@/lib/domain/basket-protocol/pricing/price-precision';

// -----------------------------------------------------------------------------
// Execution-quote share valuation.
//
// Minting a purchase's shares needs the Bag's existing holdings and the
// deposit valued in the SAME prices. Normally that is the oracle NAV
// (lib/server/bag-nav.ts). When the oracle cannot price a holding (Stock
// Tokens outside market hours, a source outage), the purchase does not have
// to stop: its own executable quote already states, per asset, how much of it
// the deposit buys. Valuing the existing holdings at those same prices means
// no value moves between the buyer and the existing holders at the prices the
// market actually offers right now (when the purchase buys in the Bag's own
// proportions this is exactly the in-kind ratio, "this deposit adds X% to
// what the Bag holds"). No external price is needed and nobody is favoured:
//
//   price(asset) = input spent on the leg / the leg's floor output
//
// The floor is the lowest output the purchase can end up with, strictest
// source first: BAG's own verified minimum (`minOutputRaw`: BAG Router,
// sequential LI.FI); else the provider's on-chain-enforced minimum
// (`providerEnforcedMinOutputRaw`: LI.FI Composer's `amountOutMin`, which
// reverts the whole transaction below it); else the simulated output reduced
// by the slippage tolerance the transaction is built with. Valuing against a
// floor, and rounding the division UP, makes the existing holdings worth at
// least as much as the market price, so the buyer can only receive fewer
// shares than a perfect price would give, never more. Existing holders are
// never diluted by this fallback.
//
// The payment asset is priced at `inputUsdPrice`: 1 for a settlement
// stablecoin (counted 1:1, the same convention deposit amounts use), the
// oracle price for native ETH (lib/server/payment-value.ts). A leg's price is
// then `spent × inputUsdPrice / floor output`, still rounded up once.
// -----------------------------------------------------------------------------

export const EXECUTION_QUOTE_PRICE_SOURCE = 'execution-quote:min-output';

export interface ExecutionLeg {
  action: 'KEEP' | 'SWAP';
  outputAsset: AssetIdentity;
  inputAmountRaw: string;
  /** BAG's verified minimum output for the leg (BAG Router, sequential LI.FI); null on Composer legs and unquoted legs. */
  minOutputRaw: string | null;
  /** The provider's on-chain-enforced minimum (LI.FI Composer `amountOutMin`), when reported. */
  providerEnforcedMinOutputRaw?: string | null;
  /** Quoted / simulated output; only used reduced by `expectedHaircutBps` when no minimum is reported. */
  outputAmountRaw?: string | null;
  outputDecimals: number | null;
}

/** The lowest output a leg can end with (see module doc), or null when the leg reports nothing usable. */
export function legFloorOutputRaw(leg: ExecutionLeg, expectedHaircutBps: number): bigint | null {
  const positive = (v: string | null | undefined) => (v !== null && v !== undefined && /^\d+$/.test(v) && BigInt(v) > BigInt(0) ? BigInt(v) : null);
  const min = positive(leg.minOutputRaw) ?? positive(leg.providerEnforcedMinOutputRaw);
  if (min !== null) return min;
  const expected = positive(leg.outputAmountRaw);
  if (expected === null || !(expectedHaircutBps >= 0 && expectedHaircutBps < 10000)) return null;
  const floor = (expected * BigInt(10000 - Math.ceil(expectedHaircutBps))) / BigInt(10000);
  return floor > BigInt(0) ? floor : null;
}

const TEN = BigInt(10);
const pow10 = (n: number) => TEN ** BigInt(n);

function formatScaled(value: bigint, decimals: number): string {
  const s = value.toString().padStart(decimals + 1, '0');
  const int = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, '');
  return frac ? `${int}.${frac}` : int;
}

/**
 * Prices (in the quote currency, at NAV precision, rounded up) implied by a compiled purchase's legs.
 * Legs without a usable minimum output are skipped: an asset is either priced from a real quote or not at all.
 * `inputUsdPrice`: quote-currency value of one payment-asset unit (default '1', a settlement stablecoin).
 */
export function executionPricesFromLegs(
  legs: ExecutionLeg[],
  input: { asset: AssetIdentity; decimals: number },
  timestamp: string,
  options: { quoteCurrency?: string; expectedHaircutBps?: number; inputUsdPrice?: string } = {}
): Map<string, AssetPrice> {
  const quoteCurrency = options.quoteCurrency ?? 'USD';
  const haircutBps = options.expectedHaircutBps ?? -1; // no haircut configured: never price from an expected output
  const inputUsdPrice = options.inputUsdPrice ?? '1';
  const inputPriceScaled = toProtocolPrice(inputUsdPrice, NAV_VALUE_DECIMALS);
  if (inputPriceScaled <= BigInt(0)) throw new Error(`executionPricesFromLegs: input price must be positive, got "${inputUsdPrice}".`);
  const prices = new Map<string, AssetPrice>();
  const put = (asset: AssetIdentity, price: string) => prices.set(assetIdentityKey(asset), { asset, price, quoteCurrency, timestamp, source: EXECUTION_QUOTE_PRICE_SOURCE });
  put(input.asset, formatScaled(inputPriceScaled, NAV_VALUE_DECIMALS));

  const best = new Map<string, { asset: AssetIdentity; scaled: bigint }>();
  for (const leg of legs) {
    if (leg.action !== 'SWAP' || assetIdentitiesEqual(leg.outputAsset, input.asset)) continue;
    if (leg.outputDecimals === null) continue;
    const spent = BigInt(leg.inputAmountRaw);
    const out = legFloorOutputRaw(leg, haircutBps);
    if (spent <= BigInt(0) || out === null) continue;
    // price = (spent / 10^in) × inputPrice / (out / 10^outDec), scaled by 10^NAV, rounded up once.
    // inputPriceScaled already carries 10^NAV, so it replaces that factor.
    const num = spent * inputPriceScaled * pow10(leg.outputDecimals);
    const den = out * pow10(input.decimals);
    const scaled = (num + den - BigInt(1)) / den;
    const key = assetIdentityKey(leg.outputAsset);
    const prev = best.get(key);
    // Two legs into the same asset (not produced today): keep the higher, more conservative price.
    if (!prev || scaled > prev.scaled) best.set(key, { asset: leg.outputAsset, scaled });
  }
  for (const { asset, scaled } of best.values()) put(asset, formatScaled(scaled, NAV_VALUE_DECIMALS));
  return prices;
}

export type ExecutionValuationOutcome =
  | { ok: true; nav: NavResult }
  /** Holdings this purchase's quote does not price and no other price was available for: the purchase must stop. */
  | { ok: false; unpriced: AssetIdentity[] };

/**
 * The Bag's NAV valued at the purchase's execution prices. A holding the purchase does not buy (e.g. left over
 * from an older version) may be priced by `otherPrices` (individually fetched oracle prices); if neither prices
 * it, the valuation fails and lists it, rather than guessing.
 */
export function navAtExecutionPrices(
  holdings: AssetHolding[],
  executionPrices: ReadonlyMap<string, AssetPrice>,
  otherPrices: ReadonlyMap<string, AssetPrice>,
  now: Date
): ExecutionValuationOutcome {
  const prices = new Map<string, AssetPrice>();
  const unpriced: AssetIdentity[] = [];
  for (const h of holdings) {
    const key = assetIdentityKey(h.asset);
    const price = executionPrices.get(key) ?? otherPrices.get(key);
    if (price) prices.set(key, price);
    else if (!unpriced.some((a) => assetIdentitiesEqual(a, h.asset))) unpriced.push(h.asset);
  }
  if (unpriced.length > 0) return { ok: false, unpriced };
  return { ok: true, nav: calculateNavFromPrices(holdings, prices, { now }) };
}
