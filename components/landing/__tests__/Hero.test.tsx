// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';

// -----------------------------------------------------------------------------
// Homepage redesign — the Hero's product card must show a REAL published Bag
// whenever one exists, and fall back to a clearly-labeled "EXAMPLE" Bag only
// when none has been published yet — never presenting fabricated data as if
// it were real (same rule already enforced for Dashboard/FeaturedBags).
// -----------------------------------------------------------------------------

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

const { default: Hero } = await import('../Hero');

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Hero — real vs. example Bag (homepage redesign)', () => {
  it('shows a REAL published Bag, with no EXAMPLE badge, when one exists', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(200, {
          bags: [
            {
              id: 'real-bag-1',
              name: 'Real Growth Bag',
              composition: [
                { symbol: 'NVDA', weight: 55 },
                { symbol: 'MSFT', weight: 45 },
              ],
            },
          ],
        })
      )
    );

    render(<Hero />);

    await waitFor(() => expect(screen.getByText('Real Growth Bag')).toBeInTheDocument());
    expect(screen.queryByText('EXAMPLE')).not.toBeInTheDocument();
    // Rows sorted by weight descending.
    const rows = screen.getAllByText(/NVDA|MSFT/);
    expect(rows[0]).toHaveTextContent('NVDA');
  });

  it('falls back to a clearly-labeled EXAMPLE Bag when nothing has been published yet', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { bags: [] })));

    render(<Hero />);

    await waitFor(() => expect(screen.getByText('AI Growth')).toBeInTheDocument());
    expect(screen.getByText('EXAMPLE')).toBeInTheDocument();
  });

  it('an API failure also falls back to the labeled EXAMPLE Bag, never a blank or broken card', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(500, { error: 'boom' })));

    render(<Hero />);

    await waitFor(() => expect(screen.getByText('AI Growth')).toBeInTheDocument());
    expect(screen.getByText('EXAMPLE')).toBeInTheDocument();
  });

  it('the amount is an input: the allocation is recomputed for whatever the visitor enters', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { bags: [] })));
    render(<Hero />);
    const input = screen.getByLabelText(/amount \(usd\)/i);
    fireEvent.change(input, { target: { value: '250' } });
    // EXAMPLE Bag: NVDA 40% → $100, MSFT/TSLA 30% → $75.00 (cents below $100)
    await waitFor(() => expect(screen.getByText('$100')).toBeInTheDocument());
    expect(screen.getAllByText('$75.00')).toHaveLength(2);
    fireEvent.change(input, { target: { value: 'abc' } });
    expect(input).toHaveValue('');
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('states the category, value proposition and differentiator', () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { bags: [] })));
    render(<Hero />);
    expect(screen.getByText(/programmable portfolios for onchain assets/i)).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/one strategy\.\s*a complete portfolio\./i);
    expect(screen.getByText(/forked with its lineage intact/i)).toBeInTheDocument();
  });

  it('the primary CTA links to Explore, never to a developer-first "start building" destination', () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { bags: [] })));
    render(<Hero />);

    const exploreLink = screen.getByRole('link', { name: /explore bags/i });
    expect(exploreLink).toHaveAttribute('href', '/dashboard/explore');
    const createLink = screen.getByRole('link', { name: /create a bag/i });
    expect(createLink).toHaveAttribute('href', '/dashboard/create');
  });
});
