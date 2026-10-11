// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { RebalancePreviewCard } from '../RebalancePreviewCard';

const TSLA = '0x322f0929c4625ed5bad873c95208d54e1c003b2d';
const NVDA = '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec';
const symbols = { [`robinhood:${TSLA}`]: 'TSLA', [`robinhood:${NVDA}`]: 'NVDA' };

function serve(body: unknown, status = 200) {
  global.fetch = vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const drifted = {
  status: 'OK',
  targetVersion: 2,
  driftThresholdBps: 500,
  maxAbsDriftBps: 1000,
  requiresRebalance: true,
  navQuote: '100',
  quoteCurrency: 'USD',
  allocations: [
    { asset: { chain: 'robinhood', address: NVDA }, symbol: NVDA, targetWeightBps: 5000, currentWeightBps: 4000, driftBps: -1000 },
    { asset: { chain: 'robinhood', address: TSLA }, symbol: TSLA, targetWeightBps: 5000, currentWeightBps: 6000, driftBps: 1000 },
  ],
  orders: [
    { asset: { chain: 'robinhood', address: NVDA }, symbol: NVDA, side: 'BUY', value: '10', quantityRaw: '1', decimals: 18 },
    { asset: { chain: 'robinhood', address: TSLA }, symbol: TSLA, side: 'SELL', value: '10', quantityRaw: '1', decimals: 18 },
  ],
};

describe('RebalancePreviewCard', () => {
  it('shows the drift against the current version and what a rebalance would trade', async () => {
    serve({ symbols, preview: drifted });
    render(<RebalancePreviewCard bagId="b1" />);
    await waitFor(() => expect(screen.getByText(/strategy v2/)).toBeTruthy());
    expect(screen.getByText('+10.0%')).toBeTruthy();
    expect(screen.getByText(/beyond this strategy.s 5.0% threshold/)).toBeTruthy();
    expect(screen.getByText(/A rebalance would sell/).textContent).toMatch(/sell .*of TSLA and buy .*of NVDA, in your own wallet, with no creator fee/);
  });

  it('says so when the position is within tolerance', async () => {
    serve({ symbols, preview: { ...drifted, maxAbsDriftBps: 200, requiresRebalance: false, orders: [] } });
    render(<RebalancePreviewCard bagId="b1" />);
    await waitFor(() => expect(screen.getByText(/Within this strategy.s 5.0% drift threshold/)).toBeTruthy());
  });

  it('renders nothing without a position or a session', async () => {
    serve({ symbols, preview: { status: 'NO_POSITION' } });
    const { container } = render(<RebalancePreviewCard bagId="b1" />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(container.textContent).toBe('');
    cleanup();
    serve({ error: 'Sign in' }, 401);
    const second = render(<RebalancePreviewCard bagId="b1" />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(second.container.textContent).toBe('');
  });
});
