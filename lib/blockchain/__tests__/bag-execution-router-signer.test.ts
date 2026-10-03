import { describe, expect, it } from 'vitest';
import { recoverTypedDataAddress, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createBagRouterPlanSigner, MissingPlanSignerKeyError } from '../bag-execution-router-signer';
import type { RouterExecutionPlan } from '@/lib/execution/providers/bag-router-provider';

// -----------------------------------------------------------------------------
// No RPC needed — EIP-712 signing/recovery is pure crypto. What this proves:
//   1. The signature recovers to the signer's own address (basic sanity).
//   2. The domain/types/field-order exactly match
//      `BagExecutionRouter.sol`'s `EXECUTION_PLAN_TYPEHASH` — a mismatch
//      here would make `planSigner`'s real on-chain signature verification
//      (`ECDSA.recover` against the SAME typed-data digest) reject every
//      plan with `InvalidPlanSignature`, which no runtime test in this
//      sandbox (no RPC) could otherwise catch before production.
// -----------------------------------------------------------------------------

// Fresh throwaway key per run — no key literal lives in the repo.
const PRIVATE_KEY: Hex = generatePrivateKey();
const ROUTER: Hex = '0xa0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0';
const CHAIN_ID = 4663;

function samplePlan(): RouterExecutionPlan {
  return {
    bagId: `0x${'11'.repeat(32)}` as Hex,
    executionPlanHash: `0x${'22'.repeat(32)}` as Hex,
    wallet: '0x3333333333333333333333333333333333333333',
    inputToken: '0x4444444444444444444444444444444444444444',
    inputAmount: BigInt(1_000_000),
    deadline: BigInt(1_800_000_000),
    legs: [
      {
        target: '0x5555555555555555555555555555555555555555',
        callData: '0xabcdef',
        value: BigInt(0),
        approveToken: '0x4444444444444444444444444444444444444444',
        approveAmount: BigInt(1_000_000),
      },
    ],
    minOutputs: [{ token: '0x6666666666666666666666666666666666666666', minAmountOut: BigInt(900_000) }],
  };
}

describe('createBagRouterPlanSigner', () => {
  it('throws MissingPlanSignerKeyError when no key is given, never signing with an implicit default', () => {
    expect(() => createBagRouterPlanSigner('' as Hex)).toThrow(MissingPlanSignerKeyError);
  });

  it('produces a signature that recovers to the configured signer address', async () => {
    const account = privateKeyToAccount(PRIVATE_KEY);
    const signPlan = createBagRouterPlanSigner(PRIVATE_KEY);
    const plan = samplePlan();
    const signature = await signPlan(plan, CHAIN_ID, ROUTER);

    const recovered = await recoverTypedDataAddress({
      domain: { name: 'BagExecutionRouter', version: '1', chainId: CHAIN_ID, verifyingContract: ROUTER },
      types: {
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
      },
      primaryType: 'ExecutionPlan',
      message: plan,
      signature,
    });

    expect(recovered.toLowerCase()).toBe(account.address.toLowerCase());
  });

  it('produces a DIFFERENT signature for a different chainId — the domain must actually bind chainId', async () => {
    const signPlan = createBagRouterPlanSigner(PRIVATE_KEY);
    const plan = samplePlan();
    const sigMainnet = await signPlan(plan, 4663, ROUTER);
    const sigOther = await signPlan(plan, 1, ROUTER);
    expect(sigMainnet).not.toBe(sigOther);
  });

  it('produces a DIFFERENT signature for a different router (verifyingContract)', async () => {
    const signPlan = createBagRouterPlanSigner(PRIVATE_KEY);
    const plan = samplePlan();
    const otherRouter: Hex = '0x7777777777777777777777777777777777777777';
    const sigA = await signPlan(plan, CHAIN_ID, ROUTER);
    const sigB = await signPlan(plan, CHAIN_ID, otherRouter);
    expect(sigA).not.toBe(sigB);
  });
});
