import type { PublicClient } from 'viem';

// -----------------------------------------------------------------------------
// How much native ETH a transaction delivered to a wallet. ETH has no Transfer log, so it is measured from the
// wallet's balance around the transaction's block, with the network fee the wallet paid added back:
//
//   received = balance(block) − balance(block − 1) + gasUsed × effectiveGasPrice + value sent
//
// That is exact when this is the wallet's only activity in the block. Two guards keep anything else from being
// booked as proceeds:
//   - the wallet sent exactly one transaction in the block (its nonce moved by one), or nothing is trusted;
//   - the result is clamped into [guaranteed minimum, expected × (1 + EXPECTED_TOLERANCE_BPS)]: the minimum is what
//     the Composer transaction enforces on chain (it reverts below it), and a value far above what was quoted can
//     only come from an unrelated transfer in the same block.
// On Arbitrum Orbit chains (Robinhood Chain) gasUsed already includes the L1 data component, so the fee is complete.
// -----------------------------------------------------------------------------

/** Up to this much above the quoted amount is accepted as positive slippage; beyond it, the quote's bound is booked. */
export const EXPECTED_TOLERANCE_BPS = BigInt(200);

export type NativeReceived =
  | { ok: true; receivedRaw: bigint; measuredRaw: bigint; clamped: 'NONE' | 'TO_MINIMUM' | 'TO_EXPECTED' }
  | { ok: false; reason: 'OTHER_ACTIVITY_IN_BLOCK' | 'BELOW_MINIMUM_UNVERIFIED' };

export async function measureNativeReceived(
  client: Pick<PublicClient, 'getTransactionReceipt' | 'getTransaction' | 'getBalance' | 'getTransactionCount'>,
  input: { txHash: `0x${string}`; wallet: `0x${string}`; expectedRaw: bigint; minimumRaw: bigint }
): Promise<NativeReceived> {
  const [receipt, tx] = await Promise.all([client.getTransactionReceipt({ hash: input.txHash }), client.getTransaction({ hash: input.txHash })]);
  const block = receipt.blockNumber;
  const [after, before, nonceAfter, nonceBefore] = await Promise.all([
    client.getBalance({ address: input.wallet, blockNumber: block }),
    client.getBalance({ address: input.wallet, blockNumber: block - BigInt(1) }),
    client.getTransactionCount({ address: input.wallet, blockNumber: block }),
    client.getTransactionCount({ address: input.wallet, blockNumber: block - BigInt(1) }),
  ]);
  if (nonceAfter - nonceBefore !== 1) return { ok: false, reason: 'OTHER_ACTIVITY_IN_BLOCK' };

  const fee = receipt.gasUsed * receipt.effectiveGasPrice;
  const measured = after - before + fee + tx.value;
  const ceiling = input.expectedRaw + (input.expectedRaw * EXPECTED_TOLERANCE_BPS) / BigInt(10_000);
  if (measured < input.minimumRaw) {
    // The transaction succeeded, so Composer delivered at least the minimum; something else moved ETH out in the block.
    return input.minimumRaw > BigInt(0)
      ? { ok: true, receivedRaw: input.minimumRaw, measuredRaw: measured, clamped: 'TO_MINIMUM' }
      : { ok: false, reason: 'BELOW_MINIMUM_UNVERIFIED' };
  }
  if (input.expectedRaw > BigInt(0) && measured > ceiling) return { ok: true, receivedRaw: ceiling, measuredRaw: measured, clamped: 'TO_EXPECTED' };
  return { ok: true, receivedRaw: measured, measuredRaw: measured, clamped: 'NONE' };
}
