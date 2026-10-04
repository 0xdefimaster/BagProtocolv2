import { beforeEach, describe, expect, it, vi } from 'vitest';

// A4: positions are valued from holdings (exposure / in wallet / effective), never shares × NAV; cost basis and
// realized P&L come from the ledger (A3). Unknown numbers stay null.

const valueMock = vi.fn();
const getBagByIdMock = vi.fn();
const eventsMock = vi.fn();

vi.mock('@/lib/supabase/server', () => ({ isSupabaseConfigured: () => true, supabaseAdmin: () => ({}) }));
vi.mock('@/lib/auth/require-session', () => ({ requireSession: async () => ({ ok: true, session: { userId: 'user_1', walletAddress: '0xabc' } }) }));
vi.mock('@/lib/server/bag-repo', () => ({ getBagById: (...a: unknown[]) => getBagByIdMock(...a) }));
vi.mock('@/lib/server/price-provider', () => ({ getPriceProvider: () => ({}), getDisplayPriceProvider: () => ({}) }));
vi.mock('@/lib/blockchain/rpc/clients', () => ({ getChainPublicClient: () => ({}) }));
vi.mock('@/lib/server/position-valuation', () => ({ valueUserPositions: (...a: unknown[]) => valueMock(...a) }));
vi.mock('@/lib/server/ledger-repo', () => ({ listAllLedgerEventsForPosition: (...a: unknown[]) => eventsMock(...a) }));
const settleMock = vi.fn(async () => ({ checked: 0, settled: 0 }));
vi.mock('@/lib/server/purchase-execution', () => ({ settleUnsettledPurchasesForUser: (...a: unknown[]) => settleMock(...(a as [])) }));

const { GET } = await import('@/app/api/portfolio/positions/route');

const value = (bagId: string, over: Record<string, unknown> = {}) => ({
  bagId,
  blockNumber: '1',
  assets: [],
  strategyExposureQuote: '10000',
  observedWalletQuote: '8700',
  effectivePositionQuote: '8700',
  hasDrift: true,
  hasUnreadable: false,
  ...over,
});
const buy = (cost: string) => ({
  seq: '1',
  kind: 'PURCHASE_FILL',
  legs: [{ chain: 'robinhood', address: '0xa', decimals: 18, deltaRaw: '1000000000000000000', costQuote: cost }],
  quote: {},
});

describe('GET /api/portfolio/positions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getBagByIdMock.mockImplementation(async (_a: unknown, id: string) => ({ id, name: `Bag ${id}`, symbol: id.toUpperCase(), status: 'ACTIVE' }));
  });

  it('reports exposure, in-wallet and effective value separately, with drift, and ledger cost basis', async () => {
    valueMock.mockResolvedValue(new Map([['a', value('a')], ['b', value('b', { strategyExposureQuote: null, effectivePositionQuote: null, observedWalletQuote: null, hasDrift: false, hasUnreadable: true })]]));
    eventsMock.mockImplementation(async (_a: unknown, _u: string, bagId: string) => (bagId === 'a' ? [buy('9000')] : []));

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.positions[0]).toMatchObject({
      bagId: 'a',
      strategyExposure: '10000',
      observedWallet: '8700',
      effectivePosition: '8700',
      hasDrift: true,
      costBasis: '9000',
    });
    expect(body.positions[0]).not.toHaveProperty('sharesRaw');
    expect(body.positions[0]).not.toHaveProperty('currentValue');
    expect(body.positions[1]).toMatchObject({ bagId: 'b', strategyExposure: null, effectivePosition: null, hasUnreadable: true, costBasis: null });
  });

  it("verifies the user's unsettled purchases before valuing positions", async () => {
    valueMock.mockResolvedValue(new Map());
    await GET();
    expect(settleMock).toHaveBeenCalledTimes(1);
    expect((settleMock.mock.calls[0] as unknown[])[1]).toEqual({ userId: 'user_1', walletAddress: '0xabc' });
    expect(settleMock.mock.invocationCallOrder[0]).toBeLessThan(valueMock.mock.invocationCallOrder[0]);
  });
});
