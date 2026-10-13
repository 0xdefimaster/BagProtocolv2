// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

// Swap page: the wallet's sell-to-USDG panel behind sign-in, and a Swap link in the app menu.

let wallet: Record<string, unknown> = {};
vi.mock('@/lib/wallet-context', () => ({ useWallet: () => wallet }));
vi.mock('@/components/portfolio/WalletAssetsPanel', () => ({
  WalletAssetsPanel: ({ walletAddress }: { walletAddress: string }) => <div data-testid="panel">{walletAddress}</div>,
}));

const { default: SwapPage } = await import('../page');

afterEach(cleanup);

describe('Swap page', () => {
  it('signed out: explains the one-transaction sale and asks to connect; no panel', () => {
    wallet = { isConnected: false, authUser: null, connect: vi.fn(), signIn: vi.fn() };
    render(<SwapPage />);
    expect(screen.getByRole('heading', { name: 'Swap' })).toBeInTheDocument();
    expect(screen.getByText(/in one transaction, straight from your wallet/)).toBeInTheDocument();
    expect(screen.getByText('One signature')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect wallet' })).toBeInTheDocument();
    expect(screen.queryByTestId('panel')).toBeNull();
  });

  it('signed in: shows the wallet panel for the signed-in wallet', () => {
    wallet = { isConnected: true, authUser: { walletAddress: '0xabc' }, connect: vi.fn(), signIn: vi.fn() };
    render(<SwapPage />);
    expect(screen.getByTestId('panel')).toHaveTextContent('0xabc');
  });
});
