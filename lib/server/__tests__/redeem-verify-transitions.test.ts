import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RedeemIntent, RedeemIntentStepRecord } from '@/types/redeem-intent';

// A sale whose legs had already confirmed by the FIRST verify reaches the
// "all legs completed" branch straight from SUBMITTED. The state machine only
// allows COMPLETED from CONFIRMING, so verifyRedeemExecution must step
// through CONFIRMING (before accounting) instead of throwing
// SUBMITTED -> COMPLETED — the same bug a live Composer purchase hit.

const getRedeemIntentForUserMock = vi.fn();
const updateRedeemIntentStatusMock = vi.fn();
const updateRedeemIntentStepsMock = vi.fn();
const markRedeemAccountingAppliedMock = vi.fn();
const trackStepStatusMock = vi.fn();

vi.mock('@/lib/server/redeem-intent-repo', async () => {
  const { assertValidPurchaseIntentTransition } = await vi.importActual<typeof import('@/lib/domain/basket-protocol/purchase-intent/state-machine')>(
    '@/lib/domain/basket-protocol/purchase-intent/state-machine'
  );
  return {
    getRedeemIntentForUser: (...a: unknown[]) => getRedeemIntentForUserMock(...a),
    updateRedeemIntentStatus: (...a: unknown[]) => {
      const u = a[1] as { from: Parameters<typeof assertValidPurchaseIntentTransition>[0]; to: Parameters<typeof assertValidPurchaseIntentTransition>[1] };
      assertValidPurchaseIntentTransition(u.from, u.to); // the real repo asserts this too
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
vi.mock('@/lib/blockchain/lifi-status', () => ({ trackStepStatus: (...a: unknown[]) => trackStepStatusMock(...a) }));
vi.mock('@/lib/server/price-provider', () => ({ getPriceProvider: () => ({}) }));

const { verifyRedeemExecution } = await import('../redeem-execution');

const WALLET = '0x1111111111111111111111111111111111111111';
const NVDA = '0x2222222222222222222222222222222222222222';
const USDG = '0x3333333333333333333333333333333333333333';

function leg(): RedeemIntentStepRecord {
  return {
    stepIndex: 0,
    action: 'SWAP',
    targetSymbol: 'NVDA',
    inputAsset: { chain: 'robinhood', address: NVDA },
    outputAsset: { chain: 'robinhood', address: USDG },
    sourceChain: 'robinhood',
    destinationChain: 'robinhood',
    inputAmountRaw: '1000',
    targetValueRaw: '1000',
    outputAmountRaw: '990',
    outputDecimals: 6,
    minOutputRaw: '980',
    route: 'uniswap',
    lifiStep: null,
    status: 'SUBMITTED',
    approvalTxHash: null,
    txHash: `0x${'ab'.repeat(32)}`,
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
    redeemValueQuote: '1',
    steps: [leg()],
    composerTransaction: null,
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

beforeEach(() => {
  vi.clearAllMocks();
});

describe('verifyRedeemExecution — a sale already confirmed at the first verify', () => {
  it('goes SUBMITTED -> CONFIRMING -> COMPLETED, applying accounting in between', async () => {
    let row = intent();
    getRedeemIntentForUserMock.mockResolvedValue({ ok: true, intent: row });
    trackStepStatusMock.mockResolvedValue({ kind: 'DONE', receivedAsset: { chain: 'robinhood', address: USDG }, receivedAmountRaw: '990', matchesExpectedAsset: true });
    updateRedeemIntentStepsMock.mockImplementation(async (_a: unknown, _id: string, _st: string, steps: RedeemIntentStepRecord[]) => (row = { ...row, steps }));
    updateRedeemIntentStatusMock.mockImplementation(async (_a: unknown, u: { to: RedeemIntent['status'] }) => (row = { ...row, status: u.to }));
    const rpc = vi.fn(async (name: string) => (name === 'claim_intent_tx_hash' ? { data: true, error: null } : { data: null, error: null }));

    const outcome = await verifyRedeemExecution({ rpc } as never, { userId: 'user_1', walletAddress: WALLET } as never, 'redeem_1');

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.status).toBe('COMPLETED');
    expect(updateRedeemIntentStatusMock.mock.calls.map((c) => [(c[1] as { from: string }).from, (c[1] as { to: string }).to])).toEqual([
      ['SUBMITTED', 'CONFIRMING'],
      ['CONFIRMING', 'COMPLETED'],
    ]);
    expect(rpc).toHaveBeenCalledWith('apply_redeem_execution', expect.objectContaining({ p_intent_id: 'redeem_1' }));
    expect(markRedeemAccountingAppliedMock).toHaveBeenCalledWith(expect.anything(), 'redeem_1');
  });
});
