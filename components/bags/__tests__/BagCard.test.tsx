// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Bag } from '@/types';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/hooks/useForkBag', () => ({ useForkBag: () => ({ fork: vi.fn(), isForking: false, forkError: null }) }));

const { BagCard } = await import('../BagCard');

const bag = {
  id: 'b1',
  name: 'Calm Bag',
  creator: { name: 'alice', avatar: '', address: '0xabc', followers: 0, forks: 0 },
  description: '',
  thesis: '',
  tvl: 12,
  followers: 0,
  forks: 0,
  performance7d: 0,
  performance30d: 0,
  performanceYtd: 0,
  chains: ['robinhood'],
  composition: [
    { symbol: 'USDG', weight: 80, stable: true },
    { symbol: 'AAPL', weight: 20, assetType: 'stock' },
  ],
  rules: { rebalanceFrequency: '', slippage: 0, minInvestment: 0 },
  social: { followers: 0, forks: 0 },
  performance: { returnsYTD: 0 },
  updateLog: [],
} as Bag;

beforeEach(() => window.localStorage.clear());
afterEach(cleanup);

describe('BagCard discovery', () => {
  it('risk level from the composition, with the facts in the tooltip', () => {
    render(<BagCard bag={bag} />);
    const chip = screen.getByText('Low risk');
    expect(chip.getAttribute('title')).toContain('80% in stablecoins');
    expect(chip.getAttribute('title')).toContain('not investment advice');
  });

  it('the star toggles the Bag in this browser without opening the Bag page', () => {
    render(<BagCard bag={bag} />);
    const star = screen.getByRole('button', { name: 'Add Calm Bag to watchlist' });
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    fireEvent(star, click);
    expect(click.defaultPrevented).toBe(true);
    expect(JSON.parse(window.localStorage.getItem('bag-protocol:watchlist')!)).toEqual(['b1']);
    expect(screen.getByRole('button', { name: 'Remove Calm Bag from watchlist' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Remove Calm Bag from watchlist' }));
    expect(JSON.parse(window.localStorage.getItem('bag-protocol:watchlist')!)).toEqual([]);
  });
});

describe('RiskSummary', () => {
  it('shows the level and the facts as text; nothing for an empty composition', async () => {
    const { RiskSummary } = await import('../RiskSummary');
    render(<RiskSummary composition={bag.composition} />);
    expect(screen.getByText('Low risk')).toBeInTheDocument();
    expect(screen.getByText(/80% in stablecoins · 20% in stock tokens · Largest position 20%/)).toBeInTheDocument();
    cleanup();
    const { container } = render(<RiskSummary composition={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
