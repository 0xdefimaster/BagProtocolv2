import { describe, expect, it } from 'vitest';
import { redactRpcUrl, resolveRpcEndpoints } from '../endpoints';
import { BAG_CHAINS, bagChainByChainId } from '@/lib/config/chains';

describe('central chain configuration', () => {
  it('chain ids, native tokens, asset types', () => {
    expect([BAG_CHAINS.ethereum.chainId, BAG_CHAINS.arbitrum.chainId, BAG_CHAINS.base.chainId, BAG_CHAINS.robinhood.chainId]).toEqual([1, 42161, 8453, 4663]);
    expect(BAG_CHAINS.robinhood.nativeCurrency.symbol).toBe('ETH');
    expect(BAG_CHAINS.robinhood.supportedAssetTypes).toEqual(['CRYPTO', 'STOCK_TOKEN']);
    expect(BAG_CHAINS.base.supportedAssetTypes).toEqual(['CRYPTO']);
    expect(bagChainByChainId(4663)?.chain).toBe('robinhood');
    expect(BAG_CHAINS.robinhood.viemChain.id).toBe(4663);
  });
});

describe('resolveRpcEndpoints', () => {
  it('Alchemy primary from ALCHEMY_API_KEY, then secondary, then the operator public RPC', () => {
    expect(resolveRpcEndpoints('robinhood', { ALCHEMY_API_KEY: 'k', ROBINHOOD_RPC_URL_SECONDARY: 'https://qn.example/abc' })).toEqual([
      { tier: 'primary', provider: 'alchemy', url: 'https://robinhood-mainnet.g.alchemy.com/v2/k' },
      { tier: 'secondary', provider: 'custom', url: 'https://qn.example/abc' },
      { tier: 'public', provider: 'public', url: 'https://rpc.mainnet.chain.robinhood.com' },
    ]);
    expect(resolveRpcEndpoints('arbitrum', { ALCHEMY_API_KEY: 'k' })[0].url).toBe('https://arb-mainnet.g.alchemy.com/v2/k');
    expect(resolveRpcEndpoints('base', { ALCHEMY_API_KEY: 'k' })[0].url).toBe('https://base-mainnet.g.alchemy.com/v2/k');
    expect(resolveRpcEndpoints('ethereum', { ALCHEMY_API_KEY: 'k' })[0].url).toBe('https://eth-mainnet.g.alchemy.com/v2/k');
  });

  it('explicit <CHAIN>_RPC_URL wins over Alchemy; legacy RPC_URL_<CHAIN> still honoured', () => {
    expect(resolveRpcEndpoints('base', { ALCHEMY_API_KEY: 'k', BASE_RPC_URL: 'https://mine.example' })[0]).toEqual({ tier: 'primary', provider: 'custom', url: 'https://mine.example' });
    expect(resolveRpcEndpoints('ethereum', { RPC_URL_ETHEREUM: 'http://127.0.0.1:8545' })[0].url).toBe('http://127.0.0.1:8545');
  });

  it('Ethereum has no public fallback; public fallback can be disabled; duplicates removed', () => {
    expect(resolveRpcEndpoints('ethereum', {})).toEqual([]);
    expect(resolveRpcEndpoints('robinhood', { RPC_PUBLIC_FALLBACK: 'false' })).toEqual([]);
    expect(resolveRpcEndpoints('robinhood', { ROBINHOOD_RPC_URL: 'https://rpc.mainnet.chain.robinhood.com' })).toHaveLength(1);
  });

  it('redacts credentials for logging', () => {
    expect(redactRpcUrl('https://robinhood-mainnet.g.alchemy.com/v2/SECRET')).toBe('https://robinhood-mainnet.g.alchemy.com/…');
    expect(redactRpcUrl('https://rpc.mainnet.chain.robinhood.com')).toBe('https://rpc.mainnet.chain.robinhood.com');
  });
});
