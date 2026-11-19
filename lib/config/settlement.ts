import type { ChainId } from '@/types/basket-protocol';
import { BAG_CHAINS, isBagChain, type BagChain } from '@/lib/config/chains';
import { DEPLOYED_CONTRACTS, ROBINHOOD_REWARD_TOKEN } from '@/lib/config/robinhood-chain';

// -----------------------------------------------------------------------------
// Per-chain fee settlement (contracts/RedeemSettlement.sol).
//
// RedeemSettlement takes its settlement token as a constructor argument, so the
// same contract runs on any EVM chain with a dollar stablecoin: USDG on
// Robinhood Chain, Circle's native USDC on Base. One deployment per chain; the
// EIP-712 domain carries the chain id, so one attestation can never settle on
// another chain even with the same attestor key.
//
//   robinhood  REDEEM_SETTLEMENT_ADDRESS        (unchanged)
//   base       REDEEM_SETTLEMENT_ADDRESS_BASE      (unset until deployed; until then
//                                                   a Base Bag must charge 0%)
//   arbitrum   REDEEM_SETTLEMENT_ADDRESS_ARBITRUM  (same rule)
//
// The older RedeemFeeRouter / CreatorRewardsVault path stays Robinhood-only.
// Read at call time, never cached (Next.js may load this before env is set).
// -----------------------------------------------------------------------------

/** How a settlement token reports a blocked holder, for the pre-signing preflight. */
export type FreezeCheck = { fn: 'isFrozen' } | { fn: 'isBlacklisted' };

export interface SettlementToken {
  address: `0x${string}`;
  symbol: string;
  decimals: number;
  freezeCheck: FreezeCheck;
}

const SETTLEMENT_TOKENS: Partial<Record<BagChain, SettlementToken>> = {
  // Paxos USDG: isFrozen(address).
  robinhood: { address: ROBINHOOD_REWARD_TOKEN.address, symbol: ROBINHOOD_REWARD_TOKEN.symbol, decimals: ROBINHOOD_REWARD_TOKEN.decimals, freezeCheck: { fn: 'isFrozen' } },
  // Circle native USDC on Base (FiatTokenV2): isBlacklisted(address). Same address as PAYMENT_TOKEN_BY_CHAIN.base.
  base: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC', decimals: 6, freezeCheck: { fn: 'isBlacklisted' } },
  // Circle native USDC on Arbitrum One (FiatTokenV2). Same address as PAYMENT_TOKEN_BY_CHAIN.arbitrum.
  arbitrum: { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', symbol: 'USDC', decimals: 6, freezeCheck: { fn: 'isBlacklisted' } },
};

const SETTLEMENT_ADDRESS_ENV: Partial<Record<BagChain, string>> = {
  robinhood: 'REDEEM_SETTLEMENT_ADDRESS',
  base: 'REDEEM_SETTLEMENT_ADDRESS_BASE',
  arbitrum: 'REDEEM_SETTLEMENT_ADDRESS_ARBITRUM',
};

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** The env variable that holds RedeemSettlement's address on `chain`, or null for a chain with no settlement support. */
export function redeemSettlementEnvVar(chain: string): string | null {
  return isBagChain(chain) ? SETTLEMENT_ADDRESS_ENV[chain] ?? null : null;
}

/** The settlement token on `chain`, or null where fee settlement is not supported. */
export function settlementTokenFor(chain: string): SettlementToken | null {
  return isBagChain(chain) ? SETTLEMENT_TOKENS[chain] ?? null : null;
}

/** RedeemSettlement's deployed address on `chain`, or null (fail closed) when unset or malformed. */
export function redeemSettlementAddressFor(chain: string): `0x${string}` | null {
  if (chain === 'robinhood') return DEPLOYED_CONTRACTS.redeemSettlement;
  const env = redeemSettlementEnvVar(chain);
  const raw = env ? process.env[env]?.trim() : undefined;
  return raw && ADDRESS_RE.test(raw) && !/^0x0{40}$/i.test(raw) ? (raw as `0x${string}`) : null;
}

/** EVM chain id of `chain`, for the EIP-712 settlement domain. */
export function settlementChainId(chain: string): number {
  if (!isBagChain(chain)) throw new Error(`No chain id for "${chain}".`);
  return BAG_CHAINS[chain].chainId;
}

/**
 * Whether a Bag on `chain` may charge a performance fee from this deployment. Robinhood Chain always may (settlement,
 * fee router or the database-booked fee); any other chain only once RedeemSettlement is deployed and configured there,
 * since the fee is then computed and paid on chain. Server-side only: the browser learns it from GET /api/deploy/chains.
 */
export function performanceFeeEnabledOn(chain: ChainId | string): boolean {
  if (chain === 'robinhood') return true;
  return settlementTokenFor(chain) !== null && redeemSettlementAddressFor(chain) !== null;
}
