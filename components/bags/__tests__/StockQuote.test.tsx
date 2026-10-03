// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { StockQuote } from '../StockQuote';
import type { StockQuote as Quote } from '@/hooks/useStockQuotes';

const q = (o: Partial<Quote> = {}): Quote => ({
  symbol: 'AAPL',
  address: '0xaf3d76f1834a1d425780943c99ea8a608f8a93f9',
  bid: '213.450000000000000000',
  ask: '213.470000000000000000',
  mid: '213.460000000000000000',
  rawBid: '213.450000000000000000',
  rawAsk: '213.470000000000000000',
  currentMultiplier: '1',
  pendingMultiplier: null,
  spreadBps: 0,
  dailyTradingVolume: null,
  isTradingHalt: false,
  generatedAt: '2026-09-28T14:00:00.000Z',
  ...o,
});

afterEach(cleanup);

describe('StockQuote', () => {
  it('shows per-token bid / ask', () => {
    render(<StockQuote quote={q()} />);
    expect(screen.getByText('$213.45 / $213.47')).toBeTruthy();
    expect(screen.queryByText(/of share/)).toBeNull();
  });
  it('shows the raw share quote when the multiplier is not 1, plus halt and pending badges', () => {
    render(<StockQuote quote={q({ bid: '400', ask: '400.4', rawBid: '100', rawAsk: '100.1', currentMultiplier: '4.0', isTradingHalt: true, pendingMultiplier: '4.5' })} />);
    expect(screen.getByText('$400.00 / $400.40')).toBeTruthy();
    expect(screen.getByText('×4.0 of share $100.00 / $100.10')).toBeTruthy();
    expect(screen.getByText('HALTED')).toBeTruthy();
    expect(screen.getByText(/Corporate action pending/)).toBeTruthy();
  });
  it('never invents a price', () => {
    render(<StockQuote error="NOT_A_STOCK_TOKEN" />);
    expect(screen.getByText('Not a Robinhood Stock Token')).toBeTruthy();
  });
});
