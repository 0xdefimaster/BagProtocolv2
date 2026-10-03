// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

// -----------------------------------------------------------------------------
// Production-hardening P0-4 — regression test 17: "Production/Demo=false
// does not return mock dashboard values." A signed-in, wallet-connected
// user's Dashboard used to unconditionally blend `mockUser.balance`/
// `mockUser.myBags`/`mockUser.following`/`mockUser.forks` and
// `mockUserBags` into every real metric on screen. These tests prove that
// blending only happens when `NEXT_PUBLIC_DEMO_MODE === 'true'`, and never
// otherwise — a real user with a real $500 invested sees "$1K" (from real
// data only), never the old "$125K" `mockUser.balance` floor.
// -----------------------------------------------------------------------------

vi.mock('@/hooks/useMyBags', () => ({
  useMyBags: () => ({
    bags: [{ id: 'real-bag-1', name: 'Real Bag' }],
    isLoading: false,
    isError: false,
    error: null,
    isAuthenticated: true,
    refresh: vi.fn(),
  }),
}));

vi.mock('@/lib/user-bags-store', () => ({
  useUserBags: () => ({ userBags: [], addBag: vi.fn(), hydrated: true }),
}));

vi.mock('@/lib/activity-store', () => ({
  useActivity: () => ({ activity: [], addActivity: vi.fn() }),
  formatRelativeTime: () => 'just now',
}));

vi.mock('@/lib/portfolio-store', () => ({
  usePortfolio: () => ({ following: ['bag-a'], totalInvested: 1000 }),
}));

vi.mock('@/hooks/usePaperPortfolio', () => ({
  usePaperPortfolio: () => ({ portfolio: { realizedPnL: 0 }, unrealizedPnL: 0, totalValue: 10_000 }),
}));

vi.mock('@/hooks/usePoints', () => ({
  usePoints: () => ({ season: null, points: { bagPoints: 0 }, transactions: [], refresh: vi.fn() }),
}));

vi.mock('@/hooks/useLeaderboard', () => ({
  useLeaderboard: () => ({ result: null, refresh: vi.fn() }),
}));

// BagCard has its own hook dependencies (wallet, router, user-bags) and
// rendering logic entirely unrelated to what this test verifies (Dashboard's
// OWN real-vs-mock aggregation) — stubbed to a minimal marker so a Bag
// fixture only needs an `id`/`name`, not BagCard's full prop shape.
vi.mock('@/components/bags/BagCard', () => ({
  BagCard: ({ bag }: { bag: { id: string; name: string } }) => <div data-testid={`bag-${bag.id}`}>{bag.name}</div>,
}));

const { Dashboard } = await import('../Dashboard');

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe('Dashboard — demo-mode isolation (P0-4, regression test 17)', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_DEMO_MODE', '');
  });

  it('production (demo mode off, the default): shows ONLY real numbers — no mockUser padding anywhere', () => {
    render(<Dashboard isConnected={true} />);

    // Real totalInvested (1000) only, never mockUser.balance (125,000) added on top.
    expect(screen.getByText('$1K')).toBeInTheDocument();
    // Real bag count (1) only, never mockUser.myBags (3) added on top.
    // "My Bags" stat value:
    // "My Bags" text appears twice (the stat card label, and the section
    // heading above the bag grid) — the stat card is first in DOM order.
    const myBagsRow = screen.getAllByText('My Bags')[0].closest('.dash-stat');
    // Real following count (1) only, never mockUser.following (12) added.
    const followingRow = screen.getByText('Following').closest('.dash-stat');
    expect(followingRow!.querySelector('.v')?.textContent).toBe('1');
    // No real fork-tracking feature yet — honestly 0, never mockUser.forks (7).
    const forksRow = screen.getByText('Forks Made').closest('.dash-stat');
    expect(forksRow!.querySelector('.v')?.textContent).toBe('0');
    // Only the one real bag renders — mockUserBags never appended.
    expect(screen.getByText('Real Bag')).toBeInTheDocument();
    expect(screen.queryByText('AI Leaders')).not.toBeInTheDocument(); // a mockBags/mockUserBags fixture name
  });

  it('demo mode explicitly enabled: mock values are blended in (opt-in only, never the default)', () => {
    vi.stubEnv('NEXT_PUBLIC_DEMO_MODE', 'true');
    render(<Dashboard isConnected={true} />);

    // mockUser.balance (125,000) + real totalInvested (1000) = 126000 -> "$126K"
    expect(screen.getByText('$126K')).toBeInTheDocument();
    const myBagsRow = screen.getAllByText('My Bags')[0].closest('.dash-stat');
    expect(myBagsRow!.querySelector('.v')?.textContent).toBe('4'); // mockUser.myBags (3) + real (1)
  });

  it('renders nothing for a disconnected wallet, regardless of demo mode', () => {
    const { container } = render(<Dashboard isConnected={false} />);
    expect(container).toBeEmptyDOMElement();
  });
});
