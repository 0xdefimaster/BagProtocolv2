// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ProofView } from '../ProofView';
import type { ProtocolProof } from '@/lib/server/protocol-proof';

afterEach(cleanup);

const TX = `0x${'ab'.repeat(32)}`;
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';

const proof: ProtocolProof = {
  generatedAt: '2026-10-11T12:00:00.000Z',
  windowDays: 30,
  tvl: {
    total: 400,
    byState: { VERIFIED: 300, STALE: 0, PENDING_OUTFLOW: 0, UNVERIFIED: 100 },
    bagsByState: { VERIFIED: 1, STALE: 0, PENDING_OUTFLOW: 0, UNVERIFIED: 1 },
  },
  bags: [
    { id: 'b1', name: 'Tech Bag', tvl: 300, return7d: 1.5, return30d: -2, state: 'VERIFIED', checkedAt: '2026-10-11T11:58:00Z' },
    { id: 'b2', name: 'Other Bag', tvl: 100, return7d: null, return30d: null, state: 'UNVERIFIED', checkedAt: null },
  ],
  executions: { purchases: { succeeded: 9, partial: 0, failed: 1, pending: 2 }, redeems: { succeeded: 3, partial: 0, failed: 0, pending: 0 }, successRateBps: 9230 },
  money: [
    {
      token: USDG,
      symbol: 'USDG',
      decimals: 6,
      performanceFeesPaidRaw: '2500000',
      vaultCreditsRaw: { FORK_ROYALTY: '1500000', PERFORMANCE_FEE: '0' },
      exits: { count: 3, grossProceedsRaw: '100000000', costBasisRaw: '90000000', feesRaw: '2500000', netRealizedPnlRaw: '7500000' },
    },
  ],
  recent: [
    { type: 'FEE_PAID', at: '2026-10-11T11:59:00Z', bagId: 'b1', bagName: 'Tech Bag', tx: { chain: 'robinhood', txHash: TX, url: `https://explorer.example/tx/${TX}` }, token: USDG, decimals: 6, amountRaw: '2500000', symbol: 'USDG' },
    { type: 'EXECUTION', at: '2026-10-11T11:00:00Z', bagId: 'x', bagName: null, kind: 'PURCHASE', outcome: 'SUCCEEDED', tx: { chain: 'solana', txHash: TX, url: null } },
  ],
  truncated: [],
};

describe('ProofView', () => {
  it('headline figures from raw amounts, tables, and transaction links', () => {
    render(<ProofView proof={proof} />);
    expect(screen.getAllByText('$300.00').length).toBeGreaterThan(0);
    expect(screen.getByText(/75% of \$400.00/)).toBeInTheDocument();
    expect(screen.getByText('92.30%')).toBeInTheDocument();
    expect(screen.getByText(/10 buys, 3 sells finished/)).toBeInTheDocument();
    // 2.5 fee + 1.5 royalty
    expect(screen.getByText('4.00 USDG')).toBeInTheDocument();
    expect(screen.getByText('7.50 USDG')).toBeInTheDocument();
    expect(screen.getAllByText('Tech Bag')[0].closest('a')).toHaveAttribute('href', '/dashboard/bag/b1');
    expect(screen.getByText('Unlisted Bag')).toBeInTheDocument();
    const link = screen.getAllByText(/0xababab…/)[0].closest('a');
    expect(link).toHaveAttribute('href', `https://explorer.example/tx/${TX}`);
    expect(link).toHaveAttribute('target', '_blank');
    expect(screen.getByText('succeeded')).toBeInTheDocument();
    expect(screen.queryByText(/cover the most recent records only/)).not.toBeInTheDocument();
  });

  it('empty protocol: no figures invented', () => {
    render(
      <ProofView
        proof={{
          ...proof,
          tvl: { total: 0, byState: { VERIFIED: 0, STALE: 0, PENDING_OUTFLOW: 0, UNVERIFIED: 0 }, bagsByState: { VERIFIED: 0, STALE: 0, PENDING_OUTFLOW: 0, UNVERIFIED: 0 } },
          bags: [],
          executions: { purchases: { succeeded: 0, partial: 0, failed: 0, pending: 0 }, redeems: { succeeded: 0, partial: 0, failed: 0, pending: 0 }, successRateBps: null },
          money: [],
          recent: [],
          truncated: ['executions'],
        }}
      />
    );
    expect(screen.getByText('No TVL yet')).toBeInTheDocument();
    expect(screen.getByText('No settled sells yet')).toBeInTheDocument();
    expect(screen.getByText(/No live Bag holds any value yet/)).toBeInTheDocument();
    expect(screen.getByText(/No fee, royalty or settled sell/)).toBeInTheDocument();
    expect(screen.getByText(/No transaction recorded yet/)).toBeInTheDocument();
    expect(screen.getByText(/Totals for executions cover the most recent records only/)).toBeInTheDocument();
  });
});
