// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));
vi.mock('@/lib/wallet-context', () => ({ useWallet: () => ({ isConnected: true, walletAddress: '0xwallet', connect: vi.fn(), signIn: vi.fn() }) }));
const balanceProps = vi.fn();
vi.mock('@/components/create/LaunchBuyBalance', () => ({
  LaunchBuyBalance: (p: { native: boolean; walletAddress: string | null; amount: string }) => {
    balanceProps(p);
    return <div data-testid="launch-buy-balance">{p.native ? 'ETH balance' : 'USDG balance'}</div>;
  },
}));
vi.mock('@/lib/activity-store', () => ({ useActivity: () => ({ addActivity: vi.fn() }) }));
vi.mock('@/lib/registry-assets-client', () => ({ fetchRegistryAssetsForChain: async () => [] }));

import { ForkPanel } from '../ForkPanel';
import type { Bag } from '@/types';

const A = '0x' + 'a'.repeat(40);
const B = '0x' + 'b'.repeat(40);
const bag = {
  id: 'src',
  name: 'Majors',
  chains: ['robinhood'],
  composition: [
    { symbol: 'AAA', weight: 60, weightBps: 6000, address: A },
    { symbol: 'BBB', weight: 40, weightBps: 4000, address: B },
  ],
} as unknown as Bag;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  push.mockReset();
});

function serve(onFork: (body: Record<string, unknown>) => Response) {
  const forkBodies: Record<string, unknown>[] = [];
  global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith('/api/bags/name-available')) return new Response(JSON.stringify({ available: true }), { status: 200 });
    if (url.endsWith('/fork')) {
      const body = JSON.parse(String(init?.body ?? '{}'));
      forkBodies.push(body);
      return onFork(body);
    }
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
  return forkBodies;
}

describe('ForkPanel', () => {
  it('the fork gets the chosen name and weights before it exists, then opens the new draft', async () => {
    const bodies = serve(() => new Response(JSON.stringify({ bag: { id: 'new1' } }), { status: 201 }));
    render(<ForkPanel bag={bag} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Fork name'), { target: { value: 'My Majors' } });
    fireEvent.change(screen.getByLabelText('AAA weight in percent'), { target: { value: '30' } });
    expect((screen.getByTestId('fork-create') as HTMLButtonElement).disabled).toBe(true); // 70%
    fireEvent.change(screen.getByLabelText('BBB weight in percent'), { target: { value: '70' } });
    fireEvent.click(screen.getByTestId('fork-create'));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/dashboard/bag/new1?deploy=1'));
    expect(bodies[0]).toEqual({ name: 'My Majors', composition: [{ address: A, weightBps: 3000 }, { address: B, weightBps: 7000 }] });
  });

  it('unchanged weights: a plain copy (no composition sent)', async () => {
    const bodies = serve(() => new Response(JSON.stringify({ bag: { id: 'new2' } }), { status: 201 }));
    render(<ForkPanel bag={bag} onClose={() => {}} />);
    fireEvent.click(screen.getByTestId('fork-create'));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/dashboard/bag/new2?deploy=1'));
    expect(bodies[0]).toEqual({ name: 'Majors (Fork)' });
  });

  it('a launch buy goes along: the new page deploys, registers and then buys that amount', async () => {
    serve(() => new Response(JSON.stringify({ bag: { id: 'new3' } }), { status: 201 }));
    render(<ForkPanel bag={bag} onClose={() => {}} />);
    fireEvent.click(screen.getByTestId('fork-buy-after'));
    fireEvent.change(screen.getByTestId('fork-buy-amount'), { target: { value: 'abc' } });
    expect((screen.getByTestId('fork-create') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId('fork-buy-amount'), { target: { value: '25' } });
    expect(screen.getByTestId('fork-create').textContent).toBe('Create, deploy & buy');
    fireEvent.click(screen.getByTestId('fork-create'));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/dashboard/bag/new3?deploy=1&buy=25'));
  });

  it('a refusal (e.g. an asset that failed validation) is shown and nothing opens', async () => {
    serve(() => new Response(JSON.stringify({ error: 'Forked recipe failed validation.', issues: [{ severity: 'ERROR', message: '"BBB" weight exceeds the maximum.' }] }), { status: 422 }));
    render(<ForkPanel bag={bag} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('AAA weight in percent'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('BBB weight in percent'), { target: { value: '90' } });
    fireEvent.click(screen.getByTestId('fork-create'));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/weight exceeds the maximum/));
    expect(push).not.toHaveBeenCalled();
  });

  it('the launch buy can be paid in USDG or ETH, with the wallet balance of that one shown; ETH goes along as pay=native', async () => {
    serve(() => new Response(JSON.stringify({ bag: { id: 'new4' } }), { status: 201 }));
    render(<ForkPanel bag={bag} onClose={() => {}} />);
    fireEvent.click(screen.getByTestId('fork-buy-after'));
    expect(screen.getByTestId('fork-pay-settlement').textContent).toBe('USDG');
    expect(screen.getByTestId('launch-buy-balance').textContent).toBe('USDG balance');
    expect(balanceProps).toHaveBeenLastCalledWith(expect.objectContaining({ native: false, walletAddress: '0xwallet', amount: '50' }));
    fireEvent.click(screen.getByTestId('fork-pay-native'));
    expect(screen.getByTestId('launch-buy-balance').textContent).toBe('ETH balance');
    expect(screen.getByLabelText('Launch buy in ETH')).toHaveValue('0.01');
    fireEvent.click(screen.getByTestId('fork-create'));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/dashboard/bag/new4?deploy=1&buy=0.01&pay=native'));
  });
});
