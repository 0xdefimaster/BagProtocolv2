import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ provider: null as null | { request: ReturnType<typeof vi.fn> } }));
vi.mock('@/lib/wallet/eth-provider', () => ({ getEthereumProvider: () => mocks.provider }));

import { addEthereumChainParams, getBrowserWalletClientForChain, isUnknownChainError } from '../lifi-wallet-client';
import { ROBINHOOD_EXPLORER_URL, ROBINHOOD_PUBLIC_RPC_URL } from '@/lib/config/robinhood-chain';

const WALLET = '0x49da00000000000000000000000000000000fe46';

/** A wallet on Ethereum that does not know Robinhood Chain until it is added (Rabby's behaviour). */
function wallet(opts: { knowsChain?: boolean; switchError?: unknown; addError?: unknown } = {}) {
  let chainId = '0x1';
  let known = opts.knowsChain ?? false;
  const request = vi.fn(async ({ method, params }: { method: string; params?: unknown[] }) => {
    if (method === 'eth_chainId') return chainId;
    if (method === 'wallet_switchEthereumChain') {
      const target = (params as [{ chainId: string }])[0].chainId;
      if (!known) throw opts.switchError ?? Object.assign(new Error('Unrecognized chain ID "0x1237". Try adding the chain using wallet_addEthereumChain first.'), { code: 4902 });
      chainId = target;
      return null;
    }
    if (method === 'wallet_addEthereumChain') {
      if (opts.addError) throw opts.addError;
      known = true;
      return null;
    }
    throw new Error(`unexpected ${method}`);
  });
  mocks.provider = { request };
  return request;
}

beforeEach(() => {
  mocks.provider = null;
});

describe('addEthereumChainParams', () => {
  it('Robinhood Chain from lib/config: public RPC and explorer only', () => {
    expect(addEthereumChainParams(4663)).toEqual({
      chainId: '0x1237',
      chainName: 'Robinhood Chain',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: [ROBINHOOD_PUBLIC_RPC_URL],
      blockExplorerUrls: [ROBINHOOD_EXPLORER_URL],
    });
  });
  it('null for a chain without a public RPC in config (Ethereum) or one BAG does not know', () => {
    expect(addEthereumChainParams(1)).toBeNull();
    expect(addEthereumChainParams(999999)).toBeNull();
  });
});

describe('isUnknownChainError', () => {
  it('code 4902, a nested 4902, or the wording wallets use', () => {
    expect(isUnknownChainError({ code: 4902 })).toBe(true);
    expect(isUnknownChainError({ code: -32603, data: { originalError: { code: 4902 } } })).toBe(true);
    expect(isUnknownChainError({ code: -32603, message: 'Unrecognized chain ID "0x1237"' })).toBe(true);
    expect(isUnknownChainError(new Error('Chain 0x1237 not added'))).toBe(true);
    expect(isUnknownChainError({ code: 4001, message: 'User rejected the request.' })).toBe(false);
    expect(isUnknownChainError(new Error('Internal error'))).toBe(false);
  });
});

describe('switching to a chain the wallet does not know', () => {
  it('adds Robinhood Chain from config, then switches', async () => {
    const request = wallet();
    await getBrowserWalletClientForChain(WALLET, 4663);
    const methods = request.mock.calls.map(([a]) => a.method);
    expect(methods).toEqual(['eth_chainId', 'wallet_switchEthereumChain', 'wallet_addEthereumChain', 'wallet_switchEthereumChain']);
    const added = request.mock.calls.find(([a]) => a.method === 'wallet_addEthereumChain')![0] as unknown as { params: [{ rpcUrls: string[] }] };
    expect(added.params[0].rpcUrls).toEqual([ROBINHOOD_PUBLIC_RPC_URL]);
  });

  it('a known chain: just switches; a rejected switch or add says so', async () => {
    const known = wallet({ knowsChain: true });
    await getBrowserWalletClientForChain(WALLET, 4663);
    expect(known.mock.calls.map(([a]) => a.method)).not.toContain('wallet_addEthereumChain');

    wallet({ switchError: Object.assign(new Error('User rejected'), { code: 4001 }) });
    await expect(getBrowserWalletClientForChain(WALLET, 4663)).rejects.toThrow('Network switch was rejected.');

    wallet({ addError: Object.assign(new Error('User rejected'), { code: 4001 }) });
    await expect(getBrowserWalletClientForChain(WALLET, 4663)).rejects.toThrow('Adding Robinhood Chain to your wallet was rejected.');
  });

  it('another switch failure is not mistaken for an unknown chain', async () => {
    wallet({ switchError: Object.assign(new Error('Internal error'), { code: -32603 }) });
    await expect(getBrowserWalletClientForChain(WALLET, 4663)).rejects.toThrow('Internal error');
  });
});
