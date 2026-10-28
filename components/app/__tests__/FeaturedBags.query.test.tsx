// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

afterEach(cleanup);

vi.mock('@/components/bags/BagCard', () => ({ BagCard: () => null }));
vi.mock('@/hooks/usePublicBags', () => ({ usePublicBags: () => ({ bags: [], isLoading: false, isError: false, error: null, refresh: vi.fn() }) }));
vi.mock('@/lib/watchlist-store', () => ({ useWatchlist: () => ({ watchlist: new Set<string>(), toggle: vi.fn(), has: () => false }) }));

import { FeaturedBags } from '../FeaturedBags';

describe('FeaturedBags initialQuery (header search)', () => {
  it('starts from the query and follows a new one', () => {
    const { rerender } = render(<FeaturedBags initialQuery="NVDA" />);
    expect(screen.getByLabelText('Search Bags')).toHaveValue('NVDA');
    rerender(<FeaturedBags initialQuery="AAPL" />);
    expect(screen.getByLabelText('Search Bags')).toHaveValue('AAPL');
  });

  it('is empty without one', () => {
    render(<FeaturedBags />);
    expect(screen.getByLabelText('Search Bags')).toHaveValue('');
  });
});
