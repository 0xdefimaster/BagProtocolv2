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
    { stepIndex: 0, action: 'SWAP', outcome: 'FILLED', asset: { chain: 'robinhood', chainId: 4663, address: '0xnvda', symbol: 'NVDA', decimals: 18 }, inputAmountRaw: '1', bagMinimumRaw: '990000000000000000', providerEnforcedMinimumRaw: '985000000000000000', actualRaw: '1000000000000000000', actualSource: 'ONCHAIN_DERIVED', quotedRaw: null, minimumRespected: true },
    { stepIndex: 1, action: 'SWAP', outcome: 'FAILED', asset: { chain: 'robinhood', chainId: 4663, address: '0xamd', symbol: 'AMD', decimals: 18 }, inputAmountRaw: '1', bagMinimumRaw: null, providerEnforcedMinimumRaw: null, actualRaw: null, actualSource: null, quotedRaw: '2000000000000000000', minimumRespected: null },
  ],
  evidence: { level: 'ONCHAIN', swapSteps: 2, filledSwaps: 1, onchainDerived: 1, providerReported: 0, unrecorded: 0 },
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
