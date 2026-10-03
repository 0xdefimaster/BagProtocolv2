import { TRADABLE_ASSETS } from '@/lib/config/market';
import { PriceMap } from './market-data';

const COINGECKO_URL = 'https://api.coingecko.com/api/v3/simple/price';
const FETCH_TIMEOUT_MS = 8000;

/**
 * Fetches live USD prices for every tradable asset from CoinGecko's free,
 * no-API-key "simple price" endpoint. This is a real, client-side call —
 * it runs in the user's browser, not from any Anthropic-side sandbox, so it
 * works in normal deployments (Vercel, localhost, etc.) even though this
 * dev environment's own outbound network is locked down and can't reach it
 * to test against directly.
 *
 * Returns null (never throws) on any failure — timeout, offline, rate
 * limit, CORS, blocked network — so callers can fall back to the simulated
 * price engine and the paper-trading loop never breaks.
 */
export async function fetchLivePrices(): Promise<PriceMap | null> {
  const ids = TRADABLE_ASSETS.map((a) => a.coingeckoId).join(',');
  const url = `${COINGECKO_URL}?ids=${ids}&vs_currencies=usd`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, { signal: controller.signal, cache: 'no-store' });
    if (!res.ok) return null;

    const data = (await res.json()) as Record<string, { usd?: number }>;
    const prices: PriceMap = {};

    for (const asset of TRADABLE_ASSETS) {
      const usd = data[asset.coingeckoId]?.usd;
      if (typeof usd === 'number' && usd > 0) {
        prices[asset.symbol] = usd;
      }
    }

    // Require at least a majority of assets to have priced successfully —
    // a mostly-empty response (e.g. partial rate limiting) shouldn't
    // silently zero out the rest of the market.
    return Object.keys(prices).length >= Math.ceil(TRADABLE_ASSETS.length * 0.5) ? prices : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
