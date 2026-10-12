import { formatNavValue, NAV_VALUE_DECIMALS } from './nav';
import { toProtocolPrice } from '@/lib/domain/basket-protocol/pricing/price-precision';
import type { NavResult } from '@/types/basket-protocol';

// -----------------------------------------------------------------------------
// A Bag's return series: a chained price index over its recorded snapshots.
//
// From one snapshot to the next, the holdings of the EARLIER snapshot are valued
// at both snapshots' prices; the index moves by that ratio:
//
//   index_t = index_(t-1) × Σ q_(t-1) × p_t / Σ q_(t-1) × p_(t-1)
//
// Purchases, sales and tokens leaving a wallet change the quantities, never the
// ratio, so they never show up as gain or loss (NAV per share did: an outflow
// lowered NAV without burning shares). Only assets priced in both snapshots
// count; an asset that appears or disappears in between does not move the index
// for that step. Starts at PRICE_INDEX_BASE on a Bag's first indexed snapshot
// and never restarts after it. Exact bigint math at NAV_VALUE_DECIMALS.
// -----------------------------------------------------------------------------

export const PRICE_INDEX_BASE = '100';

/** One holding as a snapshot stores it (bag_nav_snapshots.components). */
export interface IndexComponent {
  chain: string;
  address: string;
  quantityRaw: string;
  decimals: number;
  /** Price in the snapshot's quote currency, plain decimal string. */
  price: string;
}

export function indexComponentsFromNav(nav: NavResult): IndexComponent[] {
  return nav.components.map((c) => ({
    chain: c.asset.chain,
    address: c.asset.address.toLowerCase(),
    quantityRaw: c.quantityRaw,
    decimals: c.decimals,
    price: c.price.price,
  }));
}

const key = (c: Pick<IndexComponent, 'chain' | 'address'>) => `${c.chain}:${c.address.toLowerCase()}`;
const TEN = BigInt(10);
const MAX_DECIMALS = 36;

function isUsable(c: IndexComponent): boolean {
  return /^\d+$/.test(c.quantityRaw) && Number.isInteger(c.decimals) && c.decimals >= 0 && c.decimals <= MAX_DECIMALS;
}

function priceScaled(price: string): bigint | null {
  try {
    const p = toProtocolPrice(price, NAV_VALUE_DECIMALS);
    return p > BigInt(0) ? p : null;
  } catch {
    return null;
  }
}

/**
 * The index for a new snapshot. `previous` is the Bag's latest indexed snapshot (null on its first): its index and
 * its components. Returns the previous index unchanged when no asset is priced in both snapshots.
 */
export function nextPriceIndex(previous: { index: string; components: IndexComponent[] } | null, current: IndexComponent[]): string {
  if (!previous) return PRICE_INDEX_BASE;
  const prevIndex = toProtocolPrice(previous.index, NAV_VALUE_DECIMALS);
  const now = new Map<string, bigint>();
  for (const c of current) {
    const p = priceScaled(c.price);
    if (p !== null) now.set(key(c), p);
  }
  let atNewPrices = BigInt(0);
  let atOldPrices = BigInt(0);
  for (const c of previous.components) {
    if (!isUsable(c)) continue;
    const pNew = now.get(key(c));
    const pOld = priceScaled(c.price);
    if (pNew === undefined || pOld === null) continue;
    // Same scale for every asset: quantity × price × 10^(MAX_DECIMALS − decimals).
    const unit = BigInt(c.quantityRaw) * TEN ** BigInt(MAX_DECIMALS - c.decimals);
    atNewPrices += unit * pNew;
    atOldPrices += unit * pOld;
  }
  if (atOldPrices === BigInt(0)) return previous.index;
  return formatNavValue((prevIndex * atNewPrices) / atOldPrices);
}
