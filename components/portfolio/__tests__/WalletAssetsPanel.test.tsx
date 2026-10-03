// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const executeWalletSweep = vi.fn();
vi.mock('@/lib/blockchain/wallet-sweep-client', () => ({ executeWalletSweep: (...a: unknown[]) => executeWalletSweep(...a) }));

import { WalletAssetsPanel } from '../WalletAssetsPanel';

const WALLET = '0x49da000000000000000000000000000000fe46';
const holdings = {
  walletAddress: WALLET,
  chainId: 4663,
  nativeBalance: '0.02',
  outputToken: { address: '0xUSDG', symbol: 'USDG', decimals: 6 },
  tokens: [
    { address: '0xAAPL', symbol: 'AAPL', name: 'Apple', decimals: 18, assetType: 'stock', logoUrl: null, balanceRaw: '500000000000000000', balance: '0.5', priceUsd: '230.5', usdValue: '115.25', sellable: true },
    { address: '0xUSDG', symbol: 'USDG', name: 'Global Dollar', decimals: 6, assetType: 'crypto', logoUrl: null, balanceRaw: '2500000', balance: '2.5', priceUsd: '1', usdValue: '2.5', sellable: false },
    { address: '0xDOGE', symbol: 'DOGE', name: 'Doge', decimals: 8, assetType: 'crypto', logoUrl: null, balanceRaw: '1000000000', balance: '10', priceUsd: null, usdValue: null, sellable: true },
  ],
};
const quote = {
  transaction: { to: '0xVM', data: '0xabc', value: '0', chainId: 4663 },
  approvals: [],
  legs: [
    { address: '0xAAPL', symbol: 'AAPL', amountRaw: '500000000000000000', decimals: 18, expectedOutRaw: '115000000', minOutRaw: '113850000' },
    { address: '0xDOGE', symbol: 'DOGE', amountRaw: '1000000000', decimals: 8, expectedOutRaw: '1200000', minOutRaw: '1188000' },
  ],
  outputToken: holdings.outputToken,
  expectedOutRaw: '116200000',
  minOutRaw: '115038000',
  priceImpactBps: 42,
};

let fetchMock: ReturnType<typeof vi.fn>;
const ok = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as Response;

beforeEach(() => {
  executeWalletSweep.mockReset();
  fetchMock = vi.fn(async (url: string) => {
    if (url === '/api/wallet/holdings') return ok(holdings);
    if (url === '/api/wallet/sweep-quote') return ok(quote);
    throw new Error('unexpected ' + url);
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('WalletAssetsPanel', () => {
  it('lists wallet tokens; USDG is the receive token and cannot be selected', async () => {
    render(<WalletAssetsPanel walletAddress={WALLET} />);
    await screen.findByText('Apple');
    expect(screen.getByLabelText('Select AAPL')).toBeTruthy();
    expect(screen.queryByLabelText('Select USDG')).toBeNull();
    expect(screen.getByText('You receive this')).toBeTruthy();
  });

  it('sells several tokens at once: one quote request for all of them, then one signed transaction', async () => {
    executeWalletSweep.mockResolvedValue('0xhash');
    render(<WalletAssetsPanel walletAddress={WALLET} />);
    await screen.findByText('Apple');
    fireEvent.click(screen.getByLabelText('Select AAPL'));
    fireEvent.click(screen.getByLabelText('Select DOGE'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Sell selected \(2\)/ }));
    });

    const quoteCall = fetchMock.mock.calls.find((c) => c[0] === '/api/wallet/sweep-quote')!;
    expect(JSON.parse(String((quoteCall[1] as RequestInit).body))).toEqual({
      tokens: [
        { address: '0xAAPL', amountRaw: '500000000000000000' },
        { address: '0xDOGE', amountRaw: '1000000000' },
      ],
    });
    await screen.findByText(/You receive ≈/);
    expect(screen.getByText('116.2 USDG')).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Confirm sale' }));
    });
    expect(executeWalletSweep).toHaveBeenCalledTimes(1);
    expect(executeWalletSweep.mock.calls[0][0]).toBe(WALLET);
    expect(executeWalletSweep.mock.calls[0][1]).toMatchObject({ transaction: quote.transaction });
    await screen.findByText(/View transaction/);
  });

  it('a price-impact refusal asks for consent and re-quotes with the accepted impact', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/wallet/holdings') return ok(holdings);
      const body = JSON.parse(String(init?.body));
      if (body.acceptedPriceImpactBps === undefined) {
        return ok({ error: 'impact', composerFallback: { reason: 'PRICE_IMPACT', message: 'Price impact 820 bps exceeds maximum 500 bps', priceImpactBps: 820, maxPriceImpactBps: 500, inputUsd: null, outputUsd: null } }, 422);
      }
      return ok(quote);
    });
    render(<WalletAssetsPanel walletAddress={WALLET} />);
    await screen.findByText('Apple');
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'Sell' })[0]);
    });
    await screen.findByText('High price impact');
    const cont = screen.getByRole('button', { name: 'Continue anyway' }) as HTMLButtonElement;
    expect(cont.disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: /I accept a 8.20% price impact/ }));
    await act(async () => {
      fireEvent.click(cont);
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Confirm sale' })).toBeTruthy());
    const last = fetchMock.mock.calls.filter((c) => c[0] === '/api/wallet/sweep-quote').pop()!;
    expect(JSON.parse(String((last[1] as RequestInit).body))).toMatchObject({ tokens: [{ address: '0xAAPL' }], acceptedPriceImpactBps: 820 });
  });
});
