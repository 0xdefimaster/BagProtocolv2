// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const sweepMock = vi.fn();
vi.mock('@/lib/wallet-context', () => ({ useWallet: () => ({ authUser: { id: 'u1', walletAddress: '0x' + '1'.repeat(40), displayName: null } }) }));
vi.mock('@/lib/blockchain/wallet-sweep-client', () => ({ executeWalletSweep: (...a: unknown[]) => sweepMock(...a) }));

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
  sweepMock.mockReset();
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

  it('gets a live quote on request and shows what would be sold and received, with the minimum', async () => {
    const quote = {
      sells: [{ address: TSLA, symbol: 'TSLA', decimals: 18, amountRaw: '10000000000000000000', expectedOutRaw: null, minOutRaw: null }],
      buys: [{ address: NVDA, symbol: 'NVDA', decimals: 18, amountRaw: null, expectedOutRaw: '9900000000000000000', minOutRaw: '9801000000000000000' }],
      slippageBps: 100,
      priceImpactBps: 30,
    };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) =>
      new Response(JSON.stringify(init?.method === 'POST' && url.endsWith('/rebalance-quote') ? quote : { symbols, preview: drifted }), { status: 200 })
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<RebalancePreviewCard bagId="b1" />);
    fireEvent.click(await screen.findByText('Get a live rebalance quote'));
    await waitFor(() => expect(screen.getByText(/Receive about/)).toBeTruthy());
    expect(screen.getByText(/Receive about/).textContent).toMatch(/9\.9.* NVDA \(at least 9\.80?1? ?/);
    expect(screen.getByText(/0\.30% price impact/)).toBeTruthy();
    expect(fetchMock.mock.calls.some(([u, i]) => String(u).endsWith('/b1/rebalance-quote') && i?.method === 'POST')).toBe(true);
  });

  it('shows the reason when no quote is available', async () => {
    global.fetch = vi.fn(async (url: string, init?: RequestInit) =>
      init?.method === 'POST' ? new Response(JSON.stringify({ error: 'The price impact of this rebalance is above the limit.' }), { status: 422 }) : new Response(JSON.stringify({ symbols, preview: drifted }), { status: 200 })
    ) as unknown as typeof fetch;
    render(<RebalancePreviewCard bagId="b1" />);
    fireEvent.click(await screen.findByText('Get a live rebalance quote'));
    await waitFor(() => expect(screen.getByText(/price impact of this rebalance is above the limit/)).toBeTruthy());
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

  it('Rebalance now: records the plan, the wallet signs the one transaction, and the card reports it once BAG booked it', async () => {
    const tx = { to: '0x' + 'c'.repeat(40), data: '0xdead', value: '0', chainId: 4663, approvals: [{ token: TSLA, spender: '0x' + 's'.repeat(40), amountRaw: '1' }] };
    const intent = { id: 'r1', status: 'READY', expiresAt: new Date(Date.now() + 300_000).toISOString(), failureMessage: null, composerTransaction: tx };
    let verifies = 0;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/rebalance-intent')) return new Response(JSON.stringify({ intent }), { status: 200 });
      if (url.endsWith('/verify')) {
        verifies++;
        const status = init?.body ? 'SUBMITTED' : 'SUCCEEDED';
        return new Response(JSON.stringify({ intent: { ...intent, status, composerTransaction: null } }), { status: 200 });
      }
      return new Response(JSON.stringify({ symbols, preview: drifted }), { status: 200 });
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    sweepMock.mockImplementation(async (_w: string, _plan: unknown, _p: unknown, opts: { onSubmitted: (h: string) => Promise<unknown> }) => {
      await opts.onSubmitted('0x' + 'ab'.repeat(32));
      return '0x' + 'ab'.repeat(32);
    });
    const onRebalanced = vi.fn();
    render(<RebalancePreviewCard bagId="b1" onRebalanced={onRebalanced} />);
    fireEvent.click(await screen.findByText('Rebalance now'));
    await waitFor(() => expect(screen.getByText(/Rebalanced\. Your position now follows strategy v2/)).toBeTruthy());

    // The wallet got exactly the recorded transaction and its approvals; the hash went to verify.
    expect(sweepMock.mock.calls[0][0]).toBe('0x' + '1'.repeat(40));
    expect(sweepMock.mock.calls[0][1]).toEqual({ transaction: tx, approvals: tx.approvals });
    const verifyBodies = fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/verify')).map(([, init]) => (init as RequestInit | undefined)?.body ?? null);
    expect(verifyBodies[0]).toBe(JSON.stringify({ txHash: '0x' + 'ab'.repeat(32) }));
    expect(verifies).toBeGreaterThanOrEqual(2);
    expect(onRebalanced).toHaveBeenCalledTimes(1);
  });

  it('Rebalance now: a plan that cannot be made, or a declined signature, is shown and nothing else happens', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.endsWith('/rebalance-intent')
        ? new Response(JSON.stringify({ error: 'A sale of this position is in progress; rebalance once it has settled.' }), { status: 409 })
        : new Response(JSON.stringify({ symbols, preview: drifted }), { status: 200 })
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<RebalancePreviewCard bagId="b1" />);
    fireEvent.click(await screen.findByText('Rebalance now'));
    await waitFor(() => expect(screen.getByText(/A sale of this position is in progress/)).toBeTruthy());
    expect(sweepMock).not.toHaveBeenCalled();
    expect(screen.getByText('Rebalance now')).toBeTruthy(); // can try again
  });
});
