// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';

// -----------------------------------------------------------------------------
// Production-hardening P0-5 — regression test 18: "Explore production does
// not use mock bags." A real, just-published Bag must actually show up in
// Explore, and — outside demo mode — a fixture bag like "AI Leaders" (from
// lib/mock-data.ts's `mockBags`) must never appear.
// -----------------------------------------------------------------------------

vi.mock('@/components/bags/BagCard', () => ({
  BagCard: ({ bag }: { bag: { id: string; name: string } }) => <div data-testid={`bag-${bag.id}`}>{bag.name}</div>,
}));

const { FeaturedBags } = await import('../FeaturedBags');

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('FeaturedBags (Explore) — real data only (P0-5, regression test 18)', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_DEMO_MODE', '');
  });

  it('renders a real, just-published bag from GET /api/bags', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(200, { bags: [{ id: 'real-bag-9', name: 'Real Published Bag', category: undefined }] }))
    );

    render(<FeaturedBags />);

    await waitFor(() => expect(screen.getByText('Real Published Bag')).toBeInTheDocument());
    expect(screen.queryByText('AI Leaders')).not.toBeInTheDocument(); // mockBags fixture name
  });

  it('an empty real result shows an honest empty state, never the mock catalog', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { bags: [] })));

    render(<FeaturedBags />);

    await waitFor(() =>
      expect(screen.getByText(/no bags have been published yet/i)).toBeInTheDocument()
    );
    expect(screen.queryByText('AI Leaders')).not.toBeInTheDocument();
    expect(screen.queryByText('L2 Ecosystem')).not.toBeInTheDocument();
  });

  it('an API failure shows an error + retry, never a silent fallback to mock bags', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(500, { error: 'boom' })));

    render(<FeaturedBags />);

    await waitFor(() => expect(screen.getByText('boom')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
    expect(screen.queryByText('AI Leaders')).not.toBeInTheDocument();
  });

  it('demo mode explicitly enabled: mock bags ARE shown, alongside any real ones', async () => {
    vi.stubEnv('NEXT_PUBLIC_DEMO_MODE', 'true');
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { bags: [] })));

    render(<FeaturedBags />);

    await waitFor(() => expect(screen.getByText('AI Leaders')).toBeInTheDocument());
  });
});

describe('FeaturedBags (Explore) — discovery', () => {
  const stock = (symbol: string, weight: number) => ({ symbol, weight, assetType: 'stock' });
  const bags = [
    { id: 'stocks', name: 'Stock Bag', creator: { name: 'alice' }, composition: [stock('AAPL', 50), stock('MSFT', 50)], tvl: 10 },
    { id: 'stable', name: 'Calm Bag', creator: { name: 'bob' }, composition: [{ symbol: 'USDG', weight: 80, stable: true }, stock('AAPL', 20)], tvl: 99 },
  ];

  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_DEMO_MODE', '');
    window.localStorage.clear();
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { bags })));
  });

  it('chips are the categories the listed Bags hold; no empty fake categories', async () => {
    render(<FeaturedBags />);
    await waitFor(() => expect(screen.getByText('Stock Bag')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Stocks' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stable' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Memes' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'L2' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Stable' }));
    expect(screen.queryByText('Stock Bag')).not.toBeInTheDocument();
    expect(screen.getByText('Calm Bag')).toBeInTheDocument();
  });

  it('risk filter and sort by TVL', async () => {
    render(<FeaturedBags />);
    await waitFor(() => expect(screen.getByText('Stock Bag')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Sort by'), { target: { value: 'tvl' } });
    expect(screen.getAllByTestId(/^bag-/).map((el) => el.textContent)).toEqual(['Calm Bag', 'Stock Bag']);
    fireEvent.change(screen.getByLabelText('Risk level'), { target: { value: 'Low' } });
    expect(screen.getAllByTestId(/^bag-/).map((el) => el.textContent)).toEqual(['Calm Bag']);
  });

  it('watchlist chip shows Bags saved in this browser; an empty one explains itself', async () => {
    render(<FeaturedBags />);
    await waitFor(() => expect(screen.getByText('Stock Bag')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Watchlist' }));
    expect(screen.getByText(/your watchlist is empty/i)).toBeInTheDocument();
    cleanup();

    window.localStorage.setItem('bag-protocol:watchlist', JSON.stringify(['stocks']));
    render(<FeaturedBags />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Watchlist (1)' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Watchlist (1)' }));
    expect(screen.getByText('Stock Bag')).toBeInTheDocument();
    expect(screen.queryByText('Calm Bag')).not.toBeInTheDocument();
  });
});
