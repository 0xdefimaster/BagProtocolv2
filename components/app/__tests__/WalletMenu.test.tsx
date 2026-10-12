// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const wallet = vi.hoisted(() => ({ switchAccount: vi.fn(async () => {}), disconnect: vi.fn() }));
vi.mock('@/lib/wallet-context', () => ({
  useWallet: () => ({ walletAddress: '0x49da000000000000000000000000000000fe46', ...wallet }),
  shortenAddress: (a: string) => `${a.slice(0, 6)}...${a.slice(-4)}`,
}));

const { WalletMenu } = await import('../WalletMenu');

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('WalletMenu', () => {
  it('the pill opens a menu with the full address, Switch account, Disconnect and how switching works', () => {
    render(<WalletMenu />);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /0x49da...fe46/ }));
    expect(screen.getByText('0x49da000000000000000000000000000000fe46')).toBeInTheDocument();
    expect(screen.getByText(/Wallets only share accounts you connected/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('menuitem', { name: /Switch account/ }));
    expect(wallet.switchAccount).toHaveBeenCalledTimes(1);
    expect(wallet.disconnect).not.toHaveBeenCalled();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('Disconnect is a deliberate menu choice, not a click on the pill', () => {
    render(<WalletMenu />);
    fireEvent.click(screen.getByRole('button', { name: /0x49da...fe46/ }));
    expect(wallet.disconnect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('menuitem', { name: /Disconnect/ }));
    expect(wallet.disconnect).toHaveBeenCalledTimes(1);
  });
});
