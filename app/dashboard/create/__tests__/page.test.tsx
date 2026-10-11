// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

// -----------------------------------------------------------------------------
// Production-hardening P0-1/P0-2 — regression tests for the Create Bag
// flow's single-chain network model and registry-only asset selection.
// Every non-network dependency (router, local bag/activity/notification
// stores, wallet context) is mocked; `fetch` is stubbed to serve
// `GET /api/assets?chain=...` so the test proves the REAL component wiring
// (NetworkSelector -> asset refetch -> selection-clearing -> Review step),
// not a reimplementation of it.
// -----------------------------------------------------------------------------

const pushMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}));

const addBagMock = vi.fn();
vi.mock('@/lib/user-bags-store', () => ({
  useUserBags: () => ({ userBags: [], addBag: addBagMock }),
}));

vi.mock('@/lib/activity-store', () => ({
  useActivity: () => ({ activity: [], addActivity: vi.fn() }),
}));

vi.mock('@/lib/notifications-store', () => ({
  useNotifications: () => ({ addNotification: vi.fn() }),
}));

vi.mock('@/lib/wallet-context', () => ({
  useWallet: () => ({ walletAddress: '0x000000000000000000000000000000000000aa', isConnected: true }),
}));

const { default: CreatePage } = await import('../page');

/** One VERIFIED registry asset per chain, keyed by the `?chain=` query param the component's fetch sends — models a real GET /api/assets response for that one chain. */
function registryAssetsFixture(): Record<string, unknown[]> {
  return {
    robinhood: [
      { id: 'robinhood:0xusdc', symbol: 'USDC', name: 'USD Coin', type: 'crypto', chain: 'robinhood', address: '0xusdc', decimals: 6 },
      { id: 'robinhood:0xweth', symbol: 'WETH', name: 'Wrapped Ether', type: 'crypto', chain: 'robinhood', address: '0xweth', decimals: 18 },
    ],
    ethereum: [],
    base: [
      { id: 'base:0xnvda', symbol: 'xNVDA', name: 'NVIDIA (Base)', type: 'stock', chain: 'base', address: '0xnvda', decimals: 18 },
    ],
    arbitrum: [],
  };
}

let deployable = ['robinhood', 'ethereum', 'base', 'arbitrum'];

function stubFetchForRegistry() {
  const byChain = registryAssetsFixture();
  const fetchMock = vi.fn(async (url: string) => {
    if (url.startsWith('/api/deploy/chains')) return { ok: true, json: async () => ({ deployable }) } as Response;
    const match = /[?&]chain=([^&]+)/.exec(url);
    const chain = match ? decodeURIComponent(match[1]) : 'robinhood';
    return {
      ok: true,
      json: async () => ({ assets: byChain[chain] ?? [] }),
    } as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function goToAssetsStep() {
  fireEvent.change(screen.getByPlaceholderText(/e\.g\., ai leaders/i), { target: { value: 'My Bag' } });
  fireEvent.click(screen.getByRole('button', { name: /next: select assets/i }));
  await waitFor(() => expect(screen.getByText(/available assets/i)).toBeInTheDocument());
}

beforeEach(() => {
  deployable = ['robinhood', 'ethereum', 'base', 'arbitrum'];
  stubFetchForRegistry();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Create Bag — single-chain network model', () => {
  it('1. NetworkSelector is a true single-select — choosing a network deselects whatever was chosen before', async () => {
    render(<CreatePage />);

    const robinhoodRadio = screen.getByRole('radio', { name: /robinhood/i });
    const baseRadio = screen.getByRole('radio', { name: /base/i });

    expect(robinhoodRadio).toHaveAttribute('aria-checked', 'true');
    expect(baseRadio).toHaveAttribute('aria-checked', 'false');
    await waitFor(() => expect(baseRadio).not.toBeDisabled());

    fireEvent.click(baseRadio);

    expect(baseRadio).toHaveAttribute('aria-checked', 'true');
    expect(robinhoodRadio).toHaveAttribute('aria-checked', 'false');
  });

  it('2. changing the network clears selected assets, and 3. clears allocations along with them', async () => {
    render(<CreatePage />);
    await goToAssetsStep();

    // Select USDC (a real Robinhood-registry asset from the fixture).
    fireEvent.click(screen.getByText('USDC'));
    await waitFor(() => expect(screen.getByText(/selected \(1\)/i)).toBeInTheDocument());

    // Go back to Basic Info and switch the network — assets/allocations for
    // the PREVIOUS chain must not silently carry over to the new one.
    fireEvent.click(screen.getByRole('button', { name: /^bag info$/i }));
    await waitFor(() => expect(screen.getByRole('radio', { name: /base/i })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('radio', { name: /base/i }));

    // Explicit notice, not a silent clear.
    expect(screen.getByText(/network changed\. your asset selections were cleared\./i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^select assets$/i }));
    await waitFor(() => expect(screen.queryByText(/selected \(1\)/i)).not.toBeInTheDocument());
    // The "Allocate" step is disabled again with nothing selected — the
    // allocation for the cleared USDC selection did not survive either.
    expect(screen.getByRole('button', { name: /^allocate$/i })).toBeDisabled();
  });

  it('4. Review shows exactly one Network row/value, never a plural "Networks" list', async () => {
    const { container } = render(<CreatePage />);
    await goToAssetsStep();

    fireEvent.click(screen.getByText('USDC'));
    fireEvent.click(screen.getByRole('button', { name: /next: allocate/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /^allocate$/i })).not.toBeDisabled());

    // Two buttons legitimately read "Review": the step-nav tab and the
    // allocation step's own submit button — disambiguate by DOM order
    // (the step-nav renders first) rather than by text alone.
    const reviewButtons = screen.getAllByRole('button', { name: /^review$/i });
    fireEvent.click(reviewButtons[reviewButtons.length - 1]);

    await waitFor(() => expect(screen.getAllByText('Network').length).toBeGreaterThan(0));
    expect(screen.queryByText('Networks')).not.toBeInTheDocument();

    // Exactly one chain tag rendered anywhere in the review card — never a
    // list of several (the old `chains: [...]` behavior).
    const chainTags = Array.from(container.querySelectorAll('.bag-chain-tag')).filter((el) =>
      /ethereum|base|arbitrum|robinhood chain/i.test(el.textContent ?? '')
    );
    expect(chainTags).toHaveLength(1);
    expect(chainTags[0].textContent).toMatch(/robinhood/i);
  });

  it('opens on Robinhood Chain; a network without a configured BagFactory is shown as coming soon and cannot be picked', async () => {
    deployable = ['robinhood'];
    render(<CreatePage />);
    expect(screen.getByRole('radio', { name: /robinhood/i })).toHaveAttribute('aria-checked', 'true');
    for (const name of [/ethereum/i, /base/i, /arbitrum/i]) {
      const radio = screen.getByRole('radio', { name });
      expect(radio).toBeDisabled();
      expect(radio).toHaveTextContent(/soon/i);
    }
  });

  it('registry-only asset pool: BTC (never a real deployment on any supported chain) is never selectable, and an empty registry shows the explicit empty state, not mock assets', async () => {
    render(<CreatePage />);
    await goToAssetsStep();

    expect(screen.queryByText('BTC')).not.toBeInTheDocument();
    expect(screen.getByText('USDC')).toBeInTheDocument();

    // Switch to Arbitrum, which the fixture registry has nothing for.
    fireEvent.click(screen.getByRole('button', { name: /^bag info$/i }));
    await waitFor(() => expect(screen.getByRole('radio', { name: /arbitrum/i })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('radio', { name: /arbitrum/i }));
    fireEvent.click(screen.getByRole('button', { name: /^select assets$/i }));

    await waitFor(() =>
      expect(screen.getByText(/no verified assets are currently available on this network/i)).toBeInTheDocument()
    );
    expect(screen.queryByText('BTC')).not.toBeInTheDocument();
    expect(screen.queryByText('USDC')).not.toBeInTheDocument();
  });
});
