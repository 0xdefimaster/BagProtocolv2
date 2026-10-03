'use client';

import { useEffect, useState } from 'react';

// Polls GET /api/stock-quotes (Robinhood /rhj/prices, per-token bid/ask) every
// 15 s — the endpoint's documented cache window; polling faster returns the
// same data. Display only: never feed these numbers into protocol math.

export interface StockQuote {
  symbol: string;
  name?: string;
  chainId?: number;
  address: string;
  assetType?: 'STOCK_TOKEN';
  priceUSD?: string;
  priceSource?: 'ROBINHOOD_STOCK_API';
  priceKind?: 'INDICATIVE';
  logoURI?: string | null;
  currency?: string;
  pendingMultiplierEffectiveTime?: string | null;
  fractionallyTradable?: boolean;
  bid: string;
  ask: string;
  mid: string;
  rawBid: string;
  rawAsk: string;
  currentMultiplier: string;
  pendingMultiplier: string | null;
  spreadBps: number | null;
  dailyTradingVolume: string | null;
  isTradingHalt: boolean;
  generatedAt: string;
}

export const STOCK_QUOTE_POLL_MS = 15_000;

export function useStockQuotes(symbols: string[], enabled = true) {
  const key = Array.from(new Set(symbols.map((s) => s.toUpperCase()))).sort().join(',');
  const [quotes, setQuotes] = useState<Record<string, StockQuote>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!enabled || !key) return;
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`/api/stock-quotes?symbols=${encodeURIComponent(key)}`, { cache: 'no-store' });
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as { quotes: Record<string, StockQuote>; errors: Record<string, string> };
        if (cancelled) return;
        setQuotes(data.quotes ?? {});
        setErrors(data.errors ?? {});
        setFailed(false);
      } catch {
        if (!cancelled) setFailed(true);
      }
    };
    load();
    const t = setInterval(load, STOCK_QUOTE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [key, enabled]);

  return { quotes, errors, failed };
}
