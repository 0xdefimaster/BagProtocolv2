// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';

vi.mock('@/lib/wallet-context', () => ({ useWallet: () => ({ isConnected: true, walletAddress: '0x' + '1'.repeat(40), connect: vi.fn() }) }));
vi.mock('@/lib/registry-assets-client', () => ({ fetchRegistryAssetsForChain: async () => [] }));
vi.mock('@/components/create/AssetSelector', () => ({ AssetSelector: () => <div data-testid="asset-selector" /> }));

import { EditStrategyPanel } from '../EditStrategyPanel';
import type { Bag } from '@/types';

const bag = {
  id: 'bag1',
  name: 'Majors',
  version: 1,
  mutability: 'MUTABLE',
  chains: ['robinhood'],
  composition: [
    { symbol: 'AAA', weight: 60, weightBps: 6000, address: '0x' + 'a'.repeat(40) },
    { symbol: 'BBB', weight: 40, weightBps: 4000, address: '0x' + 'b'.repeat(40) },
  ],
} as unknown as Bag;

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function Page() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Edit strategy</button>
      <EditStrategyPanel bag={bag} open={open} onOpenChange={setOpen} hideTrigger />
    </>
  );
}

describe('EditStrategyPanel opened from the page header', () => {
  it('shows no trigger of its own; the page button opens it and its close button closes it', async () => {
    global.fetch = vi.fn(async () => new Response('{}', { status: 404 })) as unknown as typeof fetch;
    render(<Page />);
    expect(screen.queryByTestId('edit-strategy-open')).toBeNull();
    expect(screen.queryByTestId('edit-strategy-panel')).toBeNull();
    fireEvent.click(screen.getByText('Edit strategy'));
    expect(await screen.findByTestId('edit-strategy-panel')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Close'));
    expect(screen.queryByTestId('edit-strategy-panel')).toBeNull();
  });

  it('"Add or remove assets" is a button that shows and hides the asset picker', async () => {
    global.fetch = vi.fn(async () => new Response('{}', { status: 404 })) as unknown as typeof fetch;
    render(<Page />);
    fireEvent.click(screen.getByText('Edit strategy'));
    const toggle = await screen.findByTestId('composition-add-remove');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('asset-selector')).toBeNull();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('asset-selector')).toBeInTheDocument();
  });
});
