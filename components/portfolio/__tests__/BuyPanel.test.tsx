// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

const executeWalletSweep = vi.fn();
vi.mock('@/lib/blockchain/wallet-sweep-client', () => ({ executeWalletSweep: (...a: unknown[]) => executeWalletSweep(...a) }));

import { BuyPanel, equalShares } from '../BuyPanel';

const WALLET = '0x49da000000000000000000000000000000fe46';
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const AAPL = '0x00000000000000000000000000000000000000a1';
const NVDA = '0x00000000000000000000000000000000000000b2';
const assets = [
  { address: AAPL, symbol: 'AAPL', name: 'Apple', decimals: 18 },
  { address: NVDA, symbol: 'NVDA', name: 'Nvidia', decimals: 18 },
  { address: USDG, symbol: 'USDG', name: 'Global Dollar', decimals: 6 },
];
const quote = {
  transaction: { to: '0xVM', data: '0xabc', value: '10000000000000000', chainId: 4663 },
  approvals: [],
  payToken: { address: '0x0000000000000000000000000000000000000000', symbol: 'ETH', decimals: 18, native: true },
  amountRaw: '10000000000000000',
  legs: [
    { address: AAPL, symbol: 'AAPL', decimals: 18, weightBps: 5000, expectedOutRaw: '100000000000000000', minOutRaw: '99000000000000000' },
    { address: NVDA, symbol: 'NVDA', decimals: 18, weightBps: 5000, expectedOutRaw: '50000000000000000', minOutRaw: '49500000000000000' },
  ],
  priceImpactBps: 10,
};

let fetchMock: ReturnType<typeof vi.fn>;
const ok = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as Response;

beforeEach(() => {
  executeWalletSweep.mockReset();
  fetchMock = vi.fn(async (url: string) => {
    if (url.startsWith('/api/assets?chain=')) return ok({ assets });
    if (url === '/api/wallet/buy-quote') return ok(quote);
    throw new Error('unexpected ' + url);
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('equalShares', () => {
  it('splits 10000 bps exactly, remainder to the first tokens', () => {
    expect(equalShares(1)).toEqual([10000]);
    expect(equalShares(3)).toEqual([3334, 3333, 3333]);
    expect(equalShares(7).reduce((a, b) => a + b, 0)).toBe(10000);
  });
});

describe('BuyPanel', () => {
  it('buys two tokens with ETH in one transaction: equal shares, amount in wei, no approval, then one signed transaction', async () => {
    executeWalletSweep.mockResolvedValue('0xhash');
    render(<BuyPanel walletAddress={WALLET} />);
    await screen.findByText('Apple');
    expect(screen.getByText('No approval — one signature.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/You spend \(ETH\)/), { target: { value: '0.01' } });
    fireEvent.click(screen.getByLabelText('Buy AAPL'));
    fireEvent.click(screen.getByLabelText('Buy NVDA'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Buy 2 tokens with ETH' }));
    });
    const call = fetchMock.mock.calls.find((c) => c[0] === '/api/wallet/buy-quote')!;
    expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({
      chain: 'robinhood',
      pay: 'NATIVE',
      amountRaw: '10000000000000000',
      buys: [
        { address: AAPL, weightBps: 5000 },
        { address: NVDA, weightBps: 5000 },
      ],
    });
    await screen.findByText(/No approval needed: one signature/);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Confirm purchase' }));
    });
    expect(executeWalletSweep).toHaveBeenCalledTimes(1);
    expect(executeWalletSweep.mock.calls[0][1]).toMatchObject({ transaction: quote.transaction, approvals: [] });
    await screen.findByText(/View transaction/);
  });

  it('paying with the stablecoin: the stablecoin is not offered as a token to buy', async () => {
    render(<BuyPanel walletAddress={WALLET} />);
    await screen.findByText('Apple');
    expect(screen.getByLabelText('Buy USDG')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'USDG' }));
    expect(screen.queryByLabelText('Buy USDG')).toBeNull();
    expect(screen.getByLabelText(/You spend \(USDG\)/)).toBeTruthy();
  });

  it('the buy button stays disabled without an amount or a token; an invalid amount is not sent', async () => {
    render(<BuyPanel walletAddress={WALLET} />);
    await screen.findByText('Apple');
    const button = () => screen.getByRole('button', { name: /^Buy .*with ETH$/ }) as HTMLButtonElement;
    expect(button().disabled).toBe(true);
    fireEvent.click(screen.getByLabelText('Buy AAPL'));
    fireEvent.change(screen.getByLabelText(/You spend/), { target: { value: '1e5' } });
    expect(button().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/You spend/), { target: { value: '0,5' } });
    expect(button().disabled).toBe(false);
  });
});
