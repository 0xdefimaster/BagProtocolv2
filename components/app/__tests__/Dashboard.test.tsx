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
// otherwise. The portfolio value is the real total of the user's positions.
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

let positionsTotal: unknown = { status: 'ready', total: '1234.5', complete: true };
vi.mock('@/hooks/usePositionsTotal', () => ({ usePositionsTotal: () => positionsTotal }));

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

    // The portfolio value is the real total of the user's positions, never a fixed "+12.5% (7D)" or a mock balance.
    const valueRow = screen.getByText('Portfolio Value').closest('.dash-stat');
    expect(valueRow!.querySelector('.v')?.textContent).toBe('$1,234.50');
    expect(screen.queryByText(/12\.5%/)).not.toBeInTheDocument();
    // Real following count (1) only, never mockUser.following (12) added.
    const followingRow = screen.getByText('Following').closest('.dash-stat');
    expect(followingRow!.querySelector('.v')?.textContent).toBe('1');
    // No paper trading, points, boxes or JSON import on the dashboard.
    expect(screen.queryByText(/Paper/)).not.toBeInTheDocument();
    expect(screen.queryByText(/BAG Points/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Open Boxes/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Import JSON/)).not.toBeInTheDocument();
    // Only the one real bag renders — mockUserBags never appended.
    expect(screen.getByText('Real Bag')).toBeInTheDocument();
    expect(screen.queryByText('AI Leaders')).not.toBeInTheDocument(); // a mockBags/mockUserBags fixture name
  });

  it('an incomplete total is marked, an unknown one is a dash', () => {
    positionsTotal = { status: 'ready', total: '10', complete: false };
    render(<Dashboard isConnected={true} />);
    expect(screen.getByText('Portfolio Value').closest('.dash-stat')!.querySelector('.v')?.textContent).toBe('$10.00*');
    cleanup();
    positionsTotal = { status: 'error' };
    render(<Dashboard isConnected={true} />);
    expect(screen.getByText('Portfolio Value').closest('.dash-stat')!.querySelector('.v')?.textContent).toBe('—');
    positionsTotal = { status: 'ready', total: '1234.5', complete: true };
  });

  it('demo mode explicitly enabled: mock bag counts are blended in (opt-in only, never the default)', () => {
    vi.stubEnv('NEXT_PUBLIC_DEMO_MODE', 'true');
    render(<Dashboard isConnected={true} />);
    const myBagsRow = screen.getAllByText('My Bags')[0].closest('.dash-stat');
    expect(myBagsRow!.querySelector('.v')?.textContent).toBe('4'); // mockUser.myBags (3) + real (1)
  });

  it('renders nothing for a disconnected wallet, regardless of demo mode', () => {
    const { container } = render(<Dashboard isConnected={false} />);
    expect(container).toBeEmptyDOMElement();
  });
});
