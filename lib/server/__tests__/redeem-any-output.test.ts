import { beforeEach, describe, expect, it, vi } from 'vitest';

// A sale into any verified token (not only the settlement stablecoin): the token is resolved from the registry, its
// USD price is fixed on the intent when quoted, a sale that pays a performance fee stays in the settlement token,
// and without a price there is no sale.

const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const MSFT = '0x00000000000000000000000000000000000000a1';
const WALLET = '0x1111111111111111111111111111111111111111';
const PFE = '0x00000000000000000000000000000000000000f1';
const priceMock = vi.fn();

const bagMock = vi.fn();
const insertMock = vi.fn();
const sequentialMock = vi.fn();
const sellableMock = vi.fn();
const getIntentMock = vi.fn();
const updateStatusMock = vi.fn();
const positionMock = vi.fn();
const feePathMock = vi.fn();
const openRebalanceMock = vi.fn();

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
    { id: 'usdg', chain: 'robinhood', address: USDG, symbol: 'USDG', decimals: 6, status: 'VERIFIED', assetType: 'crypto' },
    { id: 'msft', chain: 'robinhood', address: MSFT, symbol: 'MSFT', decimals: 18, status: 'VERIFIED', assetType: 'stock' },
    { id: 'pfe', chain: 'robinhood', address: PFE, symbol: 'PFE', decimals: 18, status: 'VERIFIED', assetType: 'stock' },
  ],
}));
vi.mock('@/lib/server/bag-nav', () => ({ getBagNavSafe: async () => ({ ok: false, reason: 'PRICE_UNAVAILABLE', message: 'weekend' }) }));
vi.mock('@/lib/server/bag-share-state-repo', () => ({ getShareSupply: async () => ({ shareDecimals: 18 }) }));
vi.mock('@/lib/server/bag-investor-position-repo', () => ({ getInvestorPosition: (...a: unknown[]) => positionMock(...a) }));
vi.mock('@/lib/server/fee-redemption-path', () => ({ feeRedemptionPath: () => feePathMock() }));
vi.mock('@/lib/server/rebalance-execution', () => ({ hasOpenRebalance: (...a: unknown[]) => openRebalanceMock(...a) }));
vi.mock('@/lib/server/position-valuation', () => ({
  observeUserHoldings: async () => ({ rows: [{ bagId: 'bag_1' }] }),
  sellableHoldingsForBag: (...a: unknown[]) => sellableMock(...a),
}));
vi.mock('@/lib/blockchain/rpc/clients', () => ({ getChainPublicClient: () => ({}) }));
vi.mock('@/lib/server/price-provider', () => ({ getPriceProvider: () => ({ getPrice: (...a: unknown[]) => priceMock(...a) }) }));
vi.mock('@/lib/blockchain/lifi-purchase-quote', async (orig) => ({ ...(await orig<object>()), buildPurchaseIntentSteps: (...a: unknown[]) => sequentialMock(...a) }));

const { createRedeemIntentForUser } = await import('../redeem-execution');

const session = { userId: 'investor', walletAddress: WALLET } as never;
const create = (outputAssetId: string) => createRedeemIntentForUser({ admin: {} as never, session, bagId: 'bag_1', fractionBps: 10_000, outputAssetId });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('LIFI_API_KEY', '');
  bagMock.mockResolvedValue({ id: 'bag_1', chain: 'robinhood', creatorId: 'creator', performanceFeeBpsLocked: null });
  sellableMock.mockReturnValue([{ chain: 'robinhood', address: MSFT, decimals: 18, quantityRaw: '100', sellableRaw: '100' }]);
  positionMock.mockResolvedValue({ sharesRaw: '100', shareDecimals: 18 });
  feePathMock.mockReturnValue('SETTLEMENT');
  openRebalanceMock.mockResolvedValue(null);
  priceMock.mockImplementation(async (asset: { address: string }) => ({ asset, price: '25', quoteCurrency: 'USD', timestamp: '', source: 'test' }));
  sequentialMock.mockImplementation(async (steps: { route: { inputAsset: unknown; inputAmountRaw: string } }[]) => ({
    steps: steps.map((s, i) => ({ stepIndex: i, action: 'SWAP', status: 'PENDING', inputAsset: s.route.inputAsset, inputAmountRaw: s.route.inputAmountRaw, outputAmountRaw: '2000000000000000000', minOutputRaw: '1900000000000000000' })),
    allSwapsQuoted: true,
    firstFailure: null,
  }));
  insertMock.mockImplementation(async (_a: unknown, input: Record<string, unknown>) => ({ id: 'r1', ...input }));
});

describe('createRedeemIntentForUser — any verified output token', () => {
  it('into PFE: the PFE price is fixed on every step and the locked value is in USD', async () => {
    const outcome = await create('pfe');
    expect(outcome.ok).toBe(true);
    const input = insertMock.mock.calls[0][1] as { outputAsset: { address: string }; outputDecimals: number; redeemValueQuote: string; steps: { outputUsdPrice?: string }[] };
    expect(input.outputAsset.address).toBe(PFE);
    expect(input.outputDecimals).toBe(18);
    expect(input.steps.every((s) => s.outputUsdPrice === '25')).toBe(true);
    expect(input.redeemValueQuote).toBe('50.000000000000000000'); // 2 PFE × $25
    expect(priceMock).toHaveBeenCalledWith({ chain: 'robinhood', address: PFE });
  });

  it('into the settlement token nothing changes: no price lookup, no price on the steps', async () => {
    sequentialMock.mockImplementation(async (steps: { route: { inputAsset: unknown; inputAmountRaw: string } }[]) => ({
      steps: steps.map((s, i) => ({ stepIndex: i, action: 'SWAP', status: 'PENDING', inputAsset: s.route.inputAsset, inputAmountRaw: s.route.inputAmountRaw, outputAmountRaw: '41500000', minOutputRaw: '41000000' })),
      allSwapsQuoted: true,
      firstFailure: null,
    }));
    expect((await create('usdg')).ok).toBe(true);
    const input = insertMock.mock.calls[0][1] as { redeemValueQuote: string; steps: { outputUsdPrice?: string }[] };
    expect(input.redeemValueQuote).toBe('41.5');
    expect(input.steps.some((s) => 'outputUsdPrice' in s)).toBe(false);
    expect(priceMock).not.toHaveBeenCalled();
  });

  it('a sale that pays a performance fee cannot receive PFE (its fee settles in the settlement token)', async () => {
    bagMock.mockResolvedValue({ id: 'bag_1', chain: 'robinhood', creatorId: 'creator', performanceFeeBpsLocked: 2000 });
    expect(await create('pfe')).toEqual({ ok: false, error: { kind: 'UNKNOWN_OUTPUT_ASSET' } });
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('no price for the output token: no sale (never estimated)', async () => {
    priceMock.mockRejectedValue(new Error('no price'));
    const outcome = await create('pfe');
    expect(outcome).toMatchObject({ ok: false, error: { kind: 'PRICE_UNAVAILABLE' } });
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('into native ETH: only through the one-transaction route; without it the sale is refused, never sent per asset', async () => {
    const outcome = await create('native:robinhood'); // LIFI_API_KEY is unset here: no Composer route
    expect(outcome).toMatchObject({ ok: false, error: { kind: 'QUOTE_FAILED', failureCode: 'UNSUPPORTED_ROUTE' } });
    expect(sequentialMock).not.toHaveBeenCalled();
    expect(insertMock).not.toHaveBeenCalled();
  });
});
