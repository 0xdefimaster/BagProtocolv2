import { arbitrum, base, mainnet, type Chain } from 'viem/chains';
import { defineChain } from 'viem';
import {
  ROBINHOOD_CHAIN_ID,
  ROBINHOOD_EXPLORER_URL,
  ROBINHOOD_NATIVE_CURRENCY,
  ROBINHOOD_PUBLIC_RPC_URL,
  ROBINHOOD_REWARD_TOKEN,
  ROBINHOOD_WETH_ADDRESS,
} from './robinhood-chain';

// -----------------------------------------------------------------------------
// The ONE place BAG's EVM chains are described. Everything chain-specific
// (chain id, native token, explorer, which RPC providers exist, which asset
// types live there) is read from here; nothing else re-types these values.
//
// Solana stays in the protocol-level `ChainId` union (types/basket-protocol.ts)
// for LI.FI routing, but it is not an EVM chain and has no entry here.
//
// RPC providers per chain (resolved in lib/blockchain/rpc/endpoints.ts):
//   1. primary   — `<CHAIN>_RPC_URL` (or legacy `RPC_URL_<CHAIN>`), else an
//                  Alchemy URL built from ALCHEMY_API_KEY + `alchemyNetwork`
//   2. secondary — `<CHAIN>_RPC_URL_SECONDARY` (e.g. QuickNode)
//   3. public    — `publicRpcUrls`, only where the chain's OPERATOR runs one.
//                  Ethereum has none: a third-party public endpoint is not a
//                  protocol-blessed default.
// Alchemy network slugs: alchemy.com/docs (eth-mainnet, arb-mainnet,
// base-mainnet) and alchemy.com/rpc/robinhood (robinhood-mainnet).
// -----------------------------------------------------------------------------

export const BAG_CHAINS_LIST = ['ethereum', 'arbitrum', 'base', 'robinhood'] as const;
export type BagChain = (typeof BAG_CHAINS_LIST)[number];

export type BagAssetType = 'CRYPTO' | 'STOCK_TOKEN';

export interface BagChainConfig {
  chain: BagChain;
  chainId: number;
  name: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  explorerUrl: string;
  /** Alchemy network slug: https://<slug>.g.alchemy.com/v2/<key> */
  alchemyNetwork: string;
  /** Public RPC endpoints run by the chain's operator (last-resort fallback). */
  publicRpcUrls: readonly string[];
  supportedAssetTypes: readonly BagAssetType[];
  viemChain: Chain;
  /**
   * MetaMask smart-account DelegationManager contracts observed on this chain (lowercase). A wallet's
   * `redeemDelegations` transaction counts as carrying a BAG-built call only when it is sent to one of these
   * (lib/blockchain/composer-status.ts). Empty: that route is refused on this chain.
   */
  delegationManagers: readonly string[];
  /**
   * The chain's canonical wrapped native token (WETH). Non-null means a
   * buyer may pay for a Bag with the chain's native token: WETH is the price
   * identity that values the native payment in USD (lib/server/payment-value.ts),
   * never a token the purchase touches. Null: native payments are off there.
   */
  wrappedNativeAddress: string | null;
  /**
   * The stablecoin a wallet sweep sells into on this chain (Swap page, lib/server/wallet-holdings.ts):
   * USDG on Robinhood Chain, Circle's native USDC on Ethereum, Arbitrum and Base.
   */
  sweepOutputToken: { address: string; symbol: string; decimals: number };
}

const ROBINHOOD_NATIVE = { name: 'Ether', ...ROBINHOOD_NATIVE_CURRENCY };

const robinhoodViemChain = defineChain({
  id: ROBINHOOD_CHAIN_ID,
  name: 'Robinhood Chain',
  nativeCurrency: ROBINHOOD_NATIVE,
  rpcUrls: { default: { http: [ROBINHOOD_PUBLIC_RPC_URL] } },
  blockExplorers: { default: { name: 'Blockscout', url: ROBINHOOD_EXPLORER_URL } },
});

export const BAG_CHAINS: Record<BagChain, BagChainConfig> = {
  ethereum: {
    chain: 'ethereum',
    chainId: mainnet.id,
    name: 'Ethereum',
    nativeCurrency: mainnet.nativeCurrency,
    explorerUrl: mainnet.blockExplorers.default.url,
    alchemyNetwork: 'eth-mainnet',
    publicRpcUrls: [],
    supportedAssetTypes: ['CRYPTO'],
    viemChain: mainnet,
    delegationManagers: [],
    // Canonical WETH9 on Ethereum mainnet.
    wrappedNativeAddress: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    sweepOutputToken: { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', symbol: 'USDC', decimals: 6 },
  },
  arbitrum: {
    chain: 'arbitrum',
    chainId: arbitrum.id,
    name: 'Arbitrum One',
    nativeCurrency: arbitrum.nativeCurrency,
    explorerUrl: arbitrum.blockExplorers.default.url,
    alchemyNetwork: 'arb-mainnet',
    publicRpcUrls: arbitrum.rpcUrls.default.http,
    supportedAssetTypes: ['CRYPTO'],
    viemChain: arbitrum,
    delegationManagers: [],
    // Canonical WETH on Arbitrum One.
    wrappedNativeAddress: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
    // Native USDC (not the bridged USDC.e).
    sweepOutputToken: { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', symbol: 'USDC', decimals: 6 },
  },
  base: {
    chain: 'base',
    chainId: base.id,
    name: 'Base',
    nativeCurrency: base.nativeCurrency,
    explorerUrl: base.blockExplorers.default.url,
    alchemyNetwork: 'base-mainnet',
    publicRpcUrls: base.rpcUrls.default.http,
    supportedAssetTypes: ['CRYPTO'],
    viemChain: base as unknown as Chain,
    delegationManagers: [],
    // WETH predeploy on Base (OP Stack).
    wrappedNativeAddress: '0x4200000000000000000000000000000000000006',
    sweepOutputToken: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC', decimals: 6 },
  },
  robinhood: {
    chain: 'robinhood',
    chainId: ROBINHOOD_CHAIN_ID,
    name: 'Robinhood Chain',
    nativeCurrency: ROBINHOOD_NATIVE,
    explorerUrl: ROBINHOOD_EXPLORER_URL,
    alchemyNetwork: 'robinhood-mainnet',
    publicRpcUrls: [ROBINHOOD_PUBLIC_RPC_URL],
    supportedAssetTypes: ['CRYPTO', 'STOCK_TOKEN'],
    viemChain: robinhoodViemChain,
    // MetaMask Delegation Framework DelegationManager, seen as the target of smart-account transactions here.
    delegationManagers: ['0xdb9b1e94b5b69df7e401ddbede43491141047db3'],
    wrappedNativeAddress: ROBINHOOD_WETH_ADDRESS,
    sweepOutputToken: { address: ROBINHOOD_REWARD_TOKEN.address, symbol: ROBINHOOD_REWARD_TOKEN.symbol, decimals: ROBINHOOD_REWARD_TOKEN.decimals },
  },
};

export function isBagChain(value: string): value is BagChain {
  return (BAG_CHAINS_LIST as readonly string[]).includes(value);
}

export function bagChainByChainId(chainId: number): BagChainConfig | undefined {
  return Object.values(BAG_CHAINS).find((c) => c.chainId === chainId);
}
