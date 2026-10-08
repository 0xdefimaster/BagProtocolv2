'use client';

import { encodeFunctionData } from 'viem';
import { ROBINHOOD_CHAIN_ID } from '@/lib/config/robinhood-chain';
import type { FeeAttestation, AttestedRedeemLeg } from '@/lib/server/redeem-fee-attestation';
import { executeWalletTransactionWithApprovals } from './wallet-sweep-client';

// -----------------------------------------------------------------------------
// V11 — browser-side counterpart to lib/server/redeem-fee-attestation.ts.
// The ONLY module that actually sends a `RedeemFeeRouter.redeem()`
// transaction from the user's own wallet. Same pattern as
// lib/blockchain/creator-rewards-vault-client.ts (real viem, real
// window.ethereum, verified RPC URL, no server involvement in the signature
// itself) — see that file's module doc for the reasoning this mirrors.
//
// Existing `RedeemFeeRouter.redeem()` calldata and approvals are sent through
// the shared wallet-call executor. Wallets with atomic EIP-5792 support can
// confirm the exact approvals and redemption together; unsupported wallets
// retain the exact-allowance sequential fallback. No provider or contract
// business logic is duplicated here.
// -----------------------------------------------------------------------------

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

/**
 * Builds the exact router transaction plus allowance requirements. Distinct
 * token legs are aggregated case-insensitively; the shared executor reads
 * current allowances and only emits exact approvals for short allowances.
 */
export function buildRedeemTransactionPlan(routerAddress: `0x${string}`, attestation: FeeAttestation) {
  const legs = attestation.legs.map((leg: AttestedRedeemLeg) => ({
    inputToken: leg.inputToken,
    inputAmount: BigInt(leg.inputAmount),
    swapTarget: leg.swapTarget,
    swapCallData: leg.swapCallData,
  }));
  const data = encodeFunctionData({
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
  });
  const approvals = collectRequiredApprovals(attestation).map(({ token, amount }) => ({
    token,
    spender: routerAddress,
    amountRaw: amount.toString(),
  }));
  return {
    transaction: { to: routerAddress, data, value: '0', chainId: ROBINHOOD_CHAIN_ID },
    approvals,
  };
}

export interface RedeemTransactionResult {
  txHash: `0x${string}`;
  /** The shared executor returns only after a successful receipt or an atomic successful calls status. */
  confirmed: true;
  authorizationStrategy: 'NONE' | 'EIP5792_ATOMIC_BATCH' | 'SEQUENTIAL';
}

/** Sends the existing attested Router calldata through BAG's shared wallet-call executor. */
export async function sendRedeemTransaction(
  routerAddress: `0x${string}`,
  userWalletAddress: `0x${string}`,
  attestation: FeeAttestation
): Promise<RedeemTransactionResult> {
  const result = await executeWalletTransactionWithApprovals(userWalletAddress, buildRedeemTransactionPlan(routerAddress, attestation), () => {}, { confirmationLabel: 'redemption' });
  return { txHash: result.txHash, confirmed: true, authorizationStrategy: result.authorizationStrategy };
}

/** Every distinct `inputToken` across the attestation's legs, paired with the total amount the router will pull. Sums duplicate-token legs case-insensitively. */
export function collectRequiredApprovals(attestation: FeeAttestation): { token: `0x${string}`; amount: bigint }[] {
  const totals = new Map<string, { token: `0x${string}`; amount: bigint }>();
  for (const leg of attestation.legs) {
    if (leg.inputToken.toLowerCase() === '0x0000000000000000000000000000000000000000') continue;
    const key = leg.inputToken.toLowerCase();
    const existing = totals.get(key);
    if (existing) existing.amount += BigInt(leg.inputAmount);
    else totals.set(key, { token: leg.inputToken, amount: BigInt(leg.inputAmount) });
  }
  return Array.from(totals.values());
}
