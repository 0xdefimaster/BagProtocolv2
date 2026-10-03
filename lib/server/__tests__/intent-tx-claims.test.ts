import { describe, expect, it, vi } from 'vitest';
import { claimNewlyVerifiedTxHashes } from '../intent-tx-claims';

type Step = { status: string; txHash: string | null; sourceChain: 'robinhood'; failureCode?: string };

const TX_A = `0x${'aa'.repeat(32)}`;
const TX_B = `0x${'bb'.repeat(32)}`;
const fail = (s: Step): Step => ({ ...s, status: 'FAILED', failureCode: 'VERIFICATION_FAILED' });

describe('claimNewlyVerifiedTxHashes', () => {
  it('claims only steps that became COMPLETED in this pass', async () => {
    const rpc = vi.fn(async () => ({ data: true, error: null }));
    const before: Step[] = [
      { status: 'SUBMITTED', txHash: TX_A, sourceChain: 'robinhood' },
      { status: 'COMPLETED', txHash: TX_B, sourceChain: 'robinhood' },
      { status: 'SUBMITTED', txHash: TX_B, sourceChain: 'robinhood' },
    ];
    const after: Step[] = [
      { ...before[0], status: 'COMPLETED' },
      before[1],
      { ...before[2], status: 'CONFIRMING' },
    ];

    const result = await claimNewlyVerifiedTxHashes({ rpc } as never, 'REDEEM', 'intent_1', before, after, fail);

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('claim_intent_tx_hash', {
      p_chain: 'robinhood',
      p_tx_hash: TX_A,
      p_intent_kind: 'REDEEM',
      p_intent_id: 'intent_1',
    });
    expect(result).toEqual(after);
  });

  it('turns a verified step into a failure when another intent already owns its hash', async () => {
    const rpc = vi.fn(async () => ({ data: false, error: null }));
    const before: Step[] = [{ status: 'SUBMITTED', txHash: TX_A, sourceChain: 'robinhood' }];
    const after: Step[] = [{ ...before[0], status: 'COMPLETED' }];

    const result = await claimNewlyVerifiedTxHashes({ rpc } as never, 'PURCHASE', 'intent_2', before, after, fail);

    expect(result[0]).toMatchObject({ status: 'FAILED', failureCode: 'VERIFICATION_FAILED' });
  });

  it('never swallows a database error', async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { message: 'boom' } }));
    const before: Step[] = [{ status: 'SUBMITTED', txHash: TX_A, sourceChain: 'robinhood' }];
    const after: Step[] = [{ ...before[0], status: 'COMPLETED' }];

    await expect(claimNewlyVerifiedTxHashes({ rpc } as never, 'PURCHASE', 'i', before, after, fail)).rejects.toThrow(/boom/);
  });
});
