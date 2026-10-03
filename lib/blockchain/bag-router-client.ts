'use client';

import { getEthereumProvider } from '@/lib/wallet/eth-provider';
import { createPublicClient, createWalletClient, custom, http, type Chain } from 'viem';
import { ROBINHOOD_CHAIN_ID, ROBINHOOD_RPC_URL } from '@/lib/config/robinhood-chain';

// -----------------------------------------------------------------------------
// bag-router-client.ts — the ONLY module that actually sends a
// `BagExecutionRouter.execute()` transaction from the user's own wallet.
// Same pattern as lib/blockchain/redeem-fee-router-client.ts (real viem,
// real window.ethereum, verified RPC URL, no server involvement in the
// signature itself) — see that file's module doc for the reasoning this
// mirrors.
//
// WHY THIS IS ITS OWN FILE, NOT A REUSE OF hooks/use-purchase-execution.ts's
// `executeComposerTransaction()` (Bag Router execution hardening, item 3):
// the router's `execute()` calls `IERC20(inputToken).safeTransferFrom(
// msg.sender, address(this), inputAmount)` — it needs a prior ERC-20
// `approve()` the way Composer's flow does not. Sending the router's
// already-built calldata the SAME way Composer's transaction is sent
// (straight `sendTransaction`, no allowance check first) would work
// on-chain only for a wallet that happens to already have enough
// allowance from a previous purchase, and revert for every fresh wallet —
// exactly the "do not falsely claim one confirmation" failure mode item 2
// of the hardening spec calls out. `ensureBagRouterAllowance` below is
// what makes that approval an explicit, checked step instead.
//
// Two-step user experience for a fresh wallet: (1) one ERC-20
// `approve(routerAddress, inputAmount)` if the CURRENT allowance is
// insufficient (skipped entirely once a wallet has approved enough for a
// prior purchase), then (2) exactly ONE `execute()` call. This is honestly
// reflected to the user by `lib/execution/signing-expectation.ts`, which
// already defaults `assumeApprovalNeeded` to `true` for `SINGLE_TX` — see
// that module's own doc.
//
// Only ever deployed on Robinhood Chain today (bag-router-provider.ts's
// `BagRouterProviderConfig.chainId` is pinned at registration) — same
// single-chain assumption `redeem-fee-router-client.ts` already makes for
// `RedeemFeeRouter`, not a new constraint introduced here.
// -----------------------------------------------------------------------------

const ERC20_ABI = [
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

const ROBINHOOD_VIEM_CHAIN: Chain = {
  id: ROBINHOOD_CHAIN_ID,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [ROBINHOOD_RPC_URL] } },
};

function requireWallet() {
  if (!getEthereumProvider()) {
    throw new Error('No wallet extension found. Connect a wallet first.');
  }
  return getEthereumProvider()!;
}

/**
 * Ensures `routerAddress` has at least `requiredAmount` allowance on
 * `tokenAddress` from `ownerAddress`, approving (and waiting for
 * confirmation) if not. Returns the approval tx hash, or `null` if no
 * approval was needed (the common case for a wallet that already
 * purchased through the BAG Router before). Callers MUST run this before
 * `sendBagRouterTransaction` — the router's `execute()` itself does not
 * check allowance for the caller, it just reverts on an insufficient one.
 */
export async function ensureBagRouterAllowance(
  tokenAddress: `0x${string}`,
  ownerAddress: `0x${string}`,
  routerAddress: `0x${string}`,
  requiredAmount: bigint
): Promise<`0x${string}` | null> {
  const ethereum = requireWallet();
  const publicClient = createPublicClient({ chain: ROBINHOOD_VIEM_CHAIN, transport: http(ROBINHOOD_RPC_URL) });

  const current = await publicClient.readContract({
    address: tokenAddress,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: [ownerAddress, routerAddress],
  });
  if (current >= requiredAmount) return null;

  const walletClient = createWalletClient({ account: ownerAddress, chain: ROBINHOOD_VIEM_CHAIN, transport: custom(ethereum) });
  const hash = await walletClient.writeContract({
    address: tokenAddress,
    abi: ERC20_ABI,
    functionName: 'approve',
    args: [routerAddress, requiredAmount],
    chain: ROBINHOOD_VIEM_CHAIN,
    account: ownerAddress,
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

export interface BagRouterTransactionInput {
  to: string;
  data: string;
  value: string;
  chainId: number;
}

/**
 * Sends the actual `BagExecutionRouter.execute()` transaction — already
 * built, signed-plan-embedding calldata from `bag-router-provider.ts`'s
 * `compile()`, threaded through unchanged (this module builds nothing new,
 * same "server compiles, wallet only signs/sends" boundary
 * `lifi-wallet-client.ts`'s module doc describes). Callers MUST have
 * already run `ensureBagRouterAllowance()` — this function does not itself
 * check or set any allowance, so a missing one surfaces as a normal
 * on-chain revert, not a special case here.
 */
export async function sendBagRouterTransaction(
  ownerAddress: `0x${string}`,
  tx: BagRouterTransactionInput
): Promise<`0x${string}`> {
  const ethereum = requireWallet();
  const walletClient = createWalletClient({ account: ownerAddress, chain: ROBINHOOD_VIEM_CHAIN, transport: custom(ethereum) });

  return walletClient.sendTransaction({
    account: ownerAddress,
    chain: ROBINHOOD_VIEM_CHAIN,
    to: tx.to as `0x${string}`,
    data: tx.data as `0x${string}`,
    value: BigInt(tx.value),
  });
}
