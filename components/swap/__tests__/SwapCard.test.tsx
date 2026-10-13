// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';

const executeWalletSweep = vi.fn();
vi.mock('@/lib/blockchain/wallet-sweep-client', () => ({ executeWalletSweep: (...a: unknown[]) => executeWalletSweep(...a) }));

import { SwapCard, equalShares } from '../SwapCard';

const WALLET = '0x49da000000000000000000000000000000fe46';
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const AAPL = '0x00000000000000000000000000000000000000a1';
const NVDA = '0x00000000000000000000000000000000000000b2';
const assets = [
  { address: AAPL, symbol: 'AAPL', name: 'Apple', decimals: 18 },
  { address: NVDA, symbol: 'NVDA', name: 'Nvidia', decimals: 18 },
  { address: USDG, symbol: 'USDG', name: 'Global Dollar', decimals: 6 },
];
const tok = (address: string, symbol: string, balanceRaw: string, balance: string, usdValue: string, sellable = true, decimals = 18) => ({
  address, symbol, name: symbol, decimals, assetType: 'crypto', logoUrl: null, balanceRaw, balance, priceUsd: '1', usdValue, sellable,
});
const holdings = {
  chains: [
    {
      walletAddress: WALLET,
      chain: 'robinhood',
      chainId: 4663,
      nativeBalance: '0.05',
      outputToken: { address: USDG, symbol: 'USDG', decimals: 6 },
      tokens: [tok(AAPL, 'AAPL', '500000000000000000', '0.5', '115.25'), tok(NVDA, 'NVDA', '10000000000000000', '0.01', '2.24'), tok(USDG, 'USDG', '2500000', '2.5', '2.5', false, 6)],
    },
    { chain: 'base', chainId: 8453, error: 'rpc down' },
  ],
};
const buyQuote = {
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
const sellQuote = {
  transaction: { to: '0xVM', data: '0xdef', value: '0', chainId: 4663 },
  approvals: [{ token: AAPL, spender: '0xVM', amountRaw: '500000000000000000' }],
  legs: [{ address: AAPL, symbol: 'AAPL', amountRaw: '500000000000000000', decimals: 18, expectedOutRaw: '115000000', minOutRaw: '113850000' }],
  outputToken: { address: USDG, symbol: 'USDG', decimals: 6 },
  expectedOutRaw: '115000000',
  minOutRaw: '113850000',
  priceImpactBps: 20,
};

let fetchMock: ReturnType<typeof vi.fn>;
const ok = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as Response;
const bodyOf = (url: string) => JSON.parse(String((fetchMock.mock.calls.find((c) => c[0] === url)![1] as RequestInit).body));

beforeEach(() => {
  executeWalletSweep.mockReset();
  fetchMock = vi.fn(async (url: string) => {
    if (url.startsWith('/api/assets?chain=')) return ok({ assets });
    if (url === '/api/wallet/holdings?chain=all') return ok(holdings);
    if (url === '/api/wallet/buy-quote') return ok(buyQuote);
    if (url === '/api/wallet/sweep-quote') return ok(sellQuote);
    throw new Error('unexpected ' + url);
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function pick(...symbols: string[]) {
  fireEvent.click(screen.getAllByRole('button', { name: /Add token/ })[0]);
  const dialog = await screen.findByRole('dialog');
  for (const s of symbols) fireEvent.click(await within(dialog).findByRole('button', { name: `Add ${s}` }));
  fireEvent.click(within(dialog).getByRole('button', { name: /^Done/ }));
}

describe('equalShares', () => {
  it('splits 10000 bps exactly, remainder to the first tokens', () => {
    expect(equalShares(1)).toEqual([10000]);
    expect(equalShares(3)).toEqual([3334, 3333, 3333]);
    expect(equalShares(7).reduce((a, b) => a + b, 0)).toBe(10000);
  });
});

describe('SwapCard — Multi-buy', () => {
  it('one ETH payment → two tokens: equal shares, wei amount, no approval, expected outputs shown, then one signed transaction', async () => {
    executeWalletSweep.mockResolvedValue('0xhash');
    render(<SwapCard walletAddress={WALLET} />);
    expect(screen.getByRole('tab', { name: 'Multi-buy' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText(/Works best with MetaMask/)).toBeTruthy();
    await screen.findByText(/Balance 0.05 ETH/);
    await pick('AAPL', 'NVDA');
    expect(screen.getAllByText('50.00% of the spend')).toHaveLength(2);
    fireEvent.change(screen.getByLabelText('Amount in ETH'), { target: { value: '0.01' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Buy 2 tokens with ETH' }));
    });
    expect(bodyOf('/api/wallet/buy-quote')).toEqual({
      chain: 'robinhood',
      pay: 'NATIVE',
      amountRaw: '10000000000000000',
      buys: [
        { address: AAPL, weightBps: 5000 },
        { address: NVDA, weightBps: 5000 },
      ],
    });
    expect(await screen.findByText('≈ 0.1')).toBeTruthy();
    expect(screen.getByText('No approval needed: one signature.')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Confirm swap' }));
    });
    expect(executeWalletSweep).toHaveBeenCalledTimes(1);
    expect(executeWalletSweep.mock.calls[0][1]).toMatchObject({ transaction: buyQuote.transaction, approvals: [] });
    await screen.findByText(/View transaction/);
  });

  it('paying with the stablecoin removes it from the tokens to buy; the button needs both an amount and a token', async () => {
    render(<SwapCard walletAddress={WALLET} />);
    const cta = () => screen.getByRole('button', { name: /^Buy .*with (ETH|USDG)$/ }) as HTMLButtonElement;
    expect(cta().disabled).toBe(true);
    await pick('USDG', 'AAPL');
    fireEvent.change(screen.getByLabelText('Amount in ETH'), { target: { value: '1e5' } });
    expect(cta().disabled).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: 'USDG' }));
    expect(screen.queryByRole('button', { name: 'Remove USDG' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Amount in USDG'), { target: { value: '5' } });
    expect(cta().disabled).toBe(false);
    expect(cta().textContent).toBe('Buy 1 token with USDG');
  });
});

describe('SwapCard — Multi-sell', () => {
  it('several wallet tokens → USDG: whole balances sent, total shown, one approval noted with MetaMask batching', async () => {
    render(<SwapCard walletAddress={WALLET} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Multi-sell' }));
    expect(screen.getByRole('radio', { name: 'USDG' }).getAttribute('aria-checked')).toBe('true');
    await pick('AAPL', 'NVDA');
    expect(screen.getByText('≈ $117.49')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sell 2 tokens for USDG' }));
    });
    expect(bodyOf('/api/wallet/sweep-quote')).toEqual({
      chain: 'robinhood',
      receive: 'STABLE',
      tokens: [
        { address: AAPL, amountRaw: '500000000000000000' },
        { address: NVDA, amountRaw: '10000000000000000' },
      ],
    });
    expect(await screen.findByText('115')).toBeTruthy();
    expect(screen.getByText(/1 exact-amount approval \+ the swap — one confirmation in MetaMask/)).toBeTruthy();
  });

  it('receiving ETH makes the stablecoin itself sellable; a chain that cannot be read offers nothing to sell', async () => {
    render(<SwapCard walletAddress={WALLET} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Multi-sell' }));
    fireEvent.click(screen.getByRole('radio', { name: 'ETH' }));
    await pick('USDG');
    expect(screen.getByRole('button', { name: 'Sell 1 token for ETH' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Network'), { target: { value: 'base' } });
    fireEvent.click(screen.getAllByRole('button', { name: /Add token/ })[0]);
    expect(await screen.findByText(/No sellable tokens in your wallet on Base/)).toBeTruthy();
  });
});
