'use client';

import { getEthereumProvider } from '@/lib/wallet/eth-provider';
import { createPublicClient, createWalletClient, custom, http, type Chain } from 'viem';
import { ROBINHOOD_CHAIN_ID, ROBINHOOD_RPC_URL } from '@/lib/config/robinhood-chain';
import type { FeeAttestation, AttestedRedeemLeg } from '@/lib/server/redeem-fee-attestation';

// -----------------------------------------------------------------------------
// V11 — browser-side counterpart to lib/server/redeem-fee-attestation.ts.
// The ONLY module that actually sends a `RedeemFeeRouter.redeem()`
// transaction from the user's own wallet. Same pattern as
// lib/blockchain/creator-rewards-vault-client.ts (real viem, real
// window.ethereum, verified RPC URL, no server involvement in the signature
// itself) — see that file's module doc for the reasoning this mirrors.
//
// Two-step user experience, NOT one signature per leg: (1) one ERC-20
// `approve(routerAddress, inputAmount)` per DISTINCT input token that needs
// a swap (skipped entirely for a token already approved for enough, and
// skipped for "no swap" legs which still need approval since the router
// pulls them via transferFrom too), then (2) exactly ONE `redeem()` call
// covering every leg atomically. This is more signatures than the brief's
// "one user confirmation" ideal for a wallet that's never approved these
// tokens before — see docs/archive/V11_HARDENING_REPORT.md's honest accounting of
// this; Permit2 (confirmed deployed on Robinhood Chain — see
// lib/config/robinhood-chain.ts) could collapse this to one signature in a
// follow-up, not attempted this pass to avoid scope creep into a second
// signing standard on top of an already-large change.
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

const REDEEM_FEE_ROUTER_ABI = [
  {
    type: 'function',
    name: 'redeem',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'p',
        type: 'tuple',
        components: [
          { name: 'redemptionId', type: 'bytes32' },
          {
            name: 'legs',
            type: 'tuple[]',
            components: [
              { name: 'inputToken', type: 'address' },
              { name: 'inputAmount', type: 'uint256' },
              { name: 'swapTarget', type: 'address' },
              { name: 'swapCallData', type: 'bytes' },
            ],
          },
          { name: 'creator', type: 'address' },
          { name: 'feeAmount', type: 'uint256' },
          { name: 'minUserProceeds', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
          { name: 'attestationSignature', type: 'bytes' },
        ],
      },
    ],
    outputs: [{ name: 'userProceeds', type: 'uint256' }],
  },
] as const;

const ROBINHOOD_VIEM_CHAIN: Chain = {
  id: ROBINHOOD_CHAIN_ID,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [ROBINHOOD_RPC_URL] } },
};

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

function requireWallet() {
  if (!getEthereumProvider()) {
    throw new Error('No wallet extension found. Connect a wallet first.');
  }
  return getEthereumProvider()!;
}

/**
 * Ensures `routerAddress` has at least `requiredAmount` allowance on
 * `tokenAddress` from `ownerAddress`, approving (and waiting for
 * confirmation) if not. Called once per distinct leg token before
 * `sendRedeemTransaction` — `RedeemFeeRouter.redeem()` pulls every leg via
 * `transferFrom`, including "no swap" legs (see RedeemFeeRouter.sol), so
 * this must run for every leg's `inputToken`, not just swapped ones.
 * Returns the approval tx hash, or null if no approval was needed.
 */
export async function ensureRouterAllowance(
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

export interface RedeemTransactionResult {
  txHash: `0x${string}`;
  /** True only once the receipt is fetched AND its status is 'success' — a submitted-but-reverted tx never reaches this. */
  confirmed: boolean;
}

/**
 * Sends the actual `RedeemFeeRouter.redeem()` transaction from the
 * connected wallet, then waits for on-chain confirmation. Callers MUST
 * have already run `ensureRouterAllowance()` for every leg's `inputToken`
 * — this function does not itself check or set any approval, so a missing
 * one surfaces as a normal on-chain revert (`ERC20: insufficient allowance`),
 * not a special case here.
 */
export async function sendRedeemTransaction(
  routerAddress: `0x${string}`,
  userWalletAddress: `0x${string}`,
  attestation: FeeAttestation
): Promise<RedeemTransactionResult> {
  const ethereum = requireWallet();
  const walletClient = createWalletClient({ account: userWalletAddress, chain: ROBINHOOD_VIEM_CHAIN, transport: custom(ethereum) });
  const publicClient = createPublicClient({ chain: ROBINHOOD_VIEM_CHAIN, transport: http(ROBINHOOD_RPC_URL) });

  const legs = attestation.legs.map((leg: AttestedRedeemLeg) => ({
    inputToken: leg.inputToken,
    inputAmount: BigInt(leg.inputAmount),
    swapTarget: leg.swapTarget,
    swapCallData: leg.swapCallData,
  }));

  const txHash = await walletClient.writeContract({
    address: routerAddress,
    abi: REDEEM_FEE_ROUTER_ABI,
    functionName: 'redeem',
    args: [
      {
        redemptionId: attestation.redemptionId,
        legs,
        creator: attestation.creator,
        feeAmount: BigInt(attestation.feeAmount),
        minUserProceeds: BigInt(attestation.minUserProceeds),
        deadline: BigInt(attestation.deadline),
        attestationSignature: attestation.signature,
      },
    ],
    chain: ROBINHOOD_VIEM_CHAIN,
    account: userWalletAddress,
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  return { txHash, confirmed: receipt.status === 'success' };
}

/** Every distinct `inputToken` across the attestation's legs, each paired with the total amount the router will pull for that token — the exact set `ensureRouterAllowance` must be called for before `sendRedeemTransaction`. Sums duplicate-token legs rather than assuming each token appears once. */
export function collectRequiredApprovals(attestation: FeeAttestation): { token: `0x${string}`; amount: bigint }[] {
  const totals = new Map<string, bigint>();
  for (const leg of attestation.legs) {
    if (leg.inputToken === ZERO_ADDRESS) continue;
    const prev = totals.get(leg.inputToken) ?? BigInt(0);
    totals.set(leg.inputToken, prev + BigInt(leg.inputAmount));
  }
  return Array.from(totals.entries()).map(([token, amount]) => ({ token: token as `0x${string}`, amount }));
}
