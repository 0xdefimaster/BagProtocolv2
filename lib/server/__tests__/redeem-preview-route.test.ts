import { beforeEach, describe, expect, it, vi } from 'vitest';

// A4: the preview sells a FRACTION of what the wallet effectively holds, and reports the position value of that
// slice separately from (never as) the sale's proceeds.

const listAssets = vi.fn();
const observeMock = vi.fn();
const sellableMock = vi.fn();
const valueMock = vi.fn();
vi.mock('@/lib/supabase/server', () => ({ isSupabaseConfigured: () => true, supabaseAdmin: () => ({}) }));
vi.mock('@/lib/auth/require-session', () => ({ requireSession: async () => ({ ok: true, session: { userId: 'u1', walletAddress: '0xw' } }) }));
vi.mock('@/lib/server/rate-limit', () => ({ checkRateLimit: async () => ({ allowed: true }), rateLimitedResponseBody: () => ({}) }));
vi.mock('@/lib/server/price-provider', () => ({
  getPriceProvider: () => ({}),
  getDisplayPriceProvider: () => ({ getPrice: async (a: { address: string }) => ({ price: a.address.toLowerCase() === '0xmsft' ? '400' : '1' }) }),
}));
vi.mock('@/lib/blockchain/rpc/clients', () => ({ getChainPublicClient: () => ({}) }));
let bagRow: Record<string, unknown> = { id: 'b1', chain: 'robinhood', name: 'AI', symbol: 'AI', creatorId: 'creator', performanceFeeBpsLocked: null };
let ledgerEvents: unknown[] = [];
vi.mock('@/lib/server/bag-repo', () => ({ getBagById: async () => bagRow, getCurrentBagVersion: async () => ({ recipe: { performanceFeeBps: 0 } }) }));
vi.mock('@/lib/server/ledger-repo', () => ({ listAllLedgerEventsForPosition: async () => ledgerEvents }));
vi.mock('@/lib/server/asset-repo', () => ({ listAssets: (...a: unknown[]) => listAssets(...a) }));
vi.mock('@/lib/server/payment-assets', () => ({ paymentAssetsFor: (assets: { symbol: string }[]) => assets.filter((a) => a.symbol === 'USDG') }));
vi.mock('@/lib/server/position-valuation', async (orig) => ({
  ...(await orig<object>()),
  observeUserHoldings: (...a: unknown[]) => observeMock(...a),
  sellableHoldingsForBag: (...a: unknown[]) => sellableMock(...a),
  valueUserPositions: (...a: unknown[]) => valueMock(...a),
}));

import { GET, POST } from '@/app/api/bags/[id]/redeem-preview/route';

const post = (body: unknown) =>
  POST(new Request('http://x', { method: 'POST', body: JSON.stringify(body) }) as never, { params: Promise.resolve({ id: 'b1' }) });

beforeEach(() => {
  vi.clearAllMocks();
  bagRow = { id: 'b1', chain: 'robinhood', name: 'AI', symbol: 'AI', creatorId: 'creator', performanceFeeBpsLocked: null };
  ledgerEvents = [];
  listAssets.mockResolvedValue([
    { id: 'usdg', chain: 'robinhood', address: '0xUSDG', symbol: 'USDG', decimals: 6, name: 'Global Dollar', status: 'VERIFIED' },
    { id: 'msft', chain: 'robinhood', address: '0xmsft', symbol: 'MSFT', decimals: 6, name: 'Microsoft', status: 'VERIFIED' },
  ]);
  observeMock.mockResolvedValue({ rows: [{ bagId: 'b1' }] });
  // Tracked 100 MSFT, wallet effectively 60 (drift); 5 USDG in sync.
  sellableMock.mockReturnValue([
    { chain: 'robinhood', address: '0xMSFT', decimals: 6, quantityRaw: '100000000', sellableRaw: '60000000' },
    { chain: 'robinhood', address: '0xusdg', decimals: 6, quantityRaw: '5000000', sellableRaw: '5000000' },
  ]);
});

describe('POST /api/bags/:id/redeem-preview', () => {
  it('a full exit sells only what the wallet holds (60 of tracked 100), names every asset, values the slice', async () => {
    const res = await post({ fractionBps: 10_000, outputAssetId: 'usdg' });
    expect(res.status).toBe(200);
    const { preview } = await res.json();
    expect(preview.allocation.map((a: { symbol: string; sellQuantityRaw: string }) => [a.symbol, a.sellQuantityRaw])).toEqual([
      ['MSFT', '60000000'],
      ['USDG', '5000000'],
    ]);
    expect(preview.allocation[1].isOutputAsset).toBe(true);
    expect(preview.sliceValueQuote).toBe('24005');
    expect(preview).not.toHaveProperty('redeemQuote');
  });

  it('a partial exit sells that fraction of each sellable holding', async () => {
    const { preview } = await (await post({ fractionBps: 2500, outputAssetId: 'usdg' })).json();
    expect(preview.allocation.map((a: { sellQuantityRaw: string }) => a.sellQuantityRaw)).toEqual(['15000000', '1250000']);
  });

  it('unreadable wallet balances refuse to quote (503), never assume the tokens are there', async () => {
    sellableMock.mockReturnValue(null);
    expect((await post({ fractionBps: 10_000, outputAssetId: 'usdg' })).status).toBe(503);
  });

  it('rejects a fraction outside 1..10000 and the old share-count body', async () => {
    expect((await post({ fractionBps: 0, outputAssetId: 'usdg' })).status).toBe(422);
    expect((await post({ fractionBps: 10_001, outputAssetId: 'usdg' })).status).toBe(422);
    expect((await post({ sharesToRedeemRaw: '10', outputAssetId: 'usdg' })).status).toBe(400);
  });

  it('a fee-free sale shows no performance fee', async () => {
    const { preview } = await (await post({ fractionBps: 10_000, outputAssetId: 'usdg' })).json();
    expect(preview.performanceFee).toBeNull();
  });

  it('B0: a fee-paying sale shows the estimated fee on the A3 basis of what is sold, after earlier losses', async () => {
    bagRow = { ...bagRow, performanceFeeBpsLocked: 1000 };
    // Bought 100 MSFT for $20,000 and 5 USDG for $5; an earlier sale realized −$500 (sold 50 MSFT for $9,500 of $10,000 basis) and was bought back.
    ledgerEvents = [
      { seq: '1', kind: 'PURCHASE_FILL', quote: {}, legs: [{ chain: 'robinhood', address: '0xMSFT', deltaRaw: '100000000', costQuote: '20000' }, { chain: 'robinhood', address: '0xusdg', deltaRaw: '5000000', costQuote: '5' }] },
      { seq: '2', kind: 'REDEEM_FILL', quote: {}, legs: [{ chain: 'robinhood', address: '0xMSFT', deltaRaw: '-50000000', proceedsQuote: '9500' }] },
      { seq: '3', kind: 'PURCHASE_FILL', quote: {}, legs: [{ chain: 'robinhood', address: '0xMSFT', deltaRaw: '50000000', costQuote: '10000' }] },
    ];
    const { preview } = await (await post({ fractionBps: 10_000, outputAssetId: 'usdg' })).json();
    // Sells 60 MSFT (basis 60 × $200 = $12,000) + 5 USDG ($5); slice value $24,005; carry $500 → gain $11,500 → 10% = $1,150.
    expect(preview.performanceFee).toEqual({ rateBps: 1000, basisAvailable: true, consumedBasisQuote: '12005', lossCarryQuote: '500', estimatedFeeQuote: '1150' });
  });

  it("B0: the creator's own sale pays no fee; unknown basis is reported, never guessed", async () => {
    bagRow = { ...bagRow, performanceFeeBpsLocked: 1000, creatorId: 'u1' };
    expect((await (await post({ fractionBps: 10_000, outputAssetId: 'usdg' })).json()).preview.performanceFee).toBeNull();
    bagRow = { ...bagRow, creatorId: 'creator' };
    ledgerEvents = [];
    expect((await (await post({ fractionBps: 10_000, outputAssetId: 'usdg' })).json()).preview.performanceFee).toEqual({
      rateBps: 1000, basisAvailable: false, consumedBasisQuote: null, lossCarryQuote: null, estimatedFeeQuote: null,
    });
  });

  it('only a VERIFIED payment asset can be the output', async () => {
    listAssets.mockResolvedValue([{ id: 'usdg', chain: 'robinhood', address: '0xUSDG', symbol: 'USDG', decimals: 6, name: 'G', status: 'PENDING' }]);
    expect((await post({ fractionBps: 10_000, outputAssetId: 'usdg' })).status).toBe(400);
  });
});

describe('GET /api/bags/:id/redeem-preview', () => {
  it('returns the holdings-based position value, no share fields', async () => {
    valueMock.mockResolvedValue(
      new Map([['b1', { bagId: 'b1', blockNumber: '9', assets: [], strategyExposureQuote: '10000', observedWalletQuote: '8700', effectivePositionQuote: '8700', hasDrift: true, hasUnreadable: false }]])
    );
    const body = await (await GET(new Request('http://x') as never, { params: Promise.resolve({ id: 'b1' }) })).json();
    expect(body.position).toMatchObject({ strategyExposureQuote: '10000', observedWalletQuote: '8700', effectivePositionQuote: '8700', hasDrift: true });
    expect(body.position).not.toHaveProperty('sharesRaw');
  });
});
