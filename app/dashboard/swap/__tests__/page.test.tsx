// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

// Swap page: the swap card behind sign-in.

let wallet: Record<string, unknown> = {};
vi.mock('@/lib/wallet-context', () => ({ useWallet: () => wallet }));
vi.mock('@/components/swap/SwapCard', () => ({
  SwapCard: ({ walletAddress }: { walletAddress: string }) => <div data-testid="swap-card">{walletAddress}</div>,
}));

const { default: SwapPage } = await import('../page');

afterEach(cleanup);

describe('Swap page', () => {
  it('signed out: explains multi-buy / multi-sell and asks to connect, MetaMask named; no card', () => {
    wallet = { isConnected: false, authUser: null, connect: vi.fn(), signIn: vi.fn() };
    render(<SwapPage />);
    expect(screen.getByRole('heading', { name: 'Pick tokens. Swap them in one transaction.' })).toBeInTheDocument();
    expect(screen.getByText(/Buy several tokens with one payment, or sell several for one/)).toBeInTheDocument();
    expect(screen.getByText(/Works best with MetaMask/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect wallet' })).toBeInTheDocument();
    expect(screen.queryByTestId('swap-card')).toBeNull();
  });

  it('signed in: the swap card for the signed-in wallet', () => {
    wallet = { isConnected: true, authUser: { walletAddress: '0xabc' }, connect: vi.fn(), signIn: vi.fn() };
    render(<SwapPage />);
    expect(screen.getByTestId('swap-card')).toHaveTextContent('0xabc');
  });
});
