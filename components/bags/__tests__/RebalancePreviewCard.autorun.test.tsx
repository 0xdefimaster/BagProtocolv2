// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

vi.mock('@/lib/wallet-context', () => ({ useWallet: () => ({ authUser: { id: 'u1', walletAddress: '0x' + '1'.repeat(40), displayName: null } }) }));
vi.mock('@/lib/blockchain/wallet-sweep-client', () => ({ executeWalletSweep: vi.fn() }));

import { RebalancePreviewCard } from '../RebalancePreviewCard';

const A = '0x' + 'a'.repeat(40);
const B = '0x' + 'b'.repeat(40);
const preview = (targetVersion: number, requiresRebalance = true) => ({
  status: 'OK',
  targetVersion,
  driftThresholdBps: 500,
  maxAbsDriftBps: requiresRebalance ? 1000 : 100,
  requiresRebalance,
  navQuote: '100',
  quoteCurrency: 'USD',
  allocations: [
    { asset: { chain: 'robinhood', address: A }, symbol: 'AAA', targetWeightBps: 5000, currentWeightBps: 4000, driftBps: -1000 },
    { asset: { chain: 'robinhood', address: B }, symbol: 'BBB', targetWeightBps: 5000, currentWeightBps: 6000, driftBps: 1000 },
  ],
  orders: requiresRebalance
    ? [
        { asset: { chain: 'robinhood', address: A }, symbol: 'AAA', side: 'BUY', value: '10', quantityRaw: '1', decimals: 18 },
        { asset: { chain: 'robinhood', address: B }, symbol: 'BBB', side: 'SELL', value: '10', quantityRaw: '1', decimals: 18 },
      ]
    : [],
});

/** Preview answers with `p`; a rebalance plan is refused (so the run stops right after asking for it). */
function serve(p: unknown) {
  const intents: string[] = [];
  global.fetch = vi.fn(async (url: string) => {
    if (url.endsWith('/rebalance-preview')) return new Response(JSON.stringify({ symbols: {}, preview: p }), { status: 200 });
    if (url.endsWith('/rebalance-intent')) {
      intents.push(url);
      return new Response(JSON.stringify({ error: 'stop here' }), { status: 400 });
    }
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
  return intents;
}

afterEach(cleanup);

describe('RebalancePreviewCard after the creator saved a new version', () => {
  it('starts the rebalance by itself once the preview targets that version', async () => {
    const intents = serve(preview(5));
    render(<RebalancePreviewCard bagId="b1" autoRunVersion={5} />);
    await waitFor(() => expect(intents).toHaveLength(1));
    expect(await screen.findByText('stop here')).toBeTruthy();
  });

  it('waits while the preview still targets the previous version', async () => {
    const intents = serve(preview(4));
    render(<RebalancePreviewCard bagId="b1" autoRunVersion={5} />);
    await screen.findByText(/strategy v4/);
    expect(intents).toHaveLength(0);
  });

  it('does nothing when the position is already within the drift threshold, or without a saved version', async () => {
    let intents = serve(preview(5, false));
    render(<RebalancePreviewCard bagId="b1" autoRunVersion={5} />);
    await screen.findByText(/strategy v5/);
    expect(intents).toHaveLength(0);
    cleanup();
    intents = serve(preview(5));
    render(<RebalancePreviewCard bagId="b1" />);
    await screen.findByText(/strategy v5/);
    expect(intents).toHaveLength(0);
  });
});
