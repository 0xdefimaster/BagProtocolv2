// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

afterEach(cleanup);

let pathname = '/dashboard/explore';
vi.mock('next/navigation', () => ({ usePathname: () => pathname }));
vi.mock('next/image', () => ({ default: (props: Record<string, unknown>) => <span role="img" aria-label={String(props.alt)} /> }));
vi.mock('@/lib/wallet-context', () => ({ useWallet: () => ({ chainName: 'Robinhood Chain', isConnected: false }) }));

import { APP_NAV, AppSidebar, isActiveLink } from '../AppSidebar';

const link = (label: string) => APP_NAV.flat().find((l) => l.label === label)!;

describe('AppSidebar', () => {
  it('lists every app page once, in two groups', () => {
    render(<AppSidebar />);
    for (const l of APP_NAV.flat()) expect(screen.getByRole('link', { name: l.label })).toHaveAttribute('href', l.href);
    expect(APP_NAV.flat().map((l) => l.label)).toEqual(['Explore', 'Portfolio', 'Create', 'Swap', 'Leaderboard', 'Proof', 'Profile']);
  });

  it('marks the current page, and a Bag page as part of Explore', () => {
    pathname = '/dashboard/bag/d855d1e6';
    render(<AppSidebar />);
    expect(screen.getByRole('link', { name: 'Explore' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Portfolio' })).not.toHaveAttribute('aria-current');
  });

  it('matches whole path segments only', () => {
    expect(isActiveLink(link('Create'), '/dashboard/create')).toBe(true);
    expect(isActiveLink(link('Create'), '/dashboard/created')).toBe(false);
    expect(isActiveLink(link('Portfolio'), '/dashboard/portfolio/holdings')).toBe(true);
    expect(isActiveLink(link('Explore'), null)).toBe(false);
  });

  it('shows the chain and a connect hint when no wallet is connected', () => {
    render(<AppSidebar />);
    expect(screen.getByText('Robinhood Chain')).toBeInTheDocument();
    expect(screen.getByText('Connect a wallet to see your Bags.')).toBeInTheDocument();
  });
});
