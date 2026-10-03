'use client';

import { getEthereumProvider } from '@/lib/wallet/eth-provider';
import { createPublicClient, createWalletClient, custom, http, type Chain } from 'viem';
import { ROBINHOOD_CHAIN_ID, ROBINHOOD_RPC_URL } from '@/lib/config/robinhood-chain';

// -----------------------------------------------------------------------------
// Browser-only counterpart to lib/blockchain/lifi-wallet-client.ts, scoped to
// exactly two things a creator needs: read their CreatorRewardsVault
// `balanceOf`, and call `withdrawAll` themselves. Deliberately does NOT reuse
// lifi-wallet-client.ts's multi-chain ROBINHOOD_CHAIN constant (that file
// hardcodes a placeholder RPC, 'https://rpc.robinhood.chain', that was never
// meant to be load-bearing since @lifi/sdk does its own routing/RPC calls —
// see that file's own comment). This module DOES make its own direct RPC
// calls (balanceOf, withdrawAll), so it uses the verified RPC URL from
// lib/config/robinhood-chain.ts instead.
//
// Minimal hand-written ABI fragment rather than importing the full compiled
// Hardhat artifact (which also bundles bytecode) — keeps this out of the
// client bundle's weight and avoids a build-time dependency on
// artifacts/ (gitignored, only present after `hardhat compile`).
// -----------------------------------------------------------------------------

const VAULT_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'creator', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'withdrawAll',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: [],
  },
] as const;

const ROBINHOOD_VIEM_CHAIN: Chain = {
  id: ROBINHOOD_CHAIN_ID,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [ROBINHOOD_RPC_URL] } },
};

/** Read-only — no wallet connection required. Returns 0n if the vault has never credited this address (a real zero balance, not "not deployed"; check vaultAddress separately for that). */
export async function fetchClaimableRewardBalance(
  vaultAddress: `0x${string}`,
  creatorWalletAddress: `0x${string}`
): Promise<bigint> {
  const publicClient = createPublicClient({ chain: ROBINHOOD_VIEM_CHAIN, transport: http(ROBINHOOD_RPC_URL) });
  return publicClient.readContract({
    address: vaultAddress,
    abi: VAULT_ABI,
    functionName: 'balanceOf',
    args: [creatorWalletAddress],
  });
}

/**
 * Withdraws the connected wallet's ENTIRE claimable balance directly from
 * the vault to that same wallet — no backend involvement, no approval step,
 * matching `CreatorRewardsVault.withdrawAll`'s own no-intermediary guarantee.
 * Requires the wallet to already be connected and on (or able to switch to)
 * Robinhood Chain; the wallet extension itself prompts for the network
 * switch if needed, the same way lib/blockchain/lifi-wallet-client.ts leaves
 * that prompt to the wallet rather than pre-guessing.
 */
export async function claimAllCreatorRewards(
  vaultAddress: `0x${string}`,
  creatorWalletAddress: `0x${string}`
): Promise<`0x${string}`> {
  if (!getEthereumProvider()) {
    throw new Error('No wallet extension found. Connect a wallet first.');
  }
  const walletClient = createWalletClient({
    account: creatorWalletAddress,
    chain: ROBINHOOD_VIEM_CHAIN,
    transport: custom(getEthereumProvider()!),
  });
  return walletClient.writeContract({
    address: vaultAddress,
    abi: VAULT_ABI,
    functionName: 'withdrawAll',
    chain: ROBINHOOD_VIEM_CHAIN,
    account: creatorWalletAddress,
  });
}

/** Returns null if no vault address is configured yet (pre-deployment) — callers should treat that as "on-chain claiming not available yet", not as an error. */
export function getConfiguredVaultAddress(): `0x${string}` | null {
  const raw = process.env.NEXT_PUBLIC_CREATOR_REWARDS_VAULT_ADDRESS;
  if (!raw) return null;
  return raw as `0x${string}`;
}
