// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

const WALLET = '0x' + '1'.repeat(40);
vi.mock('@/lib/wallet-context', () => ({ useWallet: () => ({ isConnected: true, walletAddress: WALLET, connect: vi.fn() }) }));
let deployPhase = 'completed';
vi.mock('@/hooks/use-deploy-bag', () => ({
  useDeployBag: () => ({
    state: { phase: deployPhase, error: null, pending: false, deployment: { txHash: '0x1', contractAddress: '0xC', onChainBagId: '0x2' }, bagStatus: 'ACTIVE' },
    deploy: vi.fn(),
    resumePending: vi.fn(async () => false),
    cancel: vi.fn(),
  }),
}));
const register = vi.fn();
vi.mock('@/hooks/use-strategy-registration', () => ({ useStrategyRegistration: () => ({ phase: 'idle', error: null, step: null, register }) }));

import { DeployBagPanel } from '../DeployBagPanel';

afterEach(() => {
  cleanup();
  register.mockReset();
  global.fetch = vi.fn(async () => new Response('{}', { status: 404 })) as unknown as typeof fetch;
});

describe('DeployBagPanel: deploy → registry → buy', () => {
  it('registers v1 right after the deployment, then hands over to the buy', async () => {
    global.fetch = vi.fn(async () => new Response('{}', { status: 404 })) as unknown as typeof fetch;
    const order: string[] = [];
    register.mockImplementation(async () => {
      order.push('register');
      return 'completed';
    });
    const onDeployed = vi.fn(() => order.push('buy'));
    render(<DeployBagPanel bagId="b1" bagName="Majors" chain="robinhood" presetLaunchBuy="25" onDeployed={onDeployed} />);
    await waitFor(() => expect(onDeployed).toHaveBeenCalledTimes(1));
    expect(register).toHaveBeenCalledWith(WALLET);
    expect(order).toEqual(['register', 'buy']);
    expect(screen.getByTestId('deploy-registration-step').textContent).toMatch(/Registered on-chain/);
  });

  it('a skipped or rejected registration does not stop the buy', async () => {
    global.fetch = vi.fn(async () => new Response('{}', { status: 404 })) as unknown as typeof fetch;
    register.mockResolvedValue('rejected');
    const onDeployed = vi.fn();
    render(<DeployBagPanel bagId="b1" bagName="Majors" chain="robinhood" onDeployed={onDeployed} />);
    await waitFor(() => expect(onDeployed).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('deploy-registration-step').textContent).toMatch(/Passport & verification tab/);
  });

  it('can be turned off', async () => {
    global.fetch = vi.fn(async () => new Response('{}', { status: 404 })) as unknown as typeof fetch;
    const onDeployed = vi.fn();
    render(<DeployBagPanel bagId="b1" bagName="Majors" chain="robinhood" onDeployed={onDeployed} registerAfterDeploy={false} />);
    await waitFor(() => expect(onDeployed).toHaveBeenCalledTimes(1));
    expect(register).not.toHaveBeenCalled();
  });
});
