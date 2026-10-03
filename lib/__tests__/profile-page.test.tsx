// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

const ME = '0x49da000000000000000000000000000000fe46';
const OTHER = '0xbbbb00000000000000000000000000000000bbbb';

const wallet = { isConnected: true, walletAddress: ME };
let following: string[] = [];

function bag(id: string, address: string, name: string) {
  return { id, name, tvl: 0, forks: 0, creator: { address, name, avatar: '' }, updateLog: [] };
}
const publicBags = [bag('a1', OTHER, 'Other'), bag('a2', OTHER, 'Other'), bag('a3', OTHER, 'Other'), bag('m1', ME, 'Me'), bag('m2', ME, 'Me')];

vi.mock('next/link', () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock('@/lib/wallet-context', () => ({
  useWallet: () => ({
    ...wallet,
    isConnecting: false,
    hasProvider: true,
    chainName: 'Robinhood Chain',
    connect: vi.fn(),
    disconnect: vi.fn(),
    authUser: null,
  }),
  shortenAddress: (a: string) => a.slice(0, 6),
}));
vi.mock('@/lib/config/demo-mode', () => ({ isDemoModeEnabled: () => false }));
vi.mock('@/hooks/usePublicBags', () => ({ usePublicBags: () => ({ bags: publicBags }) }));
vi.mock('@/lib/user-bags-store', () => ({ useUserBags: () => ({ userBags: [], hydrated: true }) }));
vi.mock('@/hooks/useMyBags', () => ({
  useMyBags: () => ({ bags: [], isAuthenticated: true, isLoading: false, isError: false, error: null, refresh: vi.fn() }),
}));
vi.mock('@/lib/activity-store', () => ({ useActivity: () => ({ activity: [] }), formatRelativeTime: () => '' }));
vi.mock('@/lib/creator-follow-store', () => ({ useCreatorFollows: () => ({ following }) }));
vi.mock('@/lib/x-connect-store', () => ({
  useXConnection: () => ({ handle: null, isConnected: false, connectHandle: vi.fn(), disconnectHandle: vi.fn() }),
}));
vi.mock('@/hooks/useCreatorRewards', () => ({
  useCreatorRewards: () => ({ rewards: [], totalQuote: '0', claimableDisplay: null, claimableTokenSymbol: 'USDG', isVaultConfigured: false, isClaiming: false, claimError: null, lastClaimTxHash: null, claim: vi.fn() }),
}));
vi.mock('@/hooks/usePoints', () => ({ usePoints: () => ({ points: null }) }));
vi.mock('@/hooks/useLeaderboard', () => ({ useLeaderboard: () => ({ result: null }) }));
vi.mock('@/hooks/useBagNFTs', () => ({ useBagNFTs: () => ({ nfts: [] }) }));
vi.mock('@/components/profile/ProfileEditor', () => ({ ProfileEditor: () => null }));
vi.mock('@/components/creator/CreatorAvatar', () => ({ CreatorAvatar: () => null }));
vi.mock('@/components/activity/ActivityFeed', () => ({ ActivityFeed: () => null }));

import ProfilePage from '@/app/dashboard/profile/page';

afterEach(() => {
  cleanup();
  wallet.isConnected = true;
  wallet.walletAddress = ME;
});

describe('profile page', () => {
  it('shows a followed creator once, however many Bags they published, and never yourself', () => {
    following = [OTHER, ME.toUpperCase().replace('0X', '0x')];
    render(<ProfilePage />);
    const chips = screen.getAllByRole('link').filter((a) => a.getAttribute('href')?.startsWith('/dashboard/creator/0x'));
    const followChips = chips.filter((a) => a.textContent?.includes('Other') || a.textContent?.includes('Me'));
    expect(followChips.map((a) => a.textContent?.trim())).toEqual(['Other']);
  });

  it('without a wallet asks to connect instead of showing a placeholder identity', () => {
    wallet.isConnected = false;
    wallet.walletAddress = '';
    following = [ME];
    render(<ProfilePage />);
    expect(screen.getByRole('button', { name: /Connect Wallet/ })).toBeTruthy();
    expect(screen.queryByText(/demo address/)).toBeNull();
    expect(screen.queryByText('Following')).toBeNull();
  });
});
