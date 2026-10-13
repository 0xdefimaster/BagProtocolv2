// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

// Swap page: Buy (default) and Sell behind sign-in, each with its own panel.

let wallet: Record<string, unknown> = {};
vi.mock('@/lib/wallet-context', () => ({ useWallet: () => wallet }));
vi.mock('@/components/portfolio/WalletAssetsPanel', () => ({
  WalletAssetsPanel: ({ walletAddress }: { walletAddress: string }) => <div data-testid="sell-panel">{walletAddress}</div>,
}));
vi.mock('@/components/portfolio/BuyPanel', () => ({
  BuyPanel: ({ walletAddress }: { walletAddress: string }) => <div data-testid="buy-panel">{walletAddress}</div>,
}));

const { default: SwapPage } = await import('../page');

afterEach(cleanup);

describe('Swap page', () => {
  it('signed out: explains buying with ETH in one signature and asks to connect; no panel', () => {
    wallet = { isConnected: false, authUser: null, connect: vi.fn(), signIn: vi.fn() };
    render(<SwapPage />);
    expect(screen.getByRole('heading', { name: 'Swap' })).toBeInTheDocument();
    expect(screen.getByText(/Buy or sell several tokens in one transaction/)).toBeInTheDocument();
    expect(screen.getByText('Pay with ETH')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect wallet' })).toBeInTheDocument();
    expect(screen.queryByTestId('buy-panel')).toBeNull();
  });

  it('signed in: Buy first, Sell one tab away, both for the signed-in wallet', () => {
    wallet = { isConnected: true, authUser: { walletAddress: '0xabc' }, connect: vi.fn(), signIn: vi.fn() };
    render(<SwapPage />);
    expect(screen.getByTestId('buy-panel')).toHaveTextContent('0xabc');
    fireEvent.click(screen.getByRole('tab', { name: 'Sell' }));
    expect(screen.getByTestId('sell-panel')).toHaveTextContent('0xabc');
    expect(screen.getByText('Stablecoin or ETH')).toBeInTheDocument();
  });
});
