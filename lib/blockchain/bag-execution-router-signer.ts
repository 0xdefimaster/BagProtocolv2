import type { Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { BagRouterPlanSigner, RouterExecutionPlan } from '@/lib/execution/providers/bag-router-provider';

// -----------------------------------------------------------------------------
// lib/blockchain/bag-execution-router-signer.ts
//
// Real `BagRouterPlanSigner` — signs the EIP-712 `ExecutionPlan` struct
// EXACTLY the way `contracts/BagExecutionRouter.sol` verifies it. The
// field names/order below are copied field-for-field from the contract's
// own typehash constants (do not reorder without re-checking against the
// contract — EIP-712 struct hashing is order-sensitive):
//
//   EXECUTION_PLAN_TYPEHASH = keccak256(
//     'ExecutionPlan(bytes32 bagId,bytes32 executionPlanHash,address wallet,
//      address inputToken,uint256 inputAmount,uint256 deadline,Leg[] legs,
//      OutputCheck[] minOutputs)Leg(address target,bytes callData,
//      uint256 value,address approveToken,uint256 approveAmount)
//      OutputCheck(address token,uint256 minAmountOut)'
//   )
//
// `EIP712('BagExecutionRouter', '1')` (the contract's constructor) fixes
// the domain name/version — the domain's `chainId`/`verifyingContract` are
// the two per-deployment values `signPlan()` is given at call time.
//
// The private key is read ONLY here, server-side, and is never exposed to
// `BagRouterProvider`, the compiler, or any browser code — matching
// `bag-router-provider.ts`'s own doc ("it does not hold, or have any
// access to, the plan-signing key").
// -----------------------------------------------------------------------------

const EIP712_TYPES = {
  ExecutionPlan: [
    { name: 'bagId', type: 'bytes32' },
    { name: 'executionPlanHash', type: 'bytes32' },
    { name: 'wallet', type: 'address' },
    { name: 'inputToken', type: 'address' },
    { name: 'inputAmount', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'legs', type: 'Leg[]' },
    { name: 'minOutputs', type: 'OutputCheck[]' },
  ],
  Leg: [
    { name: 'target', type: 'address' },
    { name: 'callData', type: 'bytes' },
    { name: 'value', type: 'uint256' },
    { name: 'approveToken', type: 'address' },
    { name: 'approveAmount', type: 'uint256' },
  ],
  OutputCheck: [
    { name: 'token', type: 'address' },
    { name: 'minAmountOut', type: 'uint256' },
  ],
} as const;

export class MissingPlanSignerKeyError extends Error {
  constructor() {
    super('createBagRouterPlanSigner: no private key provided — refusing to sign with an implicit/default key.');
    this.name = 'MissingPlanSignerKeyError';
  }
}

/**
 * Builds a real `BagRouterPlanSigner` from a raw EIP-712-signing private
 * key (`BAG_ROUTER_PLAN_SIGNER_KEY`). This key MUST correspond to the
 * `planSigner` address the deployed `BagExecutionRouter` was constructed
 * with (or later rotated to via `setPlanSigner`) — a mismatch fails closed
 * on-chain (`InvalidPlanSignature`), never silently.
 */
export function createBagRouterPlanSigner(privateKey: Hex): BagRouterPlanSigner {
  if (!privateKey) throw new MissingPlanSignerKeyError();
  const account = privateKeyToAccount(privateKey);

  return async function signPlan(plan: RouterExecutionPlan, chainId: number, router: Hex): Promise<Hex> {
    return account.signTypedData({
      domain: {
        name: 'BagExecutionRouter',
        version: '1',
        chainId,
        verifyingContract: router,
      },
      types: EIP712_TYPES,
      primaryType: 'ExecutionPlan',
      message: {
        bagId: plan.bagId,
        executionPlanHash: plan.executionPlanHash,
        wallet: plan.wallet,
        inputToken: plan.inputToken,
        inputAmount: plan.inputAmount,
        deadline: plan.deadline,
        legs: plan.legs,
        minOutputs: plan.minOutputs,
      },
    });
  };
}
