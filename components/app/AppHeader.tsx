'use client';

import Image from 'next/image';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Wallet, Loader2, Search } from 'lucide-react';
import { useWallet } from '@/lib/wallet-context';
import { NotificationBell } from './NotificationBell';
import { WalletMenu } from './WalletMenu';
import { APP_NAV, isActiveLink } from './AppSidebar';
import { ThemeToggle } from '@/components/ui/ThemeToggle';

// Top bar. On desktop the sidebar (AppSidebar) carries the navigation; below
// 1101px the brand and the menu button come back here with the same links.
const APP_LINKS = APP_NAV.flat();

const PANEL_ID = 'app-mobile-nav';

export function AppHeader() {
  const { isConnected, isConnecting, hasProvider, chainName, error, connect } = useWallet();
  const [menuOpen, setMenuOpen] = useState(false);
  const [search, setSearch] = useState('');
  const toggleRef = useRef<HTMLButtonElement>(null);
  const router = useRouter();
  const pathname = usePathname();

  // Search runs on Explore, which filters by name, creator or asset.
  const onSearch = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const q = search.trim();
    router.push(q ? `/dashboard/explore?q=${encodeURIComponent(q)}` : '/dashboard/explore');
  };

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
      <div className="nav app-topbar">
        <Link href="/dashboard" className="brand app-header-brand">
          <Image src="/logo.png" alt="Bag Protocol mark" width={32} height={32} />
          <div className="brand-text">
            <span className="b1">BAG PROTOCOL</span>
            <span className="b2 mono">Studio</span>
          </div>
        </Link>

        <form className="app-search" role="search" onSubmit={onSearch}>
          <Search size={16} aria-hidden="true" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search strategies, creators, assets…"
            aria-label="Search Bags"
          />
        </form>

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
                <Link href={link.href} aria-current={isActiveLink(link, pathname) ? 'page' : undefined} onClick={() => setMenuOpen(false)}>
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
