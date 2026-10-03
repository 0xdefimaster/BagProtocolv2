import { TRADABLE_ASSETS } from '@/lib/config/market';

const STORAGE_KEY = 'bag-protocol:market-prices';
const SOURCE_KEY = 'bag-protocol:market-price-source';
const LOCAL_EVENT = 'bag-protocol:market-updated';

export interface PriceMap {
  [symbol: string]: number;
}

export type PriceSource = 'live' | 'simulated';

function basePrices(): PriceMap {
  const prices: PriceMap = {};
  for (const asset of TRADABLE_ASSETS) prices[asset.symbol] = asset.basePrice;
  return prices;
}

function readPrices(): PriceMap {
  if (typeof window === 'undefined') return basePrices();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return seedPrices();
    return { ...basePrices(), ...(JSON.parse(raw) as PriceMap) };
  } catch {
    return basePrices();
  }
}

function seedPrices(): PriceMap {
  const seeded = basePrices();
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seeded));
  } catch {
    // ignore
  }
  return seeded;
}

function writePrices(prices: PriceMap) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prices));
    window.dispatchEvent(new Event(LOCAL_EVENT));
  } catch {
    // ignore
  }
}

/** Returns the current simulated price map (reads-only, no drift applied). */
export function getCurrentPrices(): PriceMap {
  return readPrices();
}

export function getPrice(symbol: string): number {
  const prices = readPrices();
  const asset = TRADABLE_ASSETS.find((a) => a.symbol === symbol);
  return prices[symbol] ?? asset?.basePrice ?? 0;
}

/**
 * Merges real prices fetched from the market data provider into the price
 * map. This is the source of truth whenever the network is available —
 * `tickPrices()` (simulated drift) only runs as a fallback when this
 * hasn't succeeded recently.
 */
export function setLivePrices(livePrices: PriceMap): PriceMap {
  const current = readPrices();
  const next: PriceMap = { ...current, ...livePrices };
  writePrices(next);
  try {
    window.localStorage.setItem(SOURCE_KEY, 'live');
  } catch {
    // ignore
  }
  return next;
}

export function getPriceSource(): PriceSource {
  if (typeof window === 'undefined') return 'simulated';
  try {
    return (window.localStorage.getItem(SOURCE_KEY) as PriceSource) ?? 'simulated';
  } catch {
    return 'simulated';
  }
}

/**
 * Applies one small, bounded random-walk tick to every tradable asset.
 * This is the fallback path: used when a live price fetch hasn't
 * succeeded (offline, blocked network, rate-limited), so the paper
 * trading loop always has something to react to either way.
 */
export function tickPrices(): PriceMap {
  const current = readPrices();
  const next: PriceMap = { ...current };

  for (const asset of TRADABLE_ASSETS) {
    const price = current[asset.symbol] ?? asset.basePrice;
    const moveFraction = (Math.random() * 2 - 1) * asset.volatility * 0.15; // gentle per-tick move
    const updated = Math.max(price * (1 + moveFraction), price * 0.5, 0.0001);
    next[asset.symbol] = Math.round(updated * 10000) / 10000;
  }

  writePrices(next);
  try {
    window.localStorage.setItem(SOURCE_KEY, 'simulated');
  } catch {
    // ignore
  }
  return next;
}

export function resetPrices(): PriceMap {
  const seeded = basePrices();
  writePrices(seeded);
  return seeded;
}

export const MARKET_LOCAL_EVENT = LOCAL_EVENT;
