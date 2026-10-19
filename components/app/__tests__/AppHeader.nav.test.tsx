// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

afterEach(cleanup);

let pathname = '/dashboard/explore';
const push = vi.fn();
vi.mock('next/navigation', () => ({ usePathname: () => pathname, useRouter: () => ({ push }) }));
vi.mock('next/image', () => ({ default: (props: Record<string, unknown>) => <span role="img" aria-label={String(props.alt)} /> }));
vi.mock('@/lib/wallet-context', () => ({
  useWallet: () => ({ isConnected: false, isConnecting: false, hasProvider: true, chainName: 'Robinhood Chain', error: null, connect: vi.fn() }),
}));
vi.mock('../NotificationBell', () => ({ NotificationBell: () => null }));
vi.mock('../WalletMenu', () => ({ WalletMenu: () => null }));
vi.mock('@/components/ui/ThemeToggle', () => ({ ThemeToggle: () => null }));

import { AppHeader } from '../AppHeader';
import { APP_NAV, isActiveLink } from '../app-nav';

describe('App top bar', () => {
  it('lists every app page in the top bar, the current one marked; a Bag page counts as Explore', () => {
    pathname = '/dashboard/bag/d855d1e6';
    render(<AppHeader />);
    const nav = screen.getByRole('navigation', { name: 'App' });
    const links = Array.from(nav.querySelectorAll('a'));
    expect(links.map((a) => a.textContent)).toEqual(['Explore', 'Portfolio', 'Create', 'Swap', 'Leaderboard', 'Proof', 'Profile']);
    expect(links[0]).toHaveAttribute('aria-current', 'page');
    expect(links[1]).not.toHaveAttribute('aria-current');
  });

  it('search goes to Explore with the query', () => {
    render(<AppHeader />);
    fireEvent.change(screen.getByLabelText('Search Bags'), { target: { value: 'NVDA ' } });
    fireEvent.submit(screen.getByRole('search'));
    expect(push).toHaveBeenCalledWith('/dashboard/explore?q=NVDA');
  });

  it('matches whole path segments only', () => {
    const create = APP_NAV.find((l) => l.label === 'Create')!;
    expect(isActiveLink(create, '/dashboard/create')).toBe(true);
    expect(isActiveLink(create, '/dashboard/created')).toBe(false);
    expect(isActiveLink(create, null)).toBe(false);
  });
});
