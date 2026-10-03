'use client';

import { toDisplayPrice } from '@/lib/domain/basket-protocol/pricing/price-precision';
import type { StockQuote as Quote } from '@/hooks/useStockQuotes';

const isOne = (m: string) => /^1(\.0*)?$/.test(m.trim());

/**
 * "$213.45 / $213.47" — per-token bid / ask from Robinhood's /rhj/prices,
 * already multiplied by the token's corporate-action multiplier. When the
 * multiplier is not 1 the raw underlying quote is shown too, so the two are
 * never confused.
 */
export function StockQuote({ quote, error }: { quote?: Quote; error?: string }) {
  if (!quote) {
    return <span className="text-white/40 text-sm">{error === 'NOT_A_STOCK_TOKEN' ? 'Not a Robinhood Stock Token' : '—'}</span>;
  }
  const bid = toDisplayPrice(quote.bid, 2);
  const ask = toDisplayPrice(quote.ask, 2);
  return (
    <span className="text-sm text-right">
      <span className="font-medium text-white" aria-label={`Bid ${bid} dollars, ask ${ask} dollars`}>
        ${bid} / ${ask}
      </span>
      {quote.isTradingHalt && <span className="ml-2 rounded bg-red-500/20 px-1.5 py-0.5 text-xs font-semibold text-red-300">HALTED</span>}
      {!isOne(quote.currentMultiplier) && (
        <span className="block text-xs text-white/50">
          ×{quote.currentMultiplier} of share ${toDisplayPrice(quote.rawBid, 2)} / ${toDisplayPrice(quote.rawAsk, 2)}
        </span>
      )}
      {quote.pendingMultiplier && <span className="block text-xs text-amber-300">Corporate action pending (×{quote.pendingMultiplier})</span>}
    </span>
  );
}
