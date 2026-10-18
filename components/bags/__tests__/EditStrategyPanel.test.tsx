// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const WALLET = '0x' + '1'.repeat(40);
const sendTransaction = vi.fn(async () => '0x' + 'ab'.repeat(32));
vi.mock('@/lib/wallet-context', () => ({ useWallet: () => ({ isConnected: true, walletAddress: WALLET, connect: vi.fn() }) }));
vi.mock('@/lib/blockchain/lifi-wallet-client', () => ({ getBrowserWalletClientForChain: async () => ({ chain: { id: 46630 }, sendTransaction }) }));
vi.mock('@/lib/registry-assets-client', () => ({ fetchRegistryAssetsForChain: async () => [] }));

import { EditStrategyPanel } from '../EditStrategyPanel';
import type { Bag } from '@/types';

const A = '0x' + 'a'.repeat(40);
const B = '0x' + 'b'.repeat(40);
const bag = {
  id: 'bag1',
  name: 'Majors',
  version: 1,
  mutability: 'MUTABLE',
  chains: ['robinhood'],
  composition: [
    { symbol: 'AAA', weight: 60, weightBps: 6000, address: A },
    { symbol: 'BBB', weight: 40, weightBps: 4000, address: B },
  ],
} as unknown as Bag;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  sendTransaction.mockClear();
  localStorage.clear();
});

describe('EditStrategyPanel', () => {
  it('saves only when weights total 100% and something changed; sends composition, signs, confirms', async () => {
    const calls: { url: string; body: unknown }[] = [];
    global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url.endsWith('/versions/prepare')) return new Response(JSON.stringify({ transaction: { to: '0x' + 'f'.repeat(40), data: '0x01', chainId: 46630 }, wallet: WALLET }), { status: 200 });
      if (url.endsWith('/versions/confirm')) return new Response(JSON.stringify({ version: { version: 2 } }), { status: 200 });
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;
    const onSaved = vi.fn();
    render(<EditStrategyPanel bag={bag} onSaved={onSaved} />);
    fireEvent.click(screen.getByTestId('edit-strategy-open'));

    const save = screen.getByTestId('edit-strategy-save') as HTMLButtonElement;
    expect(save.disabled).toBe(true); // unchanged
    fireEvent.change(screen.getByLabelText('AAA weight in percent'), { target: { value: '50' } });
    expect(screen.getByTestId('edit-strategy-total').textContent).toContain('90');
    expect(save.disabled).toBe(true); // 90%
    fireEvent.change(screen.getByLabelText('BBB weight in percent'), { target: { value: '50' } });
    expect(save.disabled).toBe(false);
    expect(screen.getByTestId('edit-strategy-diff').textContent).toContain('AAA 60% → 50%');
    expect(save.textContent).toContain('Save as v2');

    fireEvent.click(save);
    await waitFor(() => expect(screen.getByTestId('edit-strategy-done').textContent).toContain('v2'));
    expect(calls.find((c) => c.url.endsWith('/prepare'))).toEqual({ url: '/api/bags/bag1/versions/prepare', body: { composition: [{ address: A, weightBps: 5000 }, { address: B, weightBps: 5000 }], reason: '' } });
    expect(sendTransaction).toHaveBeenCalledTimes(1);
    expect(calls.find((c) => c.url.endsWith('/confirm'))!.body).toMatchObject({ txHash: '0x' + 'ab'.repeat(32), composition: [{ address: A, weightBps: 5000 }, { address: B, weightBps: 5000 }] });
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('bag-version-pending:bag1')).toBeNull();
  });

  it('shows the server refusal and never prompts the wallet when prepare fails', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ error: 'WRONG_WALLET', code: 'WRONG_WALLET', expected: '0xdead' }), { status: 403 })) as unknown as typeof fetch;
    render(<EditStrategyPanel bag={bag} />);
    fireEvent.click(screen.getByTestId('edit-strategy-open'));
    fireEvent.click(screen.getByText('Equal weights'));
    // 50/50 differs from 60/40
    fireEvent.click(screen.getByTestId('edit-strategy-save'));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/Only the wallet that deployed this Bag can edit it \(0xdead\)/));
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it('chain ahead of the server: shows the real state and completes the update without a new signature', async () => {
    const calls: { url: string; method: string; body: unknown }[] = [];
    let recorded = 1;
    global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url.endsWith('/versions/status')) return new Response(JSON.stringify({ recordedVersion: recorded, chainVersion: 2, inSync: recorded === 2, pendingProposals: 1 }), { status: 200 });
      if (url.endsWith('/versions/recover')) {
        recorded = 2;
        return new Response(JSON.stringify({ recordedVersion: 2, chainVersion: 2, inSync: true, pendingProposals: 0, recovered: [{ version: 2 }] }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;
    const onSaved = vi.fn();
    render(<EditStrategyPanel bag={bag} onSaved={onSaved} />);
    await waitFor(() => expect(screen.getByTestId('version-sync').textContent).toMatch(/v2 is recorded on chain, but this page still shows v1/));
    fireEvent.click(screen.getByTestId('version-recover'));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(calls.find((c) => c.url.endsWith('/versions/recover'))).toMatchObject({ method: 'POST', body: {} });
    expect(sendTransaction).not.toHaveBeenCalled();
    expect(screen.queryByTestId('version-sync')).toBeNull();
  });

  it('recovery refused: the reason is shown and nothing is claimed', async () => {
    global.fetch = vi.fn(async (url: string) => {
      if (url.endsWith('/versions/status')) return new Response(JSON.stringify({ recordedVersion: 1, chainVersion: 2, inSync: false, pendingProposals: 0 }), { status: 200 });
      if (url.endsWith('/versions/recover')) return new Response(JSON.stringify({ error: 'NO_PROPOSAL', code: 'NO_PROPOSAL', version: 2, txHash: '0x' + 'cd'.repeat(32) }), { status: 409 });
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;
    render(<EditStrategyPanel bag={bag} />);
    await waitFor(() => screen.getByTestId('version-recover'));
    fireEvent.click(screen.getByTestId('version-recover'));
    await waitFor(() => expect(screen.getByTestId('version-sync').textContent).toMatch(/no saved change that matches it/));
    expect(screen.queryByTestId('edit-strategy-done')).toBeNull();
  });
});
