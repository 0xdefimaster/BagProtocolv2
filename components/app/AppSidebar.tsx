'use client';

import Image from 'next/image';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ArrowLeftRight, Briefcase, Compass, Plus, ShieldCheck, Trophy, User, type LucideIcon } from 'lucide-react';
import { useWallet } from '@/lib/wallet-context';

// -----------------------------------------------------------------------------
// App sidebar (desktop, ≥1101px). Holds the navigation the header used to
// carry; below 1101px it is hidden and the header's menu button takes over
// with the same links (APP_NAV), so both always list the same pages.
// Only pages that exist are listed.
// -----------------------------------------------------------------------------

export interface AppNavLink {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Other path prefixes that belong to this entry (a Bag page sits under Explore). */
  also?: string[];
}

export const APP_NAV: AppNavLink[][] = [
  [
    { href: '/dashboard/explore', label: 'Explore', icon: Compass, also: ['/dashboard/bag/', '/dashboard/creator/'] },
    { href: '/dashboard/portfolio', label: 'Portfolio', icon: Briefcase },
    { href: '/dashboard/create', label: 'Create', icon: Plus },
    { href: '/dashboard/swap', label: 'Swap', icon: ArrowLeftRight },
  ],
  [
    { href: '/dashboard/leaderboard', label: 'Leaderboard', icon: Trophy },
    { href: '/dashboard/proof', label: 'Proof', icon: ShieldCheck },
    { href: '/dashboard/profile', label: 'Profile', icon: User },
  ],
];

export function isActiveLink(link: AppNavLink, pathname: string | null): boolean {
  if (!pathname) return false;
  if (pathname === link.href || pathname.startsWith(`${link.href}/`)) return true;
  return (link.also ?? []).some((prefix) => pathname.startsWith(prefix));
}

export function AppSidebar() {
  const pathname = usePathname();
  const { chainName, isConnected } = useWallet();

  return (
    <aside className="app-sidebar" aria-label="App">
      <Link href="/dashboard" className="brand app-sidebar-brand">
        <Image src="/logo.png" alt="Bag Protocol mark" width={28} height={28} />
        <div className="brand-text">
          <span className="b1">BAG PROTOCOL</span>
          <span className="b2 mono">Studio</span>
        </div>
      </Link>

      <nav className="app-sidebar-nav" aria-label="App sections">
        {APP_NAV.map((group, i) => (
          <ul key={i} className="app-sidebar-group">
            {group.map((link) => {
              const active = isActiveLink(link, pathname);
              const Icon = link.icon;
              return (
                <li key={link.href}>
                  <Link href={link.href} className="app-sidebar-link" aria-current={active ? 'page' : undefined}>
                    <Icon size={17} aria-hidden="true" />
                    {link.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        ))}
      </nav>

      <div className="app-sidebar-foot">
        <span className="chain-badge">
          <span className="dot" />
          {chainName ?? 'Robinhood Chain'}
        </span>
        {!isConnected && <span className="app-sidebar-hint">Connect a wallet to see your Bags.</span>}
      </div>
    </aside>
  );
}
