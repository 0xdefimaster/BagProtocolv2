import { describe, expect, it } from 'vitest';
import { measureNativeReceived } from '../native-received';

// A fake chain around one block: balances and nonces before (block 99) and after (block 100).
function chain(o: { before: bigint; after: bigint; nonceBefore?: number; nonceAfter?: number; gasUsed?: bigint; gasPrice?: bigint; value?: bigint }) {
  return {
    getTransactionReceipt: async () => ({ blockNumber: BigInt(100), gasUsed: o.gasUsed ?? BigInt(200_000), effectiveGasPrice: o.gasPrice ?? BigInt(10) }),
    getTransaction: async () => ({ value: o.value ?? BigInt(0) }),
    getBalance: async ({ blockNumber }: { blockNumber: bigint }) => (blockNumber === BigInt(100) ? o.after : o.before),
    getTransactionCount: async ({ blockNumber }: { blockNumber: bigint }) => (blockNumber === BigInt(100) ? (o.nonceAfter ?? 8) : (o.nonceBefore ?? 7)),
  } as never;
}
const input = { txHash: `0x${'ab'.repeat(32)}` as `0x${string}`, wallet: `0x${'11'.repeat(20)}` as `0x${string}`, expectedRaw: BigInt(1_000_000), minimumRaw: BigInt(990_000) };

describe('measureNativeReceived', () => {
  it('balance after − before + the fee the wallet paid (gasUsed × effectiveGasPrice)', async () => {
    // +998,000 net after paying 2,000,000 wei of gas → 1,000,000 received... with these small numbers:
    const r = await measureNativeReceived(chain({ before: BigInt(5_000_000), after: BigInt(3_998_000), gasUsed: BigInt(200_000), gasPrice: BigInt(10) }), {
      ...input,
      expectedRaw: BigInt(1_000_000),
      minimumRaw: BigInt(0),
    });
    // 3,998,000 − 5,000,000 + 2,000,000 = 998,000
    expect(r).toEqual({ ok: true, receivedRaw: BigInt(998_000), measuredRaw: BigInt(998_000), clamped: 'NONE' });
  });

  it('positive slippage within 2% of the quote is booked as measured', async () => {
    const r = await measureNativeReceived(chain({ before: BigInt(0), after: BigInt(1_015_000), gasUsed: BigInt(0) }), input);
    expect(r).toMatchObject({ ok: true, receivedRaw: BigInt(1_015_000), clamped: 'NONE' });
  });

  it('far above the quote (an unrelated transfer in the same block): only the quote + 2% is booked', async () => {
    const r = await measureNativeReceived(chain({ before: BigInt(0), after: BigInt(5_000_000), gasUsed: BigInt(0) }), input);
    expect(r).toEqual({ ok: true, receivedRaw: BigInt(1_020_000), measuredRaw: BigInt(5_000_000), clamped: 'TO_EXPECTED' });
  });

  it('below the guaranteed minimum (ETH moved out in the same block): the on-chain minimum is booked', async () => {
    const r = await measureNativeReceived(chain({ before: BigInt(0), after: BigInt(500_000), gasUsed: BigInt(0) }), input);
    expect(r).toMatchObject({ ok: true, receivedRaw: BigInt(990_000), clamped: 'TO_MINIMUM' });
    // No enforced minimum and the wallet ended with less than it started: nothing can be booked.
    const none = await measureNativeReceived(chain({ before: BigInt(500_000), after: BigInt(0), gasUsed: BigInt(0) }), { ...input, minimumRaw: BigInt(0) });
    expect(none).toEqual({ ok: false, reason: 'BELOW_MINIMUM_UNVERIFIED' });
  });

  it('another transaction from the wallet in the same block: nothing is trusted', async () => {
    const r = await measureNativeReceived(chain({ before: BigInt(0), after: BigInt(1_000_000), nonceBefore: 7, nonceAfter: 9 }), input);
    expect(r).toEqual({ ok: false, reason: 'OTHER_ACTIVITY_IN_BLOCK' });
  });
});
