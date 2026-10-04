import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/server/price-provider', () => ({ getPriceProvider: () => ({}), getDisplayPriceProvider: () => ({}) }));
const { withLegCosts } = await import('../purchase-execution');

describe('withLegCosts (A3)', () => {
  it('splits the cost basis across legs by input spent, exactly, and drops the helper field', () => {
    const out = withLegCosts(
      [
        { chain: 'robinhood', address: '0xa', decimals: 18, delta_raw: '5', input_raw: '600000' },
        { chain: 'robinhood', address: '0xb', decimals: 6, delta_raw: '7', input_raw: '400000' },
      ],
      '1'
    );
    expect(out).toEqual([
      { chain: 'robinhood', address: '0xa', decimals: 18, delta_raw: '5', cost_quote: '0.6' },
      { chain: 'robinhood', address: '0xb', decimals: 6, delta_raw: '7', cost_quote: '0.4' },
    ]);
  });
  it('non-terminating splits still sum to the total', () => {
    const out = withLegCosts([1, 1, 1].map((w) => ({ delta_raw: '1', input_raw: String(w) })), '10');
    expect(out.map((o) => o.cost_quote)).toEqual(['3.333333333333333333', '3.333333333333333333', '3.333333333333333334']);
  });
});
