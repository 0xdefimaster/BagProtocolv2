// -----------------------------------------------------------------------------
// The app's pages, in the order the top bar lists them (and the mobile menu
// below 1101px). Only pages that exist are listed.
// -----------------------------------------------------------------------------

export interface AppNavLink {
  href: string;
  label: string;
  /** Other path prefixes that belong to this entry (a Bag page sits under Explore). */
  also?: string[];
}

export const APP_NAV: AppNavLink[] = [
  { href: '/dashboard/explore', label: 'Explore', also: ['/dashboard/bag/', '/dashboard/creator/'] },
  { href: '/dashboard/portfolio', label: 'Portfolio' },
  { href: '/dashboard/create', label: 'Create' },
  { href: '/dashboard/swap', label: 'Swap' },
  ...(process.env.NEXT_PUBLIC_DCA_TRIAL === 'true' && process.env.NODE_ENV === 'development' ? [{ href: '/dashboard/dca', label: 'DCA' }] : []),
  { href: '/dashboard/leaderboard', label: 'Leaderboard' },
  { href: '/dashboard/proof', label: 'Proof' },
  { href: '/dashboard/profile', label: 'Profile' },
];

export function isActiveLink(link: AppNavLink, pathname: string | null): boolean {
  if (!pathname) return false;
  if (pathname === link.href || pathname.startsWith(`${link.href}/`)) return true;
  return (link.also ?? []).some((prefix) => pathname.startsWith(prefix));
}
