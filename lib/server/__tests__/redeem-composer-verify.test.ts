import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RedeemIntent, RedeemIntentStepRecord } from '@/types/redeem-intent';

// One-transaction (Composer) redemptions: one receipt covers every leg, so the legs complete or fail together,
// and accounting runs only when that exact transaction sold every leg in full and paid out the output token.

const getRedeemIntentForUserMock = vi.fn();
const updateRedeemIntentStatusMock = vi.fn();
const updateRedeemIntentStepsMock = vi.fn();
const markRedeemAccountingAppliedMock = vi.fn();
const trackComposerMock = vi.fn();
const trackStepStatusMock = vi.fn();
const readSettlementResultMock = vi.fn();
const recordRedeemSettlementResultMock = vi.fn();
const reopenMock = vi.fn();
const listUnmatchedMock = vi.fn(async (..._a: unknown[]) => [] as RedeemIntent[]);

vi.mock('@/lib/server/redeem-intent-repo', async () => {
  const { assertValidPurchaseIntentTransition } = await vi.importActual<typeof import('@/lib/domain/basket-protocol/purchase-intent/state-machine')>(
    '@/lib/domain/basket-protocol/purchase-intent/state-machine'
  );
  return {
    getRedeemIntentForUser: (...a: unknown[]) => getRedeemIntentForUserMock(...a),
    updateRedeemIntentStatus: (...a: unknown[]) => {
      const u = a[1] as { from: Parameters<typeof assertValidPurchaseIntentTransition>[0]; to: Parameters<typeof assertValidPurchaseIntentTransition>[1] };
      assertValidPurchaseIntentTransition(u.from, u.to);
      return updateRedeemIntentStatusMock(...a);
    },
    updateRedeemIntentSteps: (...a: unknown[]) => updateRedeemIntentStepsMock(...a),
    markRedeemAccountingApplied: (...a: unknown[]) => markRedeemAccountingAppliedMock(...a),
    markRedeemReconciliationApplied: vi.fn(),
    recordRedeemSettlementResult: (...a: unknown[]) => recordRedeemSettlementResultMock(...a),
    createRedeemIntent: vi.fn(),
    findActiveRedeemIntentForBag: vi.fn(),
    reopenUnmatchedComposerRedeem: (...a: unknown[]) => reopenMock(...a),
    listUnmatchedComposerRedeems: (...a: unknown[]) => listUnmatchedMock(...a),
  };
});
vi.mock('@/lib/server/bag-repo', () => ({
  getBagById: async () => ({ id: 'bag_1', creatorId: 'creator_1', performanceFeeBpsLocked: null }),
  getCurrentBagVersion: async () => ({ recipe: { performanceFeeBps: 0 } }),
}));
vi.mock('@/lib/blockchain/composer-status', () => ({ trackComposerTransaction: (...a: unknown[]) => trackComposerMock(...a) }));
let deployedSettlement: string | null = null;
vi.mock('@/lib/config/robinhood-chain', async (orig) => {
  const actual = await orig<typeof import('@/lib/config/robinhood-chain')>();
  return {
    ...actual,
    DEPLOYED_CONTRACTS: new Proxy(actual.DEPLOYED_CONTRACTS, {
      get: (t, k) => (k === 'redeemSettlement' ? deployedSettlement : Reflect.get(t, k)),
    }),
  };
});
vi.mock('@/lib/blockchain/redeem-settlement-event', () => ({ readSettlementResult: (...a: unknown[]) => readSettlementResultMock(...a) }));
vi.mock('@/lib/blockchain/lifi-status', () => ({ trackStepStatus: (...a: unknown[]) => trackStepStatusMock(...a) }));
vi.mock('@/lib/server/price-provider', () => ({ getPriceProvider: () => ({}) }));
vi.mock('@/lib/server/bag-nav-snapshots', () => ({ recordNavSnapshot: async () => undefined }));

const { verifyRedeemExecution, recheckUnmatchedComposerSales } = await import('../redeem-execution');

const WALLET = '0x1111111111111111111111111111111111111111';
const MSFT = '0x2222222222222222222222222222222222222222';
const NVDA = '0x4444444444444444444444444444444444444444';
const USDG = '0x3333333333333333333333333333333333333333';
const HASH = `0x${'ab'.repeat(32)}`;
const TX = { to: '0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae', data: '0xdeadbeef', value: '0', chainId: 4663, approvals: [] };

function leg(stepIndex: number, input: string, amount: string, simulated: string): RedeemIntentStepRecord {
  return {
    stepIndex,
    action: 'SWAP',
    targetSymbol: 'X',
    inputAsset: { chain: 'robinhood', address: input },
    outputAsset: { chain: 'robinhood', address: USDG },
    sourceChain: 'robinhood',
    destinationChain: 'robinhood',
    inputAmountRaw: amount,
    targetValueRaw: amount,
    outputAmountRaw: simulated,
    outputDecimals: 6,
    minOutputRaw: null,
    providerEnforcedMinOutputRaw: null,
    route: null,
    lifiStep: null,
    status: 'SUBMITTED',
    approvalTxHash: null,
    // Only the first report landed; the other leg still shares the one transaction.
    txHash: stepIndex === 0 ? HASH : null,
    providerSubstatus: null,
    failureCode: null,
  };
}

function intent(): RedeemIntent {
  return {
    id: 'redeem_1',
    userId: 'user_1',
    walletAddress: WALLET,
    bagId: 'bag_1',
    sharesRaw: '1000000000000000000',
    shareDecimals: 18,
    outputAsset: { chain: 'robinhood', address: USDG },
    outputDecimals: 6,
    routeFingerprint: 'fp',
    sharePriceAtQuote: '1',
    redeemValueQuote: '10',
    steps: [leg(0, MSFT, '1000', '6000000'), leg(1, NVDA, '2000', '4000000')],
    composerTransaction: TX,
    status: 'SUBMITTED',
    failureCode: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2099-01-01T00:00:00.000Z',
    executedAt: null,
    accountingAppliedAt: null,
    reconciliationAppliedAt: null,
  };
}

let row: RedeemIntent;
const rpc = vi.fn(async (name: string) => (name === 'claim_intent_tx_hash' ? { data: true, error: null } : { data: null, error: null }));
const verify = () => verifyRedeemExecution({ rpc } as never, { userId: 'user_1', walletAddress: WALLET } as never, 'redeem_1');

beforeEach(() => {
  vi.clearAllMocks();
  row = intent();
  getRedeemIntentForUserMock.mockImplementation(async () => ({ ok: true, intent: row }));
  updateRedeemIntentStepsMock.mockImplementation(async (_a: unknown, _id: string, _st: string, steps: RedeemIntentStepRecord[]) => (row = { ...row, steps }));
  updateRedeemIntentStatusMock.mockImplementation(async (_a: unknown, u: { to: RedeemIntent['status'] }) => (row = { ...row, status: u.to }));
  reopenMock.mockImplementation(async (_a: unknown, _id: string, steps: RedeemIntentStepRecord[]) => (row = { ...row, status: 'CONFIRMING', failureCode: null, steps }));
});

const accountingCall = () => rpc.mock.calls.find(([name]) => name === 'apply_redeem_execution') as unknown as [string, Record<string, unknown>] | undefined;

describe('verifyRedeemExecution — one-transaction (Composer) redemption', () => {
  it('checks the ONE transaction against exactly what was built, completes every leg, debits each leg input once', async () => {
    trackComposerMock.mockResolvedValue({
      kind: 'DONE',
      receivedAmountsByAddress: { [USDG]: '9900000' },
      sentAmountsByAddress: { [MSFT]: '1000', [NVDA]: '2000' },
    });
    const outcome = await verify();
    expect(outcome.ok && outcome.value.status).toBe('COMPLETED');
    expect(trackComposerMock).toHaveBeenCalledTimes(1);
    expect(trackComposerMock.mock.calls[0][0]).toMatchObject({ txHash: HASH, recipient: WALLET, expectedTransaction: TX });
    expect(trackStepStatusMock).not.toHaveBeenCalled();
    expect(row.steps.map((s) => [s.status, s.txHash, s.outputAmountRaw])).toEqual([
      ['COMPLETED', HASH, '5940000'],
      ['COMPLETED', HASH, '3960000'],
    ]);
    // A3: each sold leg carries what it actually returned (here: the received total split across legs).
    expect(accountingCall()?.[1].p_holdings_sold).toEqual([
      { chain: 'robinhood', address: MSFT, quantity_raw: '1000', proceeds_quote: '5.94' },
      { chain: 'robinhood', address: NVDA, quantity_raw: '2000', proceeds_quote: '3.96' },
    ]);
    expect(markRedeemAccountingAppliedMock).toHaveBeenCalledTimes(1);
  });

  it('a leg not sold in full fails the whole sale; nothing is burned', async () => {
    trackComposerMock.mockResolvedValue({ kind: 'DONE', receivedAmountsByAddress: { [USDG]: '9900000' }, sentAmountsByAddress: { [MSFT]: '1000', [NVDA]: '1999' } });
    const outcome = await verify();
    expect(outcome.ok && outcome.value.status).toBe('FAILED');
    expect(row.steps.every((s) => s.status === 'FAILED' && s.failureCode === 'VERIFICATION_FAILED')).toBe(true);
    expect(accountingCall()).toBeUndefined();
  });

  it('no output token received fails the sale; nothing is burned', async () => {
    trackComposerMock.mockResolvedValue({ kind: 'DONE', receivedAmountsByAddress: {}, sentAmountsByAddress: { [MSFT]: '1000', [NVDA]: '2000' } });
    const outcome = await verify();
    expect(outcome.ok && outcome.value.status).toBe('FAILED');
    expect(accountingCall()).toBeUndefined();
  });

  it('a different / reverted transaction fails the sale', async () => {
    trackComposerMock.mockResolvedValue({ kind: 'FAILED', failureCode: 'VERIFICATION_FAILED', message: 'mismatch' });
    const outcome = await verify();
    expect(outcome.ok && outcome.value.status).toBe('FAILED');
    expect(accountingCall()).toBeUndefined();
  });

  it('not mined yet: every leg is CONFIRMING, nothing applied', async () => {
    trackComposerMock.mockResolvedValue({ kind: 'PENDING' });
    const outcome = await verify();
    expect(outcome.ok && outcome.value.status).toBe('CONFIRMING');
    expect(row.steps.every((s) => s.status === 'CONFIRMING')).toBe(true);
    expect(accountingCall()).toBeUndefined();
  });
});

describe('verifyRedeemExecution — fee-paying sale settled through RedeemSettlement', () => {
  const SETTLEMENT = '0x5555555555555555555555555555555555555555';
  const CREATOR = '0x6666666666666666666666666666666666666666';
  const ID = '6f1c2b3a-0000-4000-8000-0000000000c1';

  function settledIntent(): RedeemIntent {
    return {
      ...intent(),
      id: ID,
      settlementPlan: {
        settlement: SETTLEMENT,
        creator: CREATOR,
        contextHash: `0x${'cd'.repeat(32)}`,
        attestedAt: '2026-01-01T00:00:00.000Z',
        deadline: 4102444800,
      } as unknown as RedeemIntent['settlementPlan'],
    };
  }

  const ROOT = '0x4444444444444444444444444444444444444444';
  const settled = (over: Record<string, string | null> = {}) => ({
    txHash: HASH,
    blockNumber: '123',
    logIndex: '4',
    redemptionId: '0x',
    user: WALLET,
    creator: CREATOR,
    executor: '0x7777777777777777777777777777777777777777',
    contextHash: `0x${'cd'.repeat(32)}`,
    received: '10000000',
    feeBase: '1000000',
    fee: '200000',
    userProceeds: '9800000',
    royalty: '0',
    rootCreator: null,
    ...over,
  });

  beforeEach(() => {
    row = settledIntent();
    deployedSettlement = SETTLEMENT;
    // What the tracker saw arrive in the wallet; the Settled event, not this, is what accounting books.
    trackComposerMock.mockResolvedValue({ kind: 'DONE', receivedAmountsByAddress: { [USDG]: '9800000' }, sentAmountsByAddress: { [MSFT]: '1000', [NVDA]: '2000' } });
  });

  it('books the Settled event: gross received per leg (the fee is ledgered by the RPC from the result), result recorded on the plan before accounting', async () => {
    readSettlementResultMock.mockResolvedValue(settled());
    const outcome = await verify();
    expect(outcome.ok && outcome.value.status).toBe('COMPLETED');
    const { computeOnChainBagId } = await import('@/lib/domain/basket-protocol/onchain');
    expect(readSettlementResultMock).toHaveBeenCalledWith(HASH, SETTLEMENT, computeOnChainBagId(ID));
    expect(row.steps.map((s) => s.outputAmountRaw)).toEqual(['6000000', '4000000']);
    expect(recordRedeemSettlementResultMock).toHaveBeenCalledTimes(1);
    const accountingAt = rpc.mock.invocationCallOrder[rpc.mock.calls.findIndex(([n]) => n === 'apply_redeem_execution')];
    expect(recordRedeemSettlementResultMock.mock.invocationCallOrder[0]).toBeLessThan(accountingAt);
    expect(recordRedeemSettlementResultMock.mock.calls[0][2].result).toEqual({
      txHash: HASH,
      blockNumber: '123',
      logIndex: '4',
      received: '10000000',
      feeBase: '1000000',
      fee: '200000',
      userProceeds: '9800000',
      creator: CREATOR,
      executor: '0x7777777777777777777777777777777777777777',
      royalty: '0',
      rootCreator: null,
    });
  });

  it('a fork sale: the royalty to the attested root creator is recorded with the result', async () => {
    row = { ...row, settlementPlan: { ...row.settlementPlan, rootCreator: ROOT } as RedeemIntent['settlementPlan'] };
    readSettlementResultMock.mockResolvedValue(settled({ royalty: '40000', rootCreator: ROOT }));
    const outcome = await verify();
    expect(outcome.ok && outcome.value.status).toBe('COMPLETED');
    expect(recordRedeemSettlementResultMock.mock.calls[0][2].result).toMatchObject({ fee: '200000', royalty: '40000', rootCreator: ROOT });
  });

  it.each([
    ['the plan attested no root creator', undefined],
    ['the plan attested another root creator', '0x3333333333333333333333333333333333333333'],
  ])('a royalty paid when %s: not verified, nothing booked', async (_name, attestedRoot) => {
    row = { ...row, settlementPlan: { ...row.settlementPlan, rootCreator: attestedRoot } as RedeemIntent['settlementPlan'] };
    readSettlementResultMock.mockResolvedValue(settled({ royalty: '40000', rootCreator: ROOT }));
    const outcome = await verify();
    expect(outcome.ok && outcome.value.status).toBe('FAILED');
    expect(accountingCall()).toBeUndefined();
    expect(recordRedeemSettlementResultMock).not.toHaveBeenCalled();
  });

  it('no Settled event for this redemption: not verified, nothing booked', async () => {
    readSettlementResultMock.mockResolvedValue(null);
    const outcome = await verify();
    expect(outcome.ok && outcome.value.status).toBe('FAILED');
    expect(row.steps.every((s) => s.failureCode === 'VERIFICATION_FAILED')).toBe(true);
    expect(accountingCall()).toBeUndefined();
    expect(recordRedeemSettlementResultMock).not.toHaveBeenCalled();
  });

  it('a Settled event paying someone else: not verified, nothing booked', async () => {
    readSettlementResultMock.mockResolvedValue(settled({ user: '0x8888888888888888888888888888888888888888' }));
    const outcome = await verify();
    expect(outcome.ok && outcome.value.status).toBe('FAILED');
    expect(accountingCall()).toBeUndefined();
  });

  it.each([
    ['another creator', { creator: '0x8888888888888888888888888888888888888888' }],
    ['another context', { contextHash: `0x${'ef'.repeat(32)}` }],
  ])('a Settled event for %s than attested: not verified, nothing booked', async (_name, over) => {
    readSettlementResultMock.mockResolvedValue(settled(over));
    const outcome = await verify();
    expect(outcome.ok && outcome.value.status).toBe('FAILED');
    expect(accountingCall()).toBeUndefined();
    expect(recordRedeemSettlementResultMock).not.toHaveBeenCalled();
  });

  it.each([
    ['RedeemSettlement is not configured', null],
    ['the configured RedeemSettlement is another contract than the plan\'s', '0x9999999999999999999999999999999999999999'],
  ])('%s: not verified, the receipt is not even read', async (_name, deployed) => {
    deployedSettlement = deployed;
    readSettlementResultMock.mockResolvedValue(settled());
    const outcome = await verify();
    expect(outcome.ok && outcome.value.status).toBe('FAILED');
    expect(readSettlementResultMock).not.toHaveBeenCalled();
    expect(accountingCall()).toBeUndefined();
  });

  it('a Composer sale without an attested plan never reads the event', async () => {
    row = intent();
    trackComposerMock.mockResolvedValue({ kind: 'DONE', receivedAmountsByAddress: { [USDG]: '9900000' }, sentAmountsByAddress: { [MSFT]: '1000', [NVDA]: '2000' } });
    await verify();
    expect(readSettlementResultMock).not.toHaveBeenCalled();
    expect(recordRedeemSettlementResultMock).not.toHaveBeenCalled();
  });
});

describe('verifyRedeemExecution — a sale refused as unmatched before wallet batches were recognised', () => {
  const failedUnmatched = (): RedeemIntent => ({
    ...intent(),
    status: 'FAILED',
    failureCode: 'VERIFICATION_FAILED',
    steps: intent().steps.map((s) => ({ ...s, status: 'FAILED' as const, failureCode: 'VERIFICATION_FAILED' as const, txHash: HASH })),
  });
  const done = { kind: 'DONE', receivedAmountsByAddress: { [USDG]: '9900000' }, sentAmountsByAddress: { [MSFT]: '1000', [NVDA]: '2000' } };

  it('re-checks the transaction; when it now matches (a wallet batch), the sale is reopened and booked once', async () => {
    row = failedUnmatched();
    trackComposerMock.mockResolvedValue(done);
    const outcome = await verify();
    expect(reopenMock).toHaveBeenCalledTimes(1);
    expect(reopenMock.mock.calls[0][2].map((s: RedeemIntentStepRecord) => [s.status, s.failureCode, s.txHash])).toEqual([
      ['CONFIRMING', null, HASH],
      ['CONFIRMING', null, HASH],
    ]);
    expect(outcome.ok && outcome.value.status).toBe('COMPLETED');
    expect(rpc.mock.calls.filter(([name]) => name === 'apply_redeem_execution')).toHaveLength(1);
    expect(rpc).toHaveBeenCalledWith('claim_intent_tx_hash', expect.anything());
  });

  it('stays FAILED when the transaction still does not match, or no longer sold the position in full', async () => {
    row = failedUnmatched();
    trackComposerMock.mockResolvedValue({ kind: 'FAILED', failureCode: 'VERIFICATION_FAILED', message: 'x' });
    expect((await verify()).ok && row.status).toBe('FAILED');
    expect(reopenMock).not.toHaveBeenCalled();

    row = failedUnmatched();
    trackComposerMock.mockResolvedValue({ ...done, sentAmountsByAddress: { [MSFT]: '1000' } });
    await verify();
    expect(row.status).toBe('FAILED');
    expect(accountingCall()).toBeUndefined();
  });

  it('recheckUnmatchedComposerSales books this user’s unmatched sales of the Bag and counts them; an error books nothing', async () => {
    row = failedUnmatched();
    listUnmatchedMock.mockResolvedValueOnce([row]);
    trackComposerMock.mockResolvedValue(done);
    const session = { userId: 'user_1', walletAddress: WALLET } as never;
    expect(await recheckUnmatchedComposerSales({ rpc } as never, session, 'bag_1')).toEqual({ booked: 1 });
    expect(listUnmatchedMock.mock.calls[0].slice(1, 3)).toEqual(['user_1', 'bag_1']);
    expect(row.status).toBe('COMPLETED');

    listUnmatchedMock.mockRejectedValueOnce(new Error('db down'));
    expect(await recheckUnmatchedComposerSales({ rpc } as never, session, 'bag_1')).toEqual({ booked: 0 });
  });

  it('never re-checks a sale that reverted, has no transaction, or had accounting applied', async () => {
    for (const r of [
      { ...failedUnmatched(), failureCode: 'TRANSACTION_REVERTED' as const },
      { ...failedUnmatched(), steps: failedUnmatched().steps.map((s) => ({ ...s, txHash: null })) },
      { ...failedUnmatched(), accountingAppliedAt: '2026-01-01T00:00:00.000Z' },
      { ...failedUnmatched(), composerTransaction: null },
    ]) {
      row = r;
      await verify();
      expect(row.status).toBe('FAILED');
    }
    expect(trackComposerMock).not.toHaveBeenCalled();
    expect(reopenMock).not.toHaveBeenCalled();
  });
});
