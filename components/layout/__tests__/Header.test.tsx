// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import Header from '../Header';
import { NAV_LINKS } from '@/lib/constants';

// Mobile navigation behavior (keyboard + ARIA), asserted on the real component.
// Visibility by breakpoint is CSS (checked in a real browser — see
// scripts/responsive-check.mjs); here the menu's state and semantics are tested.

afterEach(() => {
  cleanup();
  document.body.style.overflow = '';
});

const toggle = () => screen.getByRole('button', { name: 'Navigation menu' });
const panel = () => document.getElementById('mobile-nav') as HTMLElement;

describe('Header — mobile navigation', () => {
  it('button is named, collapsed by default, and controls the panel; the panel is hidden (out of the tab order)', () => {
    render(<Header />);
    expect(toggle()).toHaveAttribute('aria-expanded', 'false');
    expect(toggle()).toHaveAttribute('aria-controls', 'mobile-nav');
    expect(toggle()).toHaveAttribute('type', 'button');
    expect(panel()).not.toBeVisible();
    expect(panel().hidden).toBe(true);
  });

  it('opening expands, reveals every nav link + Launch App, moves focus into the menu and locks page scroll', () => {
    render(<Header />);
    fireEvent.click(toggle());
    expect(toggle()).toHaveAttribute('aria-expanded', 'true');
    expect(panel()).toBeVisible();
    const mobile = within(screen.getByRole('navigation', { name: 'Mobile' }));
    for (const link of NAV_LINKS) expect(mobile.getByRole('link', { name: link.label })).toHaveAttribute('href', link.href);
    expect(mobile.getByRole('link', { name: /Launch App/ })).toBeInTheDocument();
    expect(document.activeElement).toBe(mobile.getByRole('link', { name: NAV_LINKS[0].label }));
    expect(document.body.style.overflow).toBe('hidden');
  });

  it('Escape closes, returns focus to the menu button and restores page scroll exactly', () => {
    document.body.style.overflow = 'auto';
    render(<Header />);
    fireEvent.click(toggle());
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(toggle()).toHaveAttribute('aria-expanded', 'false');
    expect(panel().hidden).toBe(true);
    expect(document.activeElement).toBe(toggle());
    expect(document.body.style.overflow).toBe('auto');
  });

  it('choosing a link closes the menu', () => {
    render(<Header />);
    fireEvent.click(toggle());
    fireEvent.click(within(panel()).getByRole('link', { name: NAV_LINKS[2].label }));
    expect(toggle()).toHaveAttribute('aria-expanded', 'false');
  });

  it('focus leaving the header closes the menu (keyboard users are never stranded behind it)', () => {
    render(
      <>
        <Header />
        <a href="#after">after</a>
      </>
    );
    fireEvent.click(toggle());
    const last = within(panel()).getByRole('link', { name: /Launch App/ });
    fireEvent.blur(last, { relatedTarget: screen.getByRole('link', { name: 'after' }) });
    expect(toggle()).toHaveAttribute('aria-expanded', 'false');
  });

  it('pressing the button again closes it; Escape while closed does nothing', () => {
    render(<Header />);
    fireEvent.click(toggle());
    fireEvent.click(toggle());
    expect(toggle()).toHaveAttribute('aria-expanded', 'false');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(toggle()).toHaveAttribute('aria-expanded', 'false');
  });

  it('desktop navigation is a labelled landmark; the logo is decorative (the link is named by its text)', () => {
    render(<Header />);
    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument();
    const brand = screen.getByRole('link', { name: /BAG PROTOCOL/ });
    expect(brand.querySelector('img')).toHaveAttribute('alt', '');
  });
});
