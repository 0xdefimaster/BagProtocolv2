import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getAddress } from 'viem';
import type { FeeAttestation } from '@/lib/server/redeem-fee-attestation';

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
}));

vi.mock('../wallet-sweep-client', () => ({ executeWalletTransactionWithApprovals: mocks.execute }));

import { buildRedeemTransactionPlan, collectRequiredApprovals, sendRedeemTransaction } from '../redeem-fee-router-client';

const WALLET = '0x49da00000000000000000000000000000000fe46' as const;
const CREATOR = '0x49da00000000000000000000000000000000fe47' as const;
const ROUTER = '0x49da00000000000000000000000000000000fe48' as const;
const TOKEN_A = '0x00000000000000000000000000000000000000a1' as const;
const TOKEN_B = '0x00000000000000000000000000000000000000b2' as const;
const TX_HASH = `0x${'5'.repeat(64)}` as const;

const attestation: FeeAttestation = {
  redemptionId: `0x${'1'.repeat(64)}`,
  user: WALLET,
  creator: CREATOR,
  legs: [
    { inputToken: TOKEN_A, inputAmount: '100', swapTarget: ROUTER, swapCallData: '0x1234' },
    { inputToken: getAddress(TOKEN_A), inputAmount: '25', swapTarget: ROUTER, swapCallData: '0x5678' },
    { inputToken: TOKEN_B, inputAmount: '300', swapTarget: ROUTER, swapCallData: '0x9abc' },
    { inputToken: '0x0000000000000000000000000000000000000000', inputAmount: '1', swapTarget: '0x0000000000000000000000000000000000000000', swapCallData: '0x' },
  ],
  feeAmount: '10',
  minUserProceeds: '500',
  deadline: 2_000_000_000,
  signature: `0x${'2'.repeat(130)}`,
  feeBreakdown: { method: 'B0_FLOOR', rateBps: 100, grossMinimumProceeds: '510', consumedBasis: '400', lossCarry: '0', feeBase: '110' },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.execute.mockResolvedValue({ txHash: TX_HASH, authorizationStrategy: 'EIP5792_ATOMIC_BATCH' });
});

describe('FeeRouter wallet execution plan', () => {
  it('aggregates duplicate token legs case-insensitively and skips the zero-address no-swap sentinel', () => {
    expect(collectRequiredApprovals(attestation)).toEqual([
      { token: TOKEN_A, amount: BigInt(125) },
      { token: TOKEN_B, amount: BigInt(300) },
    ]);
  });

  it('keeps the exact attested redeem call and adds exact approvals for the shared executor', async () => {
    const plan = buildRedeemTransactionPlan(ROUTER, attestation);
    expect(plan.transaction).toMatchObject({ to: ROUTER, value: '0', chainId: 4663 });
    expect(plan.transaction.data).toMatch(/^0x[0-9a-f]{8}/i);
    expect(plan.approvals).toEqual([
      { token: TOKEN_A, spender: ROUTER, amountRaw: '125' },
      { token: TOKEN_B, spender: ROUTER, amountRaw: '300' },
    ]);

    const result = await sendRedeemTransaction(ROUTER, WALLET, attestation);
    expect(mocks.execute).toHaveBeenCalledWith(WALLET, plan, expect.any(Function), { confirmationLabel: 'redemption' });
    expect(result).toEqual({ txHash: TX_HASH, confirmed: true, authorizationStrategy: 'EIP5792_ATOMIC_BATCH' });
  });
});
