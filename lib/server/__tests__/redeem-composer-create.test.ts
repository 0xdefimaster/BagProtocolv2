import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// When a redemption is built as ONE Composer transaction: only with a LI.FI key, no RedeemFeeRouter configured,
// and no performance fee owed (or the creator's own Bag). Otherwise, and on a database without migration 0047,
// the per-asset LI.FI quotes are used exactly as before.

const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const MSFT = '0x00000000000000000000000000000000000000a1';
const WALLET = '0x1111111111111111111111111111111111111111';

const bagMock = vi.fn();
const versionMock = vi.fn();
const insertMock = vi.fn();
const composerMock = vi.fn();
const sequentialMock = vi.fn();

vi.mock('@/lib/server/rebalance-execution', () => ({ hasOpenRebalance: async () => null }));
vi.mock('@/lib/server/bag-repo', () => ({ getBagById: (...a: unknown[]) => bagMock(...a), getCurrentBagVersion: (...a: unknown[]) => versionMock(...a) }));
vi.mock('@/lib/server/redeem-intent-repo', () => ({
  createRedeemIntent: (...a: unknown[]) => insertMock(...a),
  findActiveRedeemIntentForBag: async () => null,
  listLiveSettlementAttestations: async () => [],
  getRedeemIntentForUser: vi.fn(),
  updateRedeemIntentStatus: vi.fn(),
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
vi.mock('@/lib/server/bag-nav', () => ({ getBagNavSafe: async () => ({ ok: true, nav: {} }) }));
vi.mock('@/lib/server/bag-share-state-repo', () => ({ getShareSupply: async () => ({ shareDecimals: 18 }) }));
vi.mock('@/lib/server/bag-investor-position-repo', () => ({ getInvestorPosition: async () => ({ sharesRaw: '10', shareDecimals: 18 }) }));
vi.mock('@/lib/server/position-valuation', () => ({
  observeUserHoldings: async () => ({ rows: [{ bagId: 'bag_1' }] }),
  sellableHoldingsForBag: () => [{ chain: 'robinhood', address: MSFT, decimals: 18, quantityRaw: '1000', sellableRaw: '1000' }],
}));
vi.mock('@/lib/blockchain/rpc/clients', () => ({ getChainPublicClient: () => ({}) }));
vi.mock('@/lib/server/price-provider', () => ({ getPriceProvider: () => ({}) }));
vi.mock('@/lib/domain/basket-protocol/shares/shares', async (orig) => ({
  ...(await orig<object>()),
  getRedeemQuote: () => ({ sharesRaw: '10', shareDecimals: 18, sharePrice: '1', grossValue: '10' }),
}));
vi.mock('@/lib/server/redeem-composer', async (orig) => ({ ...(await orig<object>()), buildRedeemComposer: (...a: unknown[]) => composerMock(...a) }));
vi.mock('@/lib/blockchain/lifi-purchase-quote', async (orig) => ({ ...(await orig<object>()), buildPurchaseIntentSteps: (...a: unknown[]) => sequentialMock(...a) }));

const { createRedeemIntentForUser } = await import('../redeem-execution');

const COMPOSER_TX = { to: '0xabc', data: '0x01', value: '0', chainId: 4663, approvals: [] };
const COMPOSER_STEPS = [{ stepIndex: 0, action: 'SWAP', status: 'PENDING' }];
const SEQ_STEPS = [{ stepIndex: 0, action: 'SWAP', status: 'PENDING', lifiStep: {} }];

const create = () =>
  createRedeemIntentForUser({ admin: {} as never, session: { userId: 'investor', walletAddress: WALLET } as never, bagId: 'bag_1', fractionBps: 10_000, outputAssetId: 'usdg' });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('LIFI_API_KEY', 'k');
  vi.stubEnv('REDEEM_FEE_ROUTER_ADDRESS', '');
  bagMock.mockResolvedValue({ id: 'bag_1', chain: 'robinhood', creatorId: 'creator', performanceFeeBpsLocked: null });
  versionMock.mockResolvedValue({ recipe: { performanceFeeBps: 0 } });
  composerMock.mockResolvedValue({ steps: COMPOSER_STEPS, composerTransaction: COMPOSER_TX });
  sequentialMock.mockResolvedValue({ steps: SEQ_STEPS, allSwapsQuoted: true, firstFailure: null, composerTransaction: null });
  insertMock.mockImplementation(async (_a: unknown, input: Record<string, unknown>) => ({ id: 'r1', ...input }));
});
afterEach(() => vi.unstubAllEnvs());

describe('createRedeemIntentForUser — one-transaction sale', () => {
  it('no fee owed: one Composer transaction, stored with the intent, no per-asset quotes', async () => {
    const outcome = await create();
    expect(outcome.ok).toBe(true);
    expect(composerMock.mock.calls[0][0]).toMatchObject({ walletAddress: WALLET, outputAsset: { chain: 'robinhood', address: USDG }, outputDecimals: 6, apiKey: 'k' });
    expect(sequentialMock).not.toHaveBeenCalled();
    expect(insertMock.mock.calls[0][1]).toMatchObject({ steps: COMPOSER_STEPS, composerTransaction: COMPOSER_TX, status: 'READY' });
  });

  it('a performance fee owed: per-asset quotes as before (the fee path is the router)', async () => {
    versionMock.mockResolvedValue({ recipe: { performanceFeeBps: 1000 } });
    await create();
    expect(composerMock).not.toHaveBeenCalled();
    expect(insertMock.mock.calls[0][1].composerTransaction).toBeUndefined();
  });

  it("the creator's own Bag never owes a fee: one transaction even with a fee set", async () => {
    bagMock.mockResolvedValue({ id: 'bag_1', chain: 'robinhood', creatorId: 'investor', performanceFeeBpsLocked: 1000 });
    await create();
    expect(composerMock).toHaveBeenCalled();
  });

  it('a configured RedeemFeeRouter does not stop a free sale from being one transaction (it only settles fees)', async () => {
    vi.stubEnv('REDEEM_FEE_ROUTER_ADDRESS', '0x00000000000000000000000000000000000000ff');
    await create();
    expect(composerMock).toHaveBeenCalledTimes(1);
    expect(sequentialMock).not.toHaveBeenCalled();
  });

  it('no LI.FI key: per-asset quotes as before', async () => {
    vi.stubEnv('LIFI_API_KEY', '');
    await create();
    expect(composerMock).not.toHaveBeenCalled();
    expect(sequentialMock).toHaveBeenCalledTimes(1);
  });

  it('Composer unavailable: per-asset quotes', async () => {
    composerMock.mockResolvedValue(null);
    await create();
    expect(sequentialMock).toHaveBeenCalledTimes(1);
    expect(insertMock.mock.calls[0][1]).toMatchObject({ steps: SEQ_STEPS });
  });

  it('database without migration 0047: the insert is retried as a per-asset sale', async () => {
    insertMock.mockRejectedValueOnce(new Error('column "composer_transaction" does not exist'));
    const outcome = await create();
    expect(outcome.ok).toBe(true);
    expect(insertMock).toHaveBeenCalledTimes(2);
    expect(insertMock.mock.calls[1][1]).toMatchObject({ steps: SEQ_STEPS });
    expect(insertMock.mock.calls[1][1].composerTransaction).toBeUndefined();
  });
});
