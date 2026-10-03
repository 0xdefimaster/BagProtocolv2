'use client';

import { useCallback, useEffect, useState } from 'react';
import { Bag } from '@/types';
import { Portfolio, Trade, TradeResult, TradeSide } from '@/types/domain';
import { computePositionsValue, computeUnrealizedPnL } from '@/lib/domain/trading/engine';
import { useCurrentUserId } from './useCurrentUserId';
import { useMarketPrices } from './useMarketPrices';

// -----------------------------------------------------------------------------
// Portfolio/trades now live in Supabase (see supabase/schema.sql +
// lib/server/trading-repo.ts), not localStorage. This hook talks to the
// app/api/portfolio and app/api/trades route handlers instead of importing
// lib/services/trading-service.ts directly — the only thing that changed
// for every component using this hook is that buy/sell/invest are now
// async (they resolve once the server responds) instead of synchronous.
//
// Trading requires a verified wallet signature (see lib/wallet-context.tsx):
// without one there's no Supabase `users` row to attribute trades to, so the
// API returns 401 and this hook surfaces that as a normal TradeResult error
// rather than throwing.
//
// Phase 18.9 — PORTFOLIO_STALE recovery contract. If the server's portfolio
// changed between this hook's last read and a buy/sell/invest actually
// committing, the route rejects with `{ ok: false, error: 'PORTFOLIO_STALE',
// portfolio: <fresh> }` (HTTP 409) instead of silently applying a plan
// computed against stale data — see supabase/schema.sql's
// commit_investment_transaction() and app/api/trades/route.ts's
// portfolioStaleResponse(). This hook does NOT retry that commit itself:
// `refresh()` still runs unconditionally afterward (see buy/sell/invest
// below), so this hook's own `portfolio`/`trades` state is correct again
// immediately either way — but a caller that sees
// `result.error === 'PORTFOLIO_STALE'` should re-derive its plan from the
// (already-fresh) `result.portfolio` and let the user confirm the new
// numbers before calling buy/sell/invest again, never resubmit the same
// quantity/composition it already had blindly.
// -----------------------------------------------------------------------------

interface InvestResult {
  ok: boolean;
  error?: string;
  trades: Trade[];
  portfolio?: Portfolio;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok && !('ok' in data)) {
    // Route returned a plain { error } (auth/validation failure, not a
    // domain-level trade rejection) — normalize it into the same shape.
    return { ok: false, error: data.error ?? 'Request failed.' } as T;
  }
  return data as T;
}

export function usePaperPortfolio() {
  const { userId, isAuthenticated } = useCurrentUserId();
  const { prices, source, lastUpdated } = useMarketPrices();
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const refresh = useCallback(() => {
    if (!isAuthenticated) {
      setPortfolio(null);
      setTrades([]);
      return;
    }
    setIsLoading(true);
    fetch('/api/portfolio')
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { portfolio: Portfolio; trades: Trade[] } | null) => {
        if (data) {
          setPortfolio(data.portfolio);
          setTrades(data.trades);
        }
      })
      .catch(() => {})
      .finally(() => setIsLoading(false));
  }, [isAuthenticated]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const buy = useCallback(
    async (symbol: string, quantity: number): Promise<TradeResult> => {
      const price = prices[symbol];
      if (!price) return { ok: false, error: 'Price unavailable for this asset.' };
      const result = await postJson<TradeResult>('/api/trades', {
        action: 'trade',
        symbol,
        side: 'BUY' as TradeSide,
        quantity,
        price,
      });
      refresh();
      return result;
    },
    [prices, refresh]
  );

  const sell = useCallback(
    async (symbol: string, quantity: number): Promise<TradeResult> => {
      const price = prices[symbol];
      if (!price) return { ok: false, error: 'Price unavailable for this asset.' };
      const result = await postJson<TradeResult>('/api/trades', {
        action: 'trade',
        symbol,
        side: 'SELL' as TradeSide,
        quantity,
        price,
      });
      refresh();
      return result;
    },
    [prices, refresh]
  );

  const invest = useCallback(
    async (bag: Pick<Bag, 'id' | 'composition'>, amount: number): Promise<InvestResult> => {
      const result = await postJson<InvestResult>('/api/trades', {
        action: 'invest',
        bagId: bag.id,
        composition: bag.composition,
        amount,
        prices,
      });
      refresh();
      return result;
    },
    [prices, refresh]
  );

  const positionsValue = portfolio ? computePositionsValue(portfolio.positions, prices) : 0;
  const unrealizedPnL = portfolio ? computeUnrealizedPnL(portfolio.positions, prices) : 0;
  const totalValue = (portfolio?.cashBalance ?? 0) + positionsValue;

  return {
    userId,
    isAuthenticated,
    isLoading,
    portfolio,
    trades,
    prices,
    source,
    lastUpdated,
    positionsValue,
    unrealizedPnL,
    totalValue,
    buy,
    sell,
    invest,
    refresh,
  };
}
