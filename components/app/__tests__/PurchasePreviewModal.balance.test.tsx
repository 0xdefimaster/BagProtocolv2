// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

// The modal runs for real; its collaborators (wallet, execution, route
// options, prefetch) are stubbed, the API is a stubbed fetch, and the chain
// is a stubbed viem public client.
const readContract = vi.fn();
const getBalance = vi.fn();
const getGasPrice = vi.fn();
vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return { ...actual, createPublicClient: () => ({ readContract, getBalance, getGasPrice }) };
});

const WALLET = '0x' + '5'.repeat(40);
vi.mock('@/lib/wallet-context', () => ({
  useWallet: () => ({ hasProvider: true, isConnected: true, walletAddress: WALLET, authUser: { id: 'u1' }, connect: vi.fn(), signIn: vi.fn(), error: null, authError: null }),
}));
const start = vi.fn();
vi.mock('@/hooks/use-purchase-execution', () => ({
  usePurchaseExecution: () => ({ state: { phase: 'idle', intent: null }, start, confirmPriceImpact: vi.fn(), reset: vi.fn() }),
}));
vi.mock('@/hooks/use-purchase-prefetch', () => ({ usePurchasePrefetch: () => ({ take: () => undefined }), purchasePrefetchKey: () => 'k' }));
vi.mock('@/hooks/use-purchase-options', () => ({
  usePurchaseOptions: () => ({ options: null, isStale: false, refresh: vi.fn() }),
  resolveSelectedProviderId: () => null,
}));

const { ROBINHOOD_REWARD_TOKEN } = await import('@/lib/config/robinhood-chain');
const { PurchasePreviewModal } = await import('../PurchasePreviewModal');

const USDG = { id: 'usdg', chain: 'robinhood', address: ROBINHOOD_REWARD_TOKEN.address, symbol: 'USDG', decimals: ROBINHOOD_REWARD_TOKEN.decimals, name: 'USDG' };
const preview = {
  disclaimer: '',
  inputSymbol: 'USDG',
  inputAmountDisplay: '',
  depositPlan: { allocations: [], unallocatedRaw: '0' },
  depositQuote: null,
  executionPlan: { steps: [] },
  navGross: null,
  navQuoteCurrency: null,
  isBootstrap: true,
  quotes: null,
  quotesError: null,
};

beforeEach(() => {
  readContract.mockReset();
  getBalance.mockReset();
  getGasPrice.mockReset();
  start.mockReset();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => ({
      ok: true,
      json: async () => (init?.method === 'POST' ? { preview } : { inputAssets: [USDG] }),
    }))
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const purchaseButton = () => screen.getAllByRole('button').find((b) => /Purchase|Insufficient/.test(b.textContent ?? ''))!;

describe('PurchasePreviewModal — payment balance', () => {
  it('shows the balance; an amount above it disables Purchase with "Insufficient USDG balance"', async () => {
    readContract.mockResolvedValue(BigInt(250_000_000)); // 250 USDG
    getBalance.mockResolvedValue(BigInt(10) ** BigInt(16)); // some ETH for fees
    render(<PurchasePreviewModal bagId="b1" bagName="Test" initialAmount="300" onClose={() => {}} />);

    await waitFor(() => expect(screen.getByTestId('payment-balance').textContent).toContain('Balance: 250.00 USDG'));
    await waitFor(() => expect(purchaseButton().textContent).toBe('Insufficient USDG balance'));
    expect(purchaseButton()).toBeDisabled();

    // MAX writes the exact usable amount (the whole ERC-20 balance) and unblocks.
    fireEvent.click(screen.getByRole('button', { name: 'MAX' }));
    expect((screen.getByPlaceholderText('Enter amount') as HTMLInputElement).value).toBe('250');
    await waitFor(() => expect(purchaseButton().textContent).toBe('Purchase'));
    await waitFor(() => expect(purchaseButton()).not.toBeDisabled());
  });

  it('an unreadable balance never blocks the purchase; it offers Retry and turns MAX off', async () => {
    readContract.mockRejectedValue(new Error('rpc down'));
    getBalance.mockResolvedValue(BigInt(1));
    render(<PurchasePreviewModal bagId="b1" bagName="Test" initialAmount="300" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('payment-balance').textContent).toContain('Balance unavailable'));
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'MAX' })).toBeNull();
    await waitFor(() => expect(purchaseButton()).not.toBeDisabled());
    expect(purchaseButton().textContent).toBe('Purchase');
  });

  it('paying with an ERC-20 and no native ETH: warns about network fees without blocking', async () => {
    readContract.mockResolvedValue(BigInt(250_000_000));
    getBalance.mockResolvedValue(BigInt(0));
    render(<PurchasePreviewModal bagId="b1" bagName="Test" initialAmount="10" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('You need some ETH on Robinhood Chain for network fees.')).toBeInTheDocument());
    await waitFor(() => expect(purchaseButton()).not.toBeDisabled());
  });

  it('autoStart does not start a launch buy the balance cannot cover', async () => {
    readContract.mockResolvedValue(BigInt(1_000_000)); // 1 USDG
    getBalance.mockResolvedValue(BigInt(10) ** BigInt(16));
    render(<PurchasePreviewModal bagId="b1" bagName="Test" initialAmount="300" autoStart onClose={() => {}} />);
    await waitFor(() => expect(purchaseButton().textContent).toBe('Insufficient USDG balance'));
    expect(start).not.toHaveBeenCalled();
  });
});
