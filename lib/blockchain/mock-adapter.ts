import { BlockchainAdapter, MintNFTParams, TransferNFTParams } from './adapter';

function fakeTxHash(): string {
  const hex = Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  return `0x${hex}`;
}

/**
 * Mock adapter — simulates chain latency and returns fake tx hashes.
 * Every NFT stays `blockchainStatus: 'OFFCHAIN'` in the database regardless
 * of what this returns; nothing here is authoritative. It has NO Bag
 * deployment capability: Bag deployment goes through `BagDeploymentAdapter`
 * (lib/blockchain/evm/adapter.ts) only, and a missing chain config fails
 * closed — a mock can never produce a "deployed" Bag.
 */
export const mockAdapter: BlockchainAdapter = {
  name: 'mock',
  isLive: false,

  async mintNFT(_params: MintNFTParams): Promise<string> {
    await new Promise((r) => setTimeout(r, 250));
    return fakeTxHash();
  },

  async transferNFT(_params: TransferNFTParams): Promise<string> {
    await new Promise((r) => setTimeout(r, 250));
    return fakeTxHash();
  },

  async getBalance(_address: string): Promise<string> {
    return '0';
  },
};

// Swap this export for a real adapter (e.g. a Robinhood Chain adapter) once
// mainnet integration begins — nothing else in the codebase needs to change.
export const blockchainAdapter: BlockchainAdapter = mockAdapter;
