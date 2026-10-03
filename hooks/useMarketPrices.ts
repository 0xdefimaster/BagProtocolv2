'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getCurrentPrices,
  tickPrices,
  setLivePrices,
  getPriceSource,
  MARKET_LOCAL_EVENT,
  PriceMap,
  PriceSource,
} from '@/lib/market/market-data';
import { fetchLivePrices } from '@/lib/market/price-feed';
import { TRADABLE_ASSETS } from '@/lib/config/market';

// CoinGecko's free tier is generously rate-limited but not unlimited —
// refresh every 45s rather than hammering it on every render.
const LIVE_FETCH_MS = 45_000;
const FALLBACK_TICK_MS = 5000;

export function useMarketPrices() {
  const [prices, setPrices] = useState<PriceMap>({});
  const [source, setSource] = useState<PriceSource>('simulated');
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const isFetchingLive = useRef(false);

  const refreshFromStorage = useCallback(() => {
    setPrices(getCurrentPrices());
    setSource(getPriceSource());
  }, []);

  const attemptLiveFetch = useCallback(async () => {
    if (isFetchingLive.current) return;
    isFetchingLive.current = true;
    try {
      const live = await fetchLivePrices();
      if (live) {
        setLivePrices(live);
        setLastUpdated(Date.now());
      } else {
        // No live data available right now (offline/blocked/rate-limited) —
        // keep the paper-trading loop moving with a simulated tick instead.
        tickPrices();
      }
    } finally {
      isFetchingLive.current = false;
    }
  }, []);

  useEffect(() => {
    refreshFromStorage();
    const sync = () => refreshFromStorage();
    window.addEventListener(MARKET_LOCAL_EVENT, sync);

    // Try real prices immediately on mount, then on a slower interval.
    attemptLiveFetch();
    const liveInterval = setInterval(attemptLiveFetch, LIVE_FETCH_MS);

    // Faster fallback tick keeps things moving between live refreshes when
    // we're not on live data (e.g. no network reachable at all).
    const fallbackInterval = setInterval(() => {
      if (getPriceSource() !== 'live') tickPrices();
    }, FALLBACK_TICK_MS);

    return () => {
      window.removeEventListener(MARKET_LOCAL_EVENT, sync);
      clearInterval(liveInterval);
      clearInterval(fallbackInterval);
    };
  }, [refreshFromStorage, attemptLiveFetch]);

  return { prices, assets: TRADABLE_ASSETS, source, lastUpdated };
}
