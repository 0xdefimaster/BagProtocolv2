// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

// Paying with native ETH in the purchase modal. Collaborators stubbed as in
// PurchasePreviewModal.balance.test.tsx; the API is a stubbed fetch.
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
const { PurchasePreviewModal, purchaseSignatureLabel } = await import('../PurchasePreviewModal');

const USDG = { id: 'usdg', chain: 'robinhood', address: ROBINHOOD_REWARD_TOKEN.address, symbol: 'USDG', decimals: 6, name: 'USDG' };
const ETH = { id: 'native:robinhood', chain: 'robinhood', address: '0x0000000000000000000000000000000000000000', symbol: 'ETH', decimals: 18, name: 'Ether' };
const ethPreview = {
  disclaimer: '',
  inputSymbol: 'ETH',
  inputAmountDisplay: '0.05',
  depositPlan: {
    allocations: [
      { targetSymbol: 'NVDA', targetWeightBps: 6000, valueRaw: '30000000000000000', action: 'SWAP' },
      { targetSymbol: 'AAPL', targetWeightBps: 4000, valueRaw: '20000000000000000', action: 'SWAP' },
    ],
    unallocatedRaw: '0',
  },
  depositQuote: { sharesRaw: '15000000000000000000', shareDecimals: 18, sharePrice: '10', isBootstrap: false },
  executionPlan: { steps: [] },
  navGross: '1000',
  navQuoteCurrency: 'USD',
  isBootstrap: false,
  quotes: null,
  quotesError: null,
  quoteAmount: '150.000000000000000000',
};
let posted: { inputAssetId: string; amount: string }[] = [];

beforeEach(() => {
  posted = [];
  readContract.mockReset().mockResolvedValue(BigInt(250_000_000));
  getBalance.mockReset().mockResolvedValue(BigInt(10) ** BigInt(18)); // 1 ETH
  getGasPrice.mockReset().mockResolvedValue(BigInt(100_000_000)); // 0.1 gwei
  start.mockReset();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') posted.push(JSON.parse(String(init.body)));
      return { ok: true, json: async () => (init?.method === 'POST' ? { preview: ethPreview } : { inputAssets: [USDG, ETH] }) };
    })
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('PurchasePreviewModal — native ETH', () => {
  it('lists ETH next to USDG; the default stays USDG', async () => {
    render(<PurchasePreviewModal bagId="b1" bagName="Test" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByRole('option', { name: 'ETH' })).toBeInTheDocument());
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('usdg');
  });

  it('preferNativeInput (launch buy in ETH) selects ETH; the ETH balance, the USD value and ETH allocations are shown', async () => {
    render(<PurchasePreviewModal bagId="b1" bagName="Test" initialAmount="0.05" preferNativeInput onClose={() => {}} />);
    await waitFor(() => expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('native:robinhood'));
    await waitFor(() => expect(screen.getByTestId('payment-balance').textContent).toContain('Balance: 1 ETH'));
    await waitFor(() => expect(screen.getByTestId('payment-usd-value').textContent).toBe('≈ $150.00 at the current ETH price'));
    expect(screen.getByText('0.03 ETH')).toBeInTheDocument();
    expect(screen.getByText('0.02 ETH')).toBeInTheDocument();
    expect(posted.some((b) => b.inputAssetId === 'native:robinhood' && b.amount === '0.05')).toBe(true);
  });
});

describe('purchaseSignatureLabel', () => {
  const steps = [{ targetSymbol: 'MSFT' }, { targetSymbol: 'NVDA' }, { targetSymbol: 'TSLA' }];

  it('a single-transaction (Composer) purchase names every asset and never counts "(1/3)"', () => {
    const label = purchaseSignatureLabel(steps, 0, true);
    expect(label).toBe('Confirm the purchase of MSFT, NVDA, TSLA in your wallet (one transaction for all assets)');
    expect(label).not.toMatch(/\(\d+\/\d+\)/);
    expect(purchaseSignatureLabel([{ targetSymbol: 'MSFT' }], 0, true)).toBe('Confirm the purchase of MSFT in your wallet');
  });

  it('the per-asset path (one transaction per swap) keeps counting', () => {
    expect(purchaseSignatureLabel(steps, 1, false)).toBe('Confirm swap to NVDA in your wallet (2/3)');
  });
});
