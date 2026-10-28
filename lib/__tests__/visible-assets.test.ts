import { describe, expect, it } from 'vitest';
import { visibleAssets } from '../visible-assets';
import type { BagHoldingView } from '@/types';

const h = (symbol: string, quantityRaw: string, value: string | null): BagHoldingView => ({
  symbol,
  chain: 'robinhood',
  address: '0x' + '1'.repeat(40),
  quantityRaw,
  decimals: 18,
  price: '1',
  value,
  quoteCurrency: 'USD',
});
const comp = [
  { symbol: 'AAPL', weight: 50 },
  { symbol: 'TSLA', weight: 30 },
  { symbol: 'NVDA', weight: 20 },
  { symbol: 'OLD', weight: 0 },
];

describe('visibleAssets', () => {
  it('drops 0% targets; once anything is held, drops assets held at 0 (none, zero quantity or $0 value)', () => {
    const r = visibleAssets(comp, [h('aapl', '5', '10.5'), h('TSLA', '0', '0'), h('NVDA', '3', '0.00')]);
    expect(r.allocation.map((p) => p.symbol)).toEqual(['AAPL', 'TSLA', 'NVDA']);
    expect(r.breakdown.map((p) => p.symbol)).toEqual(['AAPL']);
    expect(r.hidden).toBe(2);
  });

  it('nothing bought yet: the breakdown keeps every target (per-token prices are shown there)', () => {
    const r = visibleAssets(comp, []);
    expect(r.breakdown.map((p) => p.symbol)).toEqual(['AAPL', 'TSLA', 'NVDA']);
    expect(r.hidden).toBe(0);
  });

  it('an unpriced holding (value null) with a quantity is still shown', () => {
    expect(visibleAssets(comp, [h('AAPL', '5', null)]).breakdown.map((p) => p.symbol)).toEqual(['AAPL']);
  });
});
