'use client';

import { COINBASE_TOKENIZED_STOCKS_BASE } from '@/lib/config/coinbase-stocks';
import { usMarketStatus } from '@/lib/market-hours';

// -----------------------------------------------------------------------------
// Shown in the purchase, sale and rebalance previews when a Base Bag holds
// Coinbase tokenized stocks (lib/config/coinbase-stocks.ts). Informational
// only: it never blocks. Outside US market hours the stock's reference price
// is held at the last close while DEX trading continues, so the route's
// spread and price impact can be wider than during the session.
// -----------------------------------------------------------------------------

const PINNED_SYMBOLS = new Set([...COINBASE_TOKENIZED_STOCKS_BASE.values()].map((s) => s.toUpperCase()));

export function coinbaseStockSymbolsIn(chain: string | null | undefined, symbols: (string | null | undefined)[]): string[] {
  if (chain !== 'base') return [];
  return [...new Set(symbols.filter((s): s is string => typeof s === 'string' && PINNED_SYMBOLS.has(s.toUpperCase())))];
}

export function TokenizedStockNotice({ chain, symbols, now }: { chain: string | null | undefined; symbols: (string | null | undefined)[]; now?: Date }) {
  const stocks = coinbaseStockSymbolsIn(chain, symbols);
  if (stocks.length === 0) return null;
  const status = usMarketStatus(now);
  const closed = status !== 'OPEN';
  return (
    <p role="note" data-testid="tokenized-stock-notice" style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--gold, #D4A84B)', margin: '0 0 14px' }}>
      {closed
        ? `The US stock market is closed${status === 'CLOSED_WEEKEND' ? ' for the weekend' : ''}. ${stocks.join(', ')} still trade onchain, but prices can drift from the last close and spreads are usually wider, so expect more price impact than during market hours (Mon–Fri 9:30–16:00 New York).`
        : `${stocks.join(', ')} are Coinbase tokenized stocks.`}{' '}
      Coinbase can briefly pause these tokens, for example during a split or dividend; a transaction is then refused before anything is sent.
    </p>
  );
}
