import { beforeEach, describe, expect, it, vi } from 'vitest';

// A4 on the sell path: a redemption sells a fraction of the EFFECTIVE holdings (tracked, limited by what the wallet
// really holds), refuses when balances cannot be read, and re-checks before signing that every leg is still there.

const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const MSFT = '0x00000000000000000000000000000000000000a1';
const WALLET = '0x1111111111111111111111111111111111111111';

const bagMock = vi.fn();
const insertMock = vi.fn();
const sequentialMock = vi.fn();
const sellableMock = vi.fn();
const getIntentMock = vi.fn();
const updateStatusMock = vi.fn();

vi.mock('@/lib/server/bag-repo', () => ({ getBagById: (...a: unknown[]) => bagMock(...a), getCurrentBagVersion: async () => ({ recipe: { performanceFeeBps: 0 } }) }));
vi.mock('@/lib/server/redeem-intent-repo', () => ({
  createRedeemIntent: (...a: unknown[]) => insertMock(...a),
  findActiveRedeemIntentForBag: async () => null,
  listLiveSettlementAttestations: async () => [],
  getRedeemIntentForUser: (...a: unknown[]) => getIntentMock(...a),
  updateRedeemIntentStatus: (...a: unknown[]) => updateStatusMock(...a),
  updateRedeemIntentSteps: vi.fn(),
  markRedeemAccountingApplied: vi.fn(),
  markRedeemReconciliationApplied: vi.fn(),
}));
vi.mock('@/lib/server/asset-repo', () => ({
  listAssets: async () => [
    { id: 'usdg', chain: 'robinhood', address: USDG, symbol: 'USDG', decimals: 6, status: 'VERIFIED' },
    { id: 'msft', chain: 'robinhood', address: MSFT, symbol: 'MSFT', decimals: 18, status: 'VERIFIED' },
  ],
}));
vi.mock('@/lib/server/payment-assets', () => ({ paymentAssetsFor: (assets: { symbol: string }[]) => assets.filter((a) => a.symbol === 'USDG') }));
vi.mock('@/lib/server/bag-nav', () => ({ getBagNavSafe: async () => ({ ok: false, reason: 'PRICE_UNAVAILABLE', message: 'weekend' }) }));
vi.mock('@/lib/server/bag-share-state-repo', () => ({ getShareSupply: async () => ({ shareDecimals: 18 }) }));
vi.mock('@/lib/server/bag-investor-position-repo', () => ({ getInvestorPosition: async () => ({ sharesRaw: '100', shareDecimals: 18 }) }));
vi.mock('@/lib/server/position-valuation', () => ({
  observeUserHoldings: async () => ({ rows: [{ bagId: 'bag_1' }] }),
  sellableHoldingsForBag: (...a: unknown[]) => sellableMock(...a),
}));
vi.mock('@/lib/blockchain/rpc/clients', () => ({ getChainPublicClient: () => ({}) }));
vi.mock('@/lib/server/price-provider', () => ({ getPriceProvider: () => ({}) }));
vi.mock('@/lib/blockchain/lifi-purchase-quote', async (orig) => ({ ...(await orig<object>()), buildPurchaseIntentSteps: (...a: unknown[]) => sequentialMock(...a) }));

const { createRedeemIntentForUser, prepareRedeemExecution, saleStillCovered } = await import('../redeem-execution');

const session = { userId: 'investor', walletAddress: WALLET } as never;
const create = (fractionBps: number) => createRedeemIntentForUser({ admin: {} as never, session, bagId: 'bag_1', fractionBps, outputAssetId: 'usdg' });
const sellable = (quantityRaw: string, sellableRaw: string) => [{ chain: 'robinhood', address: MSFT, decimals: 18, quantityRaw, sellableRaw }];

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('LIFI_API_KEY', '');
  bagMock.mockResolvedValue({ id: 'bag_1', chain: 'robinhood', creatorId: 'creator', performanceFeeBpsLocked: null });
  sellableMock.mockReturnValue(sellable('100', '100'));
  sequentialMock.mockImplementation(async (steps: { route: { inputAsset: unknown; inputAmountRaw: string } }[]) => ({
    steps: steps.map((s, i) => ({ stepIndex: i, action: 'SWAP', status: 'PENDING', inputAsset: s.route.inputAsset, inputAmountRaw: s.route.inputAmountRaw, outputAmountRaw: '41500000', minOutputRaw: '41000000' })),
    allSwapsQuoted: true,
    firstFailure: null,
  }));
  insertMock.mockImplementation(async (_a: unknown, input: Record<string, unknown>) => ({ id: 'r1', ...input }));
});

describe('createRedeemIntentForUser — A4', () => {
  it('drift (wallet 60 of tracked 100): a full exit quotes a sale of 60, never 100', async () => {
    sellableMock.mockReturnValue(sellable('100', '60'));
    const outcome = await create(10_000);
    expect(outcome.ok).toBe(true);
    expect(sequentialMock.mock.calls[0][0][0].route.inputAmountRaw).toBe('60');
    expect(insertMock.mock.calls[0][1]).toMatchObject({ sharesRaw: '100' });
  });

  it('partial exit: half of the effective holdings, half the legacy shares', async () => {
    await create(5000);
    expect(sequentialMock.mock.calls[0][0][0].route.inputAmountRaw).toBe('50');
    expect(insertMock.mock.calls[0][1].sharesRaw).toBe('50');
  });

  it('no fee: the locked value is the quoted estimate (no NAV needed — NAV is unavailable here), never booked as realized', async () => {
    const outcome = await create(10_000);
    expect(outcome.ok).toBe(true);
    expect(insertMock.mock.calls[0][1].redeemValueQuote).toBe('41.5');
  });

  it('unreadable balances refuse to quote instead of assuming the tokens are there', async () => {
    sellableMock.mockReturnValue(null);
    expect(await create(10_000)).toEqual({ ok: false, error: { kind: 'BALANCE_UNAVAILABLE' } });
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('an empty wallet has nothing to sell; a bad fraction is rejected before anything is read', async () => {
    sellableMock.mockReturnValue(sellable('100', '0'));
    expect(await create(10_000)).toEqual({ ok: false, error: { kind: 'NOTHING_TO_SELL' } });
    expect(await create(0)).toEqual({ ok: false, error: { kind: 'INVALID_FRACTION' } });
    expect(await create(10_001)).toEqual({ ok: false, error: { kind: 'INVALID_FRACTION' } });
  });
});

describe('prepareRedeemExecution — the wallet is re-checked before signing', () => {
  const intent = {
    id: 'r1',
    bagId: 'bag_1',
    userId: 'investor',
    status: 'READY',
    sharesRaw: '100',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    steps: [{ action: 'SWAP', inputAsset: { chain: 'robinhood', address: MSFT }, inputAmountRaw: '60' }],
  };
  beforeEach(() => {
    getIntentMock.mockResolvedValue({ ok: true, intent });
    updateStatusMock.mockImplementation(async (_a: unknown, u: { to: string }) => ({ ...intent, status: u.to }));
  });

  it('tokens moved out after the quote: the intent fails as ROUTE_CHANGED, nothing is signed', async () => {
    sellableMock.mockReturnValue(sellable('100', '59'));
    expect(await prepareRedeemExecution({} as never, session, 'r1')).toEqual({ ok: false, error: { kind: 'ROUTE_CHANGED' } });
    expect(updateStatusMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ to: 'FAILED', failureCode: 'ROUTE_EXPIRED' }));
  });

  it('balances unreadable at signing: refuse for now, the intent is not failed', async () => {
    sellableMock.mockReturnValue(null);
    expect(await prepareRedeemExecution({} as never, session, 'r1')).toEqual({ ok: false, error: { kind: 'BALANCE_UNAVAILABLE' } });
    expect(updateStatusMock).not.toHaveBeenCalled();
  });

  it('still covered: proceeds to signature', async () => {
    sellableMock.mockReturnValue(sellable('100', '60'));
    const outcome = await prepareRedeemExecution({} as never, session, 'r1');
    expect(outcome.ok && outcome.value.status).toBe('AWAITING_SIGNATURE');
  });
});

describe('saleStillCovered', () => {
  const step = (amount: string) => ({ inputAsset: { chain: 'robinhood' as const, address: MSFT }, inputAmountRaw: amount });
  it('every leg within tracked AND effective, burn within shares', () => {
    expect(saleStillCovered({ sharesRaw: '10', steps: [step('60')] as never }, sellable('100', '60') as never, '10')).toBe(true);
    expect(saleStillCovered({ sharesRaw: '10', steps: [step('61')] as never }, sellable('100', '60') as never, '10')).toBe(false);
    expect(saleStillCovered({ sharesRaw: '10', steps: [step('60')] as never }, sellable('50', '60') as never, '10')).toBe(false);
    expect(saleStillCovered({ sharesRaw: '11', steps: [step('1')] as never }, sellable('100', '60') as never, '10')).toBe(false);
    expect(saleStillCovered({ sharesRaw: '1', steps: [step('1')] as never }, [] as never, '10')).toBe(false);
  });
});
