// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

// The chain is a stubbed viem public client.
const readContract = vi.fn();
const getBalance = vi.fn();
const getGasPrice = vi.fn();
vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return { ...actual, createPublicClient: () => ({ readContract, getBalance, getGasPrice }) };
});

const { ROBINHOOD_REWARD_TOKEN } = await import('@/lib/config/robinhood-chain');
const { LaunchBuyBalance } = await import('../LaunchBuyBalance');

const WALLET = '0x' + '5'.repeat(40);

beforeEach(() => {
  readContract.mockReset();
  getBalance.mockReset();
  getGasPrice.mockReset();
});
afterEach(cleanup);

describe('LaunchBuyBalance', () => {
  it('shows the USDG balance read from the configured token; MAX fills the whole balance', async () => {
    readContract.mockResolvedValue(BigInt(250_500_000)); // 250.5 USDG
    const onMax = vi.fn();
    render(<LaunchBuyBalance chain="robinhood" native={false} walletAddress={WALLET} amount="0" onMax={onMax} />);

    await waitFor(() => expect(screen.getByTestId('launch-buy-balance').textContent).toContain('Balance: 250.50 USDG'));
    expect(readContract).toHaveBeenCalledWith(expect.objectContaining({ address: ROBINHOOD_REWARD_TOKEN.address, functionName: 'balanceOf', args: [WALLET] }));
    fireEvent.click(screen.getByRole('button', { name: 'MAX' }));
    expect(onMax).toHaveBeenCalledWith('250.5');
  });

  it('flags an amount above the balance', async () => {
    readContract.mockResolvedValue(BigInt(10_000_000)); // 10 USDG
    render(<LaunchBuyBalance chain="robinhood" native={false} walletAddress={WALLET} amount="25" onMax={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('launch-buy-balance').textContent).toContain('More than your balance'));
  });

  it('ETH: shows the native balance and MAX leaves the gas reserve', async () => {
    getBalance.mockResolvedValue(BigInt(10) ** BigInt(17)); // 0.1 ETH
    getGasPrice.mockResolvedValue(BigInt(10_000_000)); // 0.01 gwei → reserve 3M × 2 × 1e7 = 6e13 wei
    const onMax = vi.fn();
    render(<LaunchBuyBalance chain="robinhood" native walletAddress={WALLET} amount="0" onMax={onMax} />);

    await waitFor(() => expect(screen.getByTestId('launch-buy-balance').textContent).toContain('Balance: 0.1 ETH'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'MAX' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'MAX' }));
    expect(onMax).toHaveBeenCalledWith('0.09994');
  });

  it('a failed read says so (never a made-up 0) and Retry reads again', async () => {
    readContract.mockRejectedValueOnce(new Error('rpc down')).mockResolvedValueOnce(BigInt(1_000_000));
    render(<LaunchBuyBalance chain="robinhood" native={false} walletAddress={WALLET} amount="0" onMax={() => {}} />);
    await waitFor(() => expect(screen.getByText('Balance unavailable')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByTestId('launch-buy-balance').textContent).toContain('Balance: 1.00 USDG'));
  });

  it('renders nothing without a connected wallet', () => {
    const { container } = render(<LaunchBuyBalance chain="robinhood" native={false} walletAddress={null} amount="0" onMax={() => {}} />);
    expect(container.textContent).toBe('');
    expect(readContract).not.toHaveBeenCalled();
  });
});
