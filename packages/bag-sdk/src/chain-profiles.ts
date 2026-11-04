import { BAG_V1_CHAINS, type BagChain } from './chains';

// -----------------------------------------------------------------------------
// Chain profiles: FACTS about a v1 chain that integrations need besides its id.
// Data only — no RPC, no default deployment pin, no token allowlist.
//
//   - nativeCurrency: the coin paid as transaction value (NATIVE_TOKEN input).
//   - wrappedNative / settlementStablecoin: canonical contracts on that chain, for display, sweeps and tests. They
//     are NOT the set of tokens the SDK supports: any ERC-20 is recognised by chain id + address
//     (adapters/evm.ts inspectToken); whether it may be bought is a separate decision (asset-capabilities.ts).
//   - receipts: which purchase-receipt evidence modes can work there, so an integration picks one that can return
//     VERIFIED instead of discovering INDETERMINATE after the purchase.
//
// Composer deployment pins are deliberately NOT here: they stay caller-supplied and reviewed per chain
// (docs/SDK_DEPLOYMENT_PIN_*.md). A profile existing says nothing about whether execution is qualified there.
// -----------------------------------------------------------------------------

export interface ChainTokenRef {
  address: string;
  symbol: string;
  decimals: number;
}

export interface ChainProfile {
  chain: BagChain;
  chainId: number;
  nativeCurrency: { symbol: string; decimals: number };
  wrappedNative: ChainTokenRef | null;
  settlementStablecoin: ChainTokenRef | null;
  receipts: {
    /** `verification: 'DELIVERY_LOG'` (a purchase compiled with delivery proof): works with any receipts RPC. */
    deliveryLog: boolean;
    /**
     * `balanceState: 'SINGLE_TRANSACTION_BLOCK'` needs the purchase to be the block's only transaction. On rollups
     * whose blocks always start with a system transaction (OP Stack deposit, ArbOS start-block), a block holding a
     * user's purchase has at least two, so this mode cannot verify a purchase there.
     */
    singleTransactionBlock: boolean;
    /** The qualified transaction-indexed balance reader for this chain, if any (adapters/receipt-rpc.ts). */
    indexedReader: 'ROBINHOOD_NITRO_TRANSACTION_INDEX' | null;
  };
}

const freezeProfile = (p: ChainProfile): Readonly<ChainProfile> =>
  Object.freeze({
    ...p,
    nativeCurrency: Object.freeze({ ...p.nativeCurrency }),
    wrappedNative: p.wrappedNative ? Object.freeze({ ...p.wrappedNative }) : null,
    settlementStablecoin: p.settlementStablecoin ? Object.freeze({ ...p.settlementStablecoin }) : null,
    receipts: Object.freeze({ ...p.receipts }),
  });

/** Profiles of the chains with reviewed facts. A v1 chain without one is still valid bag.json; it just has no profile. */
export const CHAIN_PROFILES: Readonly<Partial<Record<BagChain, Readonly<ChainProfile>>>> = Object.freeze({
  base: freezeProfile({
    chain: 'base',
    chainId: BAG_V1_CHAINS.base,
    nativeCurrency: { symbol: 'ETH', decimals: 18 },
    // OP Stack WETH predeploy; Circle's native USDC (not bridged USDbC). Both read on chain 2026-11-04.
    wrappedNative: { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', decimals: 18 },
    settlementStablecoin: { address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', symbol: 'USDC', decimals: 6 },
    receipts: { deliveryLog: true, singleTransactionBlock: false, indexedReader: null },
  }),
  robinhood: freezeProfile({
    chain: 'robinhood',
    chainId: BAG_V1_CHAINS.robinhood,
    nativeCurrency: { symbol: 'ETH', decimals: 18 },
    wrappedNative: null,
    settlementStablecoin: { address: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', symbol: 'USDG', decimals: 6 },
    receipts: { deliveryLog: true, singleTransactionBlock: false, indexedReader: 'ROBINHOOD_NITRO_TRANSACTION_INDEX' },
  }),
});

/** The profile for a chain slug or EIP-155 chain id, or null when none is recorded. */
export function getChainProfile(chain: BagChain | number): Readonly<ChainProfile> | null {
  const profiles = Object.values(CHAIN_PROFILES) as Readonly<ChainProfile>[];
  return (typeof chain === 'number' ? profiles.find((p) => p.chainId === chain) : CHAIN_PROFILES[chain]) ?? null;
}
