// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ExecutionHistory } from '../ExecutionHistory';
import type { ExecutionReceipt } from '@/types/execution-receipt';

const TX = '0x' + 'ab'.repeat(32);
const receipt = (over: Partial<ExecutionReceipt> = {}): ExecutionReceipt => ({
  executionId: 'e1', kind: 'PURCHASE', outcome: 'SUCCEEDED', isFinal: true, bagId: 'bag-1', strategyVersion: 5, versionBinding: 'MATCHES_VERSION_RECORD', provider: 'LIFI_COMPOSER',
  executionPlanHash: null, planHashCheckedOnchain: false, wallet: '0xw',
  transactions: [{ txHash: TX, chain: 'robinhood', chainId: 4663, role: 'EXECUTION', verification: 'VERIFIED', claim: 'THIS_EXECUTION' }],
  blockNumber: null, blockTimestamp: null, createdAt: '2026-10-01T00:00:00Z', recordedExecutedAt: null,
  input: { unit: 'TOKEN', asset: { chain: 'robinhood', chainId: 4663, address: '0xusdg', symbol: 'USDG', decimals: 6 }, amountRaw: '1000000000', decimals: 6, source: 'EXECUTION_PLAN' },
  shares: { amountRaw: '1', decimals: 18, source: 'BAG_RECORDED' },
  outputs: [
    { stepIndex: 0, action: 'SWAP', outcome: 'FILLED', asset: { chain: 'robinhood', chainId: 4663, address: '0xnvda', symbol: 'NVDA', decimals: 18 }, soldAsset: null, inputAmountRaw: '1', bagMinimumRaw: '990000000000000000', providerEnforcedMinimumRaw: '985000000000000000', actualRaw: '1000000000000000000', actualSource: 'ONCHAIN_DERIVED', quotedRaw: null, minimumRespected: true },
    { stepIndex: 1, action: 'SWAP', outcome: 'FAILED', asset: { chain: 'robinhood', chainId: 4663, address: '0xamd', symbol: 'AMD', decimals: 18 }, soldAsset: null, inputAmountRaw: '1', bagMinimumRaw: null, providerEnforcedMinimumRaw: null, actualRaw: null, actualSource: null, quotedRaw: '2000000000000000000', minimumRespected: null },
  ],
  evidence: { level: 'ONCHAIN', swapSteps: 2, filledSwaps: 1, onchainDerived: 1, providerReported: 0, coveredByTotal: 0, unrecorded: 0 },
  totalReceived: null,
  policyEvaluation: { policySnapshotAvailable: false, evaluatedAgainstVersion: 5, checks: [{ check: 'ACTUAL_AT_LEAST_MINIMUM', result: 'PASS' }, { check: 'TX_CLAIMED_BY_THIS_EXECUTION', result: 'PASS' }, { check: 'VERSION_BINDING', result: 'UNKNOWN' }], noRouteFallback: null },
  ...over,
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ExecutionHistory', () => {
  it('shows version, provider, input, minimums, actual with its source, and never a quote as actual', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ schemaVersion: 2, bagId: 'bag-1', scope: 'VIEWER_OWN_EXECUTIONS', executions: [receipt()], hasMore: false, nextCursor: null }) })));
    render(<ExecutionHistory bagId="bag-1" />);
    await screen.findByText('Purchase');
    expect(screen.getByText('v5')).toBeTruthy();
    expect(screen.getByText('LI.FI Composer')).toBeTruthy();
    expect(screen.getByText('Succeeded')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
    expect(screen.getByText('1,000')).toBeTruthy();
    expect(screen.getByText('Min (BAG): 0.99')).toBeTruthy();
    expect(screen.getByText('Min (on-chain, swap): 0.985')).toBeTruthy();
    expect(screen.getByText(/read from the tx receipt/).parentElement!.textContent).toBe('1 · read from the tx receipt');
    expect(screen.getByText('Not completed · quote was 2')).toBeTruthy();
    expect(screen.getByText('✓ Received at least the minimum')).toBeTruthy();
    expect(screen.queryByText(/Matches the recorded Bag version/)).toBeNull(); // UNKNOWN checks are not shown
    expect(screen.getByRole('link', { name: /Tx 0xabab/ }).getAttribute('href')).toContain(TX);
  });

  it('redeem: shows what was sold per row and the total received from the tx receipt, never legacy shares', async () => {
    const usdg = { chain: 'robinhood' as const, chainId: 4663, address: '0xusdg', symbol: 'USDG', decimals: 6 };
    const leg = (i: number, symbol: string, sold: string) => ({
      stepIndex: i, action: 'SWAP' as const, outcome: 'FILLED' as const, asset: usdg, soldAsset: { chain: 'robinhood' as const, chainId: 4663, address: `0x${symbol.toLowerCase()}`, symbol, decimals: 18 },
      inputAmountRaw: sold, bagMinimumRaw: null, providerEnforcedMinimumRaw: '1000000', actualRaw: null, actualSource: null, quotedRaw: null, minimumRespected: null,
    });
    const redeem = receipt({
      kind: 'REDEEM', strategyVersion: null, versionBinding: 'NOT_RECORDED',
      input: { unit: 'BAG_SHARES', asset: null, amountRaw: '2500000000000000000', decimals: 18, source: 'EXECUTION_PLAN' },
      outputs: [leg(0, 'AMKR', '14900000000000000'), leg(1, 'SOXX', '1500000000000000')],
      totalReceived: { asset: usdg, actualRaw: '2430000', actualSource: 'ONCHAIN_DERIVED', providerEnforcedMinimumRaw: '2000000' },
      evidence: { level: 'ONCHAIN', swapSteps: 2, filledSwaps: 2, onchainDerived: 0, providerReported: 0, coveredByTotal: 2, unrecorded: 0 },
    });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ schemaVersion: 2, bagId: 'bag-1', scope: 'VIEWER_OWN_EXECUTIONS', executions: [redeem], hasMore: false, nextCursor: null }) })));
    render(<ExecutionHistory bagId="bag-1" />);
    await screen.findByText('Redeem');
    expect(screen.getByText('LI.FI Composer')).toBeTruthy();
    expect(screen.getByText('Sold 0.0149')).toBeTruthy();
    expect(screen.getAllByText('In the total below')).toHaveLength(2);
    expect(screen.getByText('2.43 USDG')).toBeTruthy();
    expect(screen.getByText('· read from the tx receipt')).toBeTruthy();
    expect(screen.getByText('Min (on-chain, swaps): 2')).toBeTruthy();
    expect(screen.queryByText(/Bag shares/)).toBeNull();
    expect(screen.queryByText('Not recorded')).toBeNull();
  });

  it('settled sale: gross, fee with its reason, net and realized P&L from the Settled event; no gross total shown as "Received"', async () => {
    const usdg = { chain: 'robinhood' as const, chainId: 4663, address: '0xusdg', symbol: 'USDG', decimals: 6 };
    const settledReceipt = (over: Record<string, unknown>) =>
      receipt({
        kind: 'REDEEM', strategyVersion: null, versionBinding: 'NOT_RECORDED',
        totalReceived: { asset: usdg, actualRaw: '2975572', actualSource: 'ONCHAIN_DERIVED', providerEnforcedMinimumRaw: null },
        settlement: {
          source: 'ONCHAIN_SETTLED_EVENT', settlementContract: '0x934a', txHash: TX, asset: usdg,
          grossProceedsRaw: '2975572', feeBaseRaw: '0', performanceFeeRaw: '0', netProceedsRaw: '2975572', feeRateBps: 850,
          consumedBasisRaw: '3000000', realizedPnlRaw: '-24428', netRealizedPnlRaw: '-24428', feeReason: 'NO_GAIN', creator: '0xc',
          ...over,
        } as never,
      });
    const loss = settledReceipt({});
    const gain = { ...settledReceipt({ grossProceedsRaw: '3500000', feeBaseRaw: '500000', performanceFeeRaw: '42500', netProceedsRaw: '3457500', realizedPnlRaw: '500000', netRealizedPnlRaw: '457500', feeReason: 'CHARGED' }), executionId: 'e2' };
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ schemaVersion: 2, bagId: 'bag-1', scope: 'VIEWER_OWN_EXECUTIONS', executions: [loss, gain], hasMore: false, nextCursor: null }) })));
    render(<ExecutionHistory bagId="bag-1" />);
    const [l, g] = await screen.findAllByTestId('settlement-summary');
    const text = (el: HTMLElement, id: string) => el.querySelector(`[data-testid="${id}"]`)?.textContent;
    expect(text(l, 'settlement-gross')).toBe('Gross proceeds2.975572 USDG');
    expect(text(l, 'settlement-fee')).toBe('Performance fee (8.5% of realized gain)0 USDG');
    expect(text(l, 'settlement-fee-reason')).toBe('No performance fee — this sale did not realize a gain over your cost basis.');
    expect(text(l, 'settlement-net')).toBe('Net proceeds (to your wallet)2.975572 USDG');
    expect(text(l, 'settlement-pnl')).toBe('Realized P&L (before fee)−0.024428 USDG');
    expect(l.querySelector('[data-testid="settlement-net-pnl"]')).toBeNull();
    expect(text(g, 'settlement-fee')).toBe('Performance fee (8.5% of realized gain)0.0425 USDG');
    expect(text(g, 'settlement-fee-reason')).toBe('Paid on-chain to the creator.');
    expect(text(g, 'settlement-net-pnl')).toBe('Realized P&L (after fee)+0.4575 USDG');
    // The legs' total is gross: not presented as what was received.
    expect(screen.queryByText('Received')).toBeNull();
  });

  it('asks to sign in on 401 and shows the empty state', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, json: async () => ({ error: 'Not signed in.' }) })));
    render(<ExecutionHistory bagId="bag-1" />);
    await screen.findByText(/sign in with your wallet to see your executions/);
    cleanup();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ schemaVersion: 2, bagId: 'bag-1', scope: 'VIEWER_OWN_EXECUTIONS', executions: [], hasMore: false, nextCursor: null }) })));
    render(<ExecutionHistory bagId="bag-1" />);
    await screen.findByText('You have no executions in this Bag yet.');
  });

  it('loads further pages with the returned cursor', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const second = url.includes('cursor=');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          schemaVersion: 2, bagId: 'bag-1', scope: 'VIEWER_OWN_EXECUTIONS',
          executions: [receipt({ executionId: second ? 'e2' : 'e1', kind: second ? 'REDEEM' : 'PURCHASE', strategyVersion: second ? null : 5 })],
          hasMore: !second, nextCursor: second ? null : 'CURSOR1',
        }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<ExecutionHistory bagId="bag-1" />);
    await screen.findByText('Purchase');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    });
    await screen.findByText('Redeem');
    expect(fetchMock.mock.calls[1][0]).toBe('/api/bags/bag-1/executions?cursor=CURSOR1');
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });
});
