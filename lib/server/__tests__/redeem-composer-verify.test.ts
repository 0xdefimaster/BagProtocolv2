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
    createRedeemIntent: vi.fn(),
    findActiveRedeemIntentForBag: vi.fn(),
  };
});
vi.mock('@/lib/server/bag-repo', () => ({
  getBagById: async () => ({ id: 'bag_1', creatorId: 'creator_1', performanceFeeBpsLocked: null }),
  getCurrentBagVersion: async () => ({ recipe: { performanceFeeBps: 0 } }),
}));
vi.mock('@/lib/blockchain/composer-status', () => ({ trackComposerTransaction: (...a: unknown[]) => trackComposerMock(...a) }));
vi.mock('@/lib/blockchain/lifi-status', () => ({ trackStepStatus: (...a: unknown[]) => trackStepStatusMock(...a) }));
vi.mock('@/lib/server/price-provider', () => ({ getPriceProvider: () => ({}) }));
vi.mock('@/lib/server/bag-nav-snapshots', () => ({ recordNavSnapshot: async () => undefined }));

const { verifyRedeemExecution } = await import('../redeem-execution');

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
