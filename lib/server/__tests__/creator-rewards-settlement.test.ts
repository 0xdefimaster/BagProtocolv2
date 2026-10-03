import { describe, it, expect, vi } from 'vitest';
import {
  runSettlementBatch,
  reconcileStuckSubmissions,
  deterministicRefId,
  type RewardSettlementRepo,
  type RewardSettlementRow,
  type VaultChainClient,
} from '../creator-rewards-settlement';
import { ROBINHOOD_CHAIN_ID } from '@/lib/config/robinhood-chain';

const NOW = 1_700_000_000_000;

function makeRow(overrides: Partial<RewardSettlementRow> = {}): RewardSettlementRow {
  return {
    id: 'row-1',
    creatorId: 'creator-uuid-1',
    creatorWallet: '0x000000000000000000000000000000000000aa',
    grossAmountQuote: '17.13',
    status: 'PENDING_SETTLEMENT',
    attemptCount: 1,
    settlementRefId: null,
    onchainTxHash: null,
    updatedAtMs: NOW,
    ...overrides,
  };
}

function makeFakeRepo(rows: RewardSettlementRow[]) {
  const state = new Map(rows.map((r) => [r.id, { ...r }]));
  const calls: { markSubmitted: unknown[]; markConfirmed: unknown[]; markFailed: unknown[]; markSubmittedRetryable: unknown[] } = {
    markSubmitted: [],
    markConfirmed: [],
    markFailed: [],
    markSubmittedRetryable: [],
  };
  const repo: RewardSettlementRepo = {
    async claimBatch(_workerId, limit) {
      return [...state.values()].filter((r) => r.status === 'EARNED' || r.status === 'RETRYABLE').slice(0, limit);
    },
    async markSubmitted(id, refId, txHash) {
      calls.markSubmitted.push({ id, refId, txHash });
      const row = state.get(id)!;
      row.status = 'SUBMITTED';
      row.settlementRefId = refId;
      row.onchainTxHash = txHash;
    },
    async markConfirmed(id) {
      calls.markConfirmed.push({ id });
      state.get(id)!.status = 'CONFIRMED';
    },
    async markFailed(id, reason, retryable) {
      calls.markFailed.push({ id, reason, retryable });
      state.get(id)!.status = retryable ? 'RETRYABLE' : 'FAILED';
    },
    async getStuckSubmitted(olderThanMs) {
      const cutoff = NOW - olderThanMs;
      return [...state.values()].filter((r) => r.status === 'SUBMITTED' && r.updatedAtMs <= cutoff);
    },
    async markSubmittedRetryable(id, reason) {
      calls.markSubmittedRetryable.push({ id, reason });
      const row = state.get(id)!;
      if (row.status !== 'SUBMITTED') return;
      row.status = 'RETRYABLE';
    },
  };
  return { repo, state, calls };
}

function makeChain(overrides: Partial<VaultChainClient> = {}): VaultChainClient {
  return {
    chainId: ROBINHOOD_CHAIN_ID,
    settleReward: vi.fn(),
    isRefUsed: vi.fn().mockResolvedValue(false),
    ...overrides,
  };
}

describe('deterministicRefId', () => {
  it('is a pure function of the row id — same input, same output, always', () => {
    expect(deterministicRefId('row-1')).toBe(deterministicRefId('row-1'));
  });

  it('differs across different row ids (no accidental collisions for adjacent ids)', () => {
    expect(deterministicRefId('row-1')).not.toBe(deterministicRefId('row-2'));
  });
});

describe('runSettlementBatch', () => {
  it('fails closed if the connected chain is not Robinhood Chain mainnet', async () => {
    const { repo } = makeFakeRepo([makeRow({ status: 'EARNED' })]);
    const chain = makeChain({ chainId: 999 });
    await expect(runSettlementBatch(repo, chain, 'worker-1')).rejects.toThrow(/Robinhood Chain mainnet/);
    expect(chain.settleReward).not.toHaveBeenCalled();
  });

  it('happy path: settles one EARNED row, marks it SUBMITTED then CONFIRMED', async () => {
    const { repo, state } = makeFakeRepo([makeRow({ status: 'EARNED' })]);
    const settleReward = vi.fn().mockResolvedValue({ txHash: '0xabc' });
    const chain = makeChain({ settleReward });

    const result = await runSettlementBatch(repo, chain, 'worker-1');

    expect(result.processed).toBe(1);
    expect(result.confirmed).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.errors).toEqual([]);
    expect(state.get('row-1')!.status).toBe('CONFIRMED');
    expect(settleReward).toHaveBeenCalledWith({
      creator: '0x000000000000000000000000000000000000aa',
      amountRaw: BigInt(17_130_000),
      refId: deterministicRefId('row-1'),
    });
  });

  it('never invents an amount for a malformed money value — marks FAILED (non-retryable) instead of guessing', async () => {
    const { repo, state, calls } = makeFakeRepo([makeRow({ status: 'EARNED', grossAmountQuote: 'not-a-number' })]);
    const settleReward = vi.fn();
    const chain = makeChain({ settleReward });

    const result = await runSettlementBatch(repo, chain, 'worker-1');

    expect(settleReward).not.toHaveBeenCalled();
    expect(state.get('row-1')!.status).toBe('FAILED');
    expect(result.failed).toBe(1);
    expect(calls.markFailed[0]).toMatchObject({ retryable: false });
  });

  it('RPC timeout / transient error: marks RETRYABLE, not permanently FAILED', async () => {
    const { repo, state } = makeFakeRepo([makeRow({ status: 'EARNED' })]);
    const chain = makeChain({ settleReward: vi.fn().mockRejectedValue(new Error('ETIMEDOUT: connect timeout')) });

    await runSettlementBatch(repo, chain, 'worker-1');
    expect(state.get('row-1')!.status).toBe('RETRYABLE');
  });

  it('a real on-chain revert unrelated to timing (e.g. insufficient settler allowance) is FAILED, not RETRYABLE-forever', async () => {
    const { repo, state } = makeFakeRepo([makeRow({ status: 'EARNED' })]);
    const chain = makeChain({ settleReward: vi.fn().mockRejectedValue(new Error('execution reverted: ERC20InsufficientAllowance')) });

    await runSettlementBatch(repo, chain, 'worker-1');
    expect(state.get('row-1')!.status).toBe('FAILED');
  });

  it('CRITICAL — worker crashes after the on-chain tx actually landed: a retry that hits RefAlreadyUsed is treated as CONFIRMED, never re-marked as a failure or resubmitted again', async () => {
    const { repo, state } = makeFakeRepo([makeRow({ status: 'RETRYABLE', attemptCount: 2 })]);
    const chain = makeChain({ settleReward: vi.fn().mockRejectedValue(new Error('execution reverted: RefAlreadyUsed(0x1234)')) });

    const result = await runSettlementBatch(repo, chain, 'worker-2');

    expect(state.get('row-1')!.status).toBe('CONFIRMED');
    expect(result.confirmed).toBe(1);
    expect(result.failed).toBe(0);
  });

  it('CRITICAL — never double-pays: retrying an already-CONFIRMED row is simply not picked up by claimBatch again', async () => {
    const { repo, state } = makeFakeRepo([makeRow({ status: 'CONFIRMED' })]);
    const settleReward = vi.fn();
    const chain = makeChain({ settleReward });

    const result = await runSettlementBatch(repo, chain, 'worker-1');

    expect(settleReward).not.toHaveBeenCalled();
    expect(result.processed).toBe(0);
    expect(state.get('row-1')!.status).toBe('CONFIRMED');
  });

  it('two concurrent workers processing the SAME claimed batch never both submit for the same row (repo-level dedup is the real guarantee; this proves the worker cooperates with it)', async () => {
    const { repo, state } = makeFakeRepo([makeRow({ status: 'EARNED' })]);
    const settleReward = vi.fn().mockResolvedValue({ txHash: '0xabc' });
    const chain = makeChain({ settleReward });

    await runSettlementBatch(repo, chain, 'worker-1');
    const secondRun = await runSettlementBatch(repo, chain, 'worker-2');

    expect(secondRun.processed).toBe(0);
    expect(settleReward).toHaveBeenCalledTimes(1);
    expect(state.get('row-1')!.status).toBe('CONFIRMED');
  });

  it('processes a full batch, isolating one bad row failure from the rest of the batch', async () => {
    const { repo, state } = makeFakeRepo([
      makeRow({ id: 'row-good-1', status: 'EARNED', grossAmountQuote: '10' }),
      makeRow({ id: 'row-bad', status: 'EARNED', grossAmountQuote: 'garbage' }),
      makeRow({ id: 'row-good-2', status: 'EARNED', grossAmountQuote: '5' }),
    ]);
    const chain = makeChain({ settleReward: vi.fn().mockResolvedValue({ txHash: '0xabc' }) });

    const result = await runSettlementBatch(repo, chain, 'worker-1');

    expect(result.processed).toBe(3);
    expect(result.confirmed).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.errors).toEqual([{ rowId: 'row-bad', error: expect.stringContaining('invalid grossAmountQuote') }]);
    expect(state.get('row-good-1')!.status).toBe('CONFIRMED');
    expect(state.get('row-good-2')!.status).toBe('CONFIRMED');
    expect(state.get('row-bad')!.status).toBe('FAILED');
  });

  it('P0 CRASH RECOVERY — runs reconciliation first and reports it in the result, before claiming any new batch', async () => {
    const { repo, state } = makeFakeRepo([
      makeRow({ id: 'stuck-confirmed', status: 'SUBMITTED', settlementRefId: '0xaaa', updatedAtMs: NOW - 999_999_999 }),
      makeRow({ id: 'new-earned', status: 'EARNED', grossAmountQuote: '3' }),
    ]);
    const isRefUsed = vi.fn(async (refId: string) => refId === '0xaaa');
    const chain = makeChain({ isRefUsed, settleReward: vi.fn().mockResolvedValue({ txHash: '0xnew' }) });

    const result = await runSettlementBatch(repo, chain, 'worker-1');

    expect(result.reconciliation).toEqual({ checked: 1, confirmed: 1, markedRetryable: 0 });
    expect(state.get('stuck-confirmed')!.status).toBe('CONFIRMED');
    expect(state.get('new-earned')!.status).toBe('CONFIRMED');
  });
});

describe('reconcileStuckSubmissions — P0 settlement crash-recovery bug', () => {
  it('fails closed if the connected chain is not Robinhood Chain mainnet', async () => {
    const { repo } = makeFakeRepo([]);
    const chain = makeChain({ chainId: 999 });
    await expect(reconcileStuckSubmissions(repo, chain)).rejects.toThrow(/Robinhood Chain mainnet/);
  });

  it('CASE A — refUsed is true on-chain: SUBMITTED -> CONFIRMED, never resubmitted', async () => {
    const { repo, state } = makeFakeRepo([
      makeRow({ id: 'row-a', status: 'SUBMITTED', settlementRefId: '0x1', updatedAtMs: NOW - 999_999_999 }),
    ]);
    const chain = makeChain({ isRefUsed: vi.fn().mockResolvedValue(true) });

    const result = await reconcileStuckSubmissions(repo, chain);

    expect(result).toEqual({ checked: 1, confirmed: 1, markedRetryable: 0 });
    expect(state.get('row-a')!.status).toBe('CONFIRMED');
  });

  it('CASE B — a SUBMITTED row younger than the staleness threshold is left alone entirely (not even fetched)', async () => {
    const { repo, state, calls } = makeFakeRepo([
      makeRow({ id: 'row-b', status: 'SUBMITTED', settlementRefId: '0x2', updatedAtMs: NOW - 1000 }),
    ]);
    const chain = makeChain();

    const result = await reconcileStuckSubmissions(repo, chain, 15 * 60 * 1000);

    expect(result).toEqual({ checked: 0, confirmed: 0, markedRetryable: 0 });
    expect(state.get('row-b')!.status).toBe('SUBMITTED');
    expect(calls.markSubmittedRetryable).toEqual([]);
  });

  it('CASE C/D — refUsed is false past the staleness threshold: SUBMITTED -> RETRYABLE, safe to resubmit later', async () => {
    const { repo, state } = makeFakeRepo([
      makeRow({ id: 'row-c', status: 'SUBMITTED', settlementRefId: '0x3', updatedAtMs: NOW - 999_999_999 }),
    ]);
    const chain = makeChain({ isRefUsed: vi.fn().mockResolvedValue(false) });

    const result = await reconcileStuckSubmissions(repo, chain);

    expect(result).toEqual({ checked: 1, confirmed: 0, markedRetryable: 1 });
    expect(state.get('row-c')!.status).toBe('RETRYABLE');
  });

  it('CASE E — SUBMITTED with no settlement_ref_id recorded at all: treated as safe-to-retry without even calling the chain', async () => {
    const { repo, state } = makeFakeRepo([
      makeRow({ id: 'row-e', status: 'SUBMITTED', settlementRefId: null, updatedAtMs: NOW - 999_999_999 }),
    ]);
    const isRefUsed = vi.fn();
    const chain = makeChain({ isRefUsed });

    const result = await reconcileStuckSubmissions(repo, chain);

    expect(isRefUsed).not.toHaveBeenCalled();
    expect(result).toEqual({ checked: 1, confirmed: 0, markedRetryable: 1 });
    expect(state.get('row-e')!.status).toBe('RETRYABLE');
  });

  it('never calls settleReward itself — pure reconciliation, resubmission happens on the NEXT runSettlementBatch via the normal RETRYABLE path', async () => {
    const { repo } = makeFakeRepo([
      makeRow({ id: 'row-f', status: 'SUBMITTED', settlementRefId: '0x4', updatedAtMs: NOW - 999_999_999 }),
    ]);
    const settleReward = vi.fn();
    const chain = makeChain({ isRefUsed: vi.fn().mockResolvedValue(false), settleReward });

    await reconcileStuckSubmissions(repo, chain);

    expect(settleReward).not.toHaveBeenCalled();
  });

  it('handles a mix of confirmed and retryable stuck rows in one pass', async () => {
    const { repo, state } = makeFakeRepo([
      makeRow({ id: 'row-g1', status: 'SUBMITTED', settlementRefId: '0xg1', updatedAtMs: NOW - 999_999_999 }),
      makeRow({ id: 'row-g2', status: 'SUBMITTED', settlementRefId: '0xg2', updatedAtMs: NOW - 999_999_999 }),
    ]);
    const isRefUsed = vi.fn(async (refId: string) => refId === '0xg1');
    const chain = makeChain({ isRefUsed });

    const result = await reconcileStuckSubmissions(repo, chain);

    expect(result).toEqual({ checked: 2, confirmed: 1, markedRetryable: 1 });
    expect(state.get('row-g1')!.status).toBe('CONFIRMED');
    expect(state.get('row-g2')!.status).toBe('RETRYABLE');
  });
});
