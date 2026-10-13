'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Wallet, Loader2 } from 'lucide-react';
import { useWallet } from '@/lib/wallet-context';
import { NotificationBell } from './NotificationBell';
import { WalletMenu } from './WalletMenu';
import { ThemeToggle } from '@/components/ui/ThemeToggle';

const APP_LINKS = [
  { href: '/dashboard/explore', label: 'Explore' },
  { href: '/dashboard/leaderboard', label: 'Leaderboard' },
  { href: '/dashboard/proof', label: 'Proof' },
  { href: '/dashboard/create', label: 'Create' },
  { href: '/dashboard/swap', label: 'Swap' },
  { href: '/dashboard/portfolio', label: 'Portfolio' },
  { href: '/dashboard/profile', label: 'Profile' },
];

const PANEL_ID = 'app-mobile-nav';

export function AppHeader() {
  const { isConnected, isConnecting, hasProvider, chainName, error, connect } = useWallet();
  const [menuOpen, setMenuOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMenuOpen(false);
        toggleRef.current?.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [menuOpen]);

  return (
    <header>
      <div className="wrap nav">
        <Link href="/dashboard" className="brand">
          <Image src="/logo.png" alt="Bag Protocol mark" width={32} height={32} />
          <div className="brand-text">
            <span className="b1">BAG PROTOCOL</span>
            <span className="b2 mono">Studio</span>
          </div>
        </Link>

        <nav className="navlinks app-navlinks" aria-label="App">
          {APP_LINKS.map((link) => (
            <Link key={link.href} href={link.href}>
              {link.label}
            </Link>
          ))}
        </nav>

        <div className="app-nav-actions">
          <span className="chain-badge">
            <span className="dot" />
            {chainName ?? 'Robinhood Chain'}
          </span>

          <ThemeToggle />
          <NotificationBell />

          {!isConnected ? (
            <button onClick={connect} disabled={isConnecting} className="btn btn-primary">
              {isConnecting ? <Loader2 size={14} className="animate-spin" /> : <Wallet size={14} />}
              {isConnecting ? 'Connecting…' : hasProvider ? 'Connect Wallet' : 'Install Wallet'}
            </button>
          ) : (
            <WalletMenu />
          )}

          {error && (
            <div className="wallet-error-toast">
              {error}
              {!hasProvider && (
                <a href="https://metamask.io/download" target="_blank" rel="noreferrer">
                  {' '}
                  Get MetaMask →
                </a>
              )}
            </div>
          )}

          <button
            ref={toggleRef}
            type="button"
            className="nav-toggle app-nav-toggle"
            aria-label="Navigation menu"
            aria-expanded={menuOpen}
            aria-controls={PANEL_ID}
            onClick={() => setMenuOpen((o) => !o)}
          >
            <span className="nav-toggle-bars" aria-hidden="true" />
          </button>
        </div>
      </div>
      <div id={PANEL_ID} className="app-mobile-nav" hidden={!menuOpen}>
        <nav aria-label="App mobile">
          <ul>
            {APP_LINKS.map((link) => (
              <li key={link.href}>
                <Link href={link.href} onClick={() => setMenuOpen(false)}>
                  {link.label}
                </Link>
              </li>
            ))}
            <li className="app-mobile-chain">
              <span className="chain-badge">
                <span className="dot" />
                {chainName ?? 'Robinhood Chain'}
              </span>
            </li>
          </ul>
        </nav>
      </div>
    </header>
  );
}
