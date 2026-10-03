import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { Portfolio, Trade } from '@/types/domain';

// -----------------------------------------------------------------------------
// Phase 18.6 — route-level regression tests for `POST /api/trades`'s
// server-trusted execution price (unchanged by Phase 18.7).
//
// Phase 18.7 — this file was rewritten to mock the new commit boundary:
// `commitInvestmentTransaction()`/`getTradesByIds()`
// (lib/server/trading-repo.ts) replace the old per-call
// `persistPortfolio()`/`insertTrade()`/`findTradeByClientId()` mocks, since
// the route's commit phase now goes through ONE atomic RPC call instead of
// N separate Supabase REST calls. These are route-level tests: they prove
// the route calls the atomic commit correctly (right final portfolio, right
// legs, right idempotency key, correct handling of PORTFOLIO_STALE / a raw
// DB failure) and never falls back to the old per-row write path. They do
// NOT exercise commit_investment_transaction's own SQL-level atomicity (the
// `for update` row lock, the real ROLLBACK on a mid-transaction failure,
// real concurrent-request behaviour) — that requires a real Postgres
// instance, which this test environment does not have. See
// lib/server/__tests__/trading-repo.test.ts for the repo-boundary tests
// (RPC param shape, typed error mapping) and docs/PHASE_18_7_REPORT.md for
// what remains unverified against a real database.
//
// Placed under `lib/server/__tests__` (importing the route handler from its
// real `app/api/...` path), not `app/api/...` — `vitest.config.ts`'s
// `include` is scoped to `lib/**/*.test.ts` (see purchase-preview-route.test.ts
// for the same convention).
// -----------------------------------------------------------------------------

const getPortfolioMock = vi.fn();
const commitInvestmentTransactionMock = vi.fn();
const getTradesByIdsMock = vi.fn();
const listTradesMock = vi.fn();
const getUserPointsMock = vi.fn();
const getCurrentSeasonMock = vi.fn();
const getPriceMock = vi.fn();
const getPricesMock = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  isSupabaseConfigured: () => true,
  supabaseAdmin: () => ({}) as never,
}));

vi.mock('@/lib/auth/require-session', () => ({
  requireSession: async () => ({ ok: true, session: { userId: 'user_1', walletAddress: '0xabc' } }),
}));

vi.mock('@/lib/server/trading-repo', () => ({
  getPortfolio: (...args: unknown[]) => getPortfolioMock(...args),
  commitInvestmentTransaction: (...args: unknown[]) => commitInvestmentTransactionMock(...args),
  getTradesByIds: (...args: unknown[]) => getTradesByIdsMock(...args),
  listTrades: (...args: unknown[]) => listTradesMock(...args),
}));

vi.mock('@/lib/server/points-repo', () => ({
  getUserPoints: (...args: unknown[]) => getUserPointsMock(...args),
}));

// Production-hardening P0-6 — the route now resolves the REAL current
// season (lib/server/season-repo.ts) before attaching any points to a
// SELL, instead of the hardcoded GENESIS_SEASON constant this suite
// predates. Defaults to a real active season below so every existing
// SELL-side-effect test keeps its original meaning; the "no active
// season" case gets its own dedicated test.
vi.mock('@/lib/server/season-repo', () => ({
  getCurrentSeason: (...args: unknown[]) => getCurrentSeasonMock(...args),
}));

vi.mock(
  '@/lib/server/trading-price-provider',
  async (importOriginal: () => Promise<typeof import('../trading-price-provider')>) => {
    const actual = await importOriginal();
    return {
      ...actual,
      getTradingPriceFeed: () => ({
        getPrice: (...args: unknown[]) => getPriceMock(...args),
        getPrices: (...args: unknown[]) => getPricesMock(...args),
      }),
    };
  }
);

const { TradingPriceUnavailableError } = await import('../trading-price-provider');
const { POST } = await import('@/app/api/trades/route');

function postRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/trades', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

const TRUSTED_BTC_PRICE = 65_000;

function basePortfolio(overrides: Partial<Portfolio> = {}): Portfolio {
  return {
    userId: 'user_1',
    cashBalance: 100_000,
    positions: [],
    realizedPnL: 0,
    portfolioVersion: 4,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function fakeTrade(overrides: Partial<Trade> = {}): Trade {
  return {
    id: 'trade_1',
    userId: 'user_1',
    symbol: 'BTC',
    side: 'BUY',
    quantity: 1,
    price: TRUSTED_BTC_PRICE,
    totalValue: TRUSTED_BTC_PRICE,
    realizedPnL: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('POST /api/trades — server-trusted execution price', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getCurrentSeasonMock.mockResolvedValue({
      id: 's',
      name: 'Test Season',
      startDate: '2026-01-01T00:00:00.000Z',
      endDate: '2026-12-31T00:00:00.000Z',
      status: 'ACTIVE',
      topUsersReward: 20,
    });
    getUserPointsMock.mockResolvedValue({
      userId: 'user_1',
      seasonId: 's',
      totalRealizedPnL: 0,
      bagPoints: 0,
      pointsSpent: 0,
      pointsAvailable: 0,
    });
    // Default: commit succeeds, echoes back one trade id per leg it was given.
    commitInvestmentTransactionMock.mockImplementation(async (_admin, input) => ({
      ok: true,
      alreadyApplied: false,
      tradeIds: input.legs.map((_leg: unknown, i: number) => `trade_${i + 1}`),
      pointsAwarded: 0,
    }));
    getTradesByIdsMock.mockImplementation(async (_admin, tradeIds: string[]) =>
      tradeIds.map((id, i) => fakeTrade({ id, symbol: i === 1 ? 'ETH' : 'BTC' }))
    );
  });

  it('BUY: ignores a fabricated low client price and executes at the trusted server price', async () => {
    getPortfolioMock.mockResolvedValue(basePortfolio());
    getPriceMock.mockResolvedValue(TRUSTED_BTC_PRICE);

    const res = await POST(
      postRequest({ symbol: 'BTC', side: 'BUY', quantity: 1, price: 0.01 }) // client tries to buy BTC for one cent
    );
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    // The engine, and the committed leg, only ever saw the trusted price.
    const commitInput = commitInvestmentTransactionMock.mock.calls[0][1];
    expect(commitInput.legs[0]).toMatchObject({ price: TRUSTED_BTC_PRICE, totalValue: TRUSTED_BTC_PRICE });
  });

  it('BUY: a fabricated low price cannot be used to buy more than cash balance allows', async () => {
    // Real cost of 1 BTC at the trusted price ($65,000) exceeds the demo
    // cash balance ($100), even though the client claims a price ($0.01)
    // that would make it affordable.
    getPortfolioMock.mockResolvedValue(basePortfolio({ cashBalance: 100 }));
    getPriceMock.mockResolvedValue(TRUSTED_BTC_PRICE);

    const res = await POST(postRequest({ symbol: 'BTC', side: 'BUY', quantity: 1, price: 0.01 }));
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.ok).toBe(false);
    expect(data.error).toMatch(/insufficient/i);
    expect(commitInvestmentTransactionMock).not.toHaveBeenCalled();
  });

  it('SELL: a fabricated high client price cannot inflate realized PnL, points, or leaderboard input', async () => {
    // Bought at 100, trusted market price has since dropped to 50 — a real
    // loss. The client claims a price of 1,000,000 to try to manufacture a
    // huge profit.
    getPortfolioMock.mockResolvedValue(
      basePortfolio({ positions: [{ symbol: 'BTC', quantity: 1, avgCost: 100 }] })
    );
    getPriceMock.mockResolvedValue(50);

    const res = await POST(
      postRequest({ symbol: 'BTC', side: 'SELL', quantity: 1, price: 1_000_000 })
    );
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);

    // realizedPnL passed into the atomic commit must reflect the trusted
    // price (50 - 100) * 1 = -50, never the client's fabricated 1,000,000.
    const commitInput = commitInvestmentTransactionMock.mock.calls[0][1];
    expect(commitInput.legs[0]).toMatchObject({ price: 50, realizedPnL: -50 });
    // Points accounting must be part of the SAME atomic commit call (spec
    // §8: never a separate points write), keyed by the true (negative) PnL.
    expect(commitInput.seasonId).toEqual(expect.any(String));
    expect(commitInput.finalPortfolio.realizedPnL).toBe(-50);
  });

  // Production-hardening P0-6 — season-scoped operations only ever attach
  // to a REAL current season, never a stale/nonexistent one. A SELL must
  // still execute and settle normally even when no season is currently
  // active — it just never attaches points accounting to anything.
  it('SELL with no active season: the trade still executes normally, but points accounting is skipped (seasonId null, never a stale id)', async () => {
    getCurrentSeasonMock.mockResolvedValue(null);
    getPortfolioMock.mockResolvedValue(
      basePortfolio({ positions: [{ symbol: 'BTC', quantity: 1, avgCost: 100 }] })
    );
    getPriceMock.mockResolvedValue(150);

    const res = await POST(postRequest({ symbol: 'BTC', side: 'SELL', quantity: 1, price: 150 }));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    const commitInput = commitInvestmentTransactionMock.mock.calls[0][1];
    expect(commitInput.seasonId).toBeNull();
    // getUserPoints is never even called without a real season id.
    expect(getUserPointsMock).not.toHaveBeenCalled();
    expect(commitInput.finalPortfolio.realizedPnL).toBe(50);
  });

  it('accepts a request that omits `price` entirely — the server never needed it', async () => {
    getPortfolioMock.mockResolvedValue(basePortfolio());
    getPriceMock.mockResolvedValue(TRUSTED_BTC_PRICE);

    const res = await POST(postRequest({ symbol: 'BTC', side: 'BUY', quantity: 1 }));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    const commitInput = commitInvestmentTransactionMock.mock.calls[0][1];
    expect(commitInput.legs[0]).toMatchObject({ price: TRUSTED_BTC_PRICE });
  });

  it('rejects a symbol outside the tradable whitelist before ever touching the price feed', async () => {
    getPortfolioMock.mockResolvedValue(basePortfolio());

    const res = await POST(postRequest({ symbol: 'NOT_A_REAL_ASSET', side: 'BUY', quantity: 1, price: 100 }));
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.error).toBeTruthy();
    expect(getPriceMock).not.toHaveBeenCalled();
    expect(commitInvestmentTransactionMock).not.toHaveBeenCalled();
  });

  it('fails closed (503-equivalent domain error) when the trusted feed cannot price the symbol — never falls back to the client price', async () => {
    getPortfolioMock.mockResolvedValue(basePortfolio());
    getPriceMock.mockRejectedValue(new TradingPriceUnavailableError('BTC'));

    const res = await POST(postRequest({ symbol: 'BTC', side: 'BUY', quantity: 1, price: 65_000 }));
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.error).toMatch(/temporarily unavailable/i);
    expect(commitInvestmentTransactionMock).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------
  // Phase 18.7 — single-trade atomic commit failure handling
  // ---------------------------------------------------------------------

  it('single trade: a stale-portfolio commit failure returns 409, a stable PORTFOLIO_STALE code, a retry-friendly message, and a freshly-refetched portfolio', async () => {
    getPortfolioMock
      .mockResolvedValueOnce(basePortfolio({ portfolioVersion: 4 })) // planning read
      .mockResolvedValueOnce(basePortfolio({ portfolioVersion: 7 })); // portfolioStaleResponse's fresh re-read
    getPriceMock.mockResolvedValue(TRUSTED_BTC_PRICE);
    commitInvestmentTransactionMock.mockResolvedValue({ ok: false, error: 'PORTFOLIO_STALE' });

    const res = await POST(postRequest({ symbol: 'BTC', side: 'BUY', quantity: 1 }));
    const data = await res.json();

    expect(res.status).toBe(409);
    expect(data.ok).toBe(false);
    expect(data.error).toBe('PORTFOLIO_STALE');
    expect(data.message).toMatch(/retry/i);
    // getPortfolio is called once for planning and once more (by
    // portfolioStaleResponse) to hand the caller a FRESH snapshot — not
    // just the stale one it already had.
    expect(getPortfolioMock).toHaveBeenCalledTimes(2);
    expect(data.portfolio.portfolioVersion).toBe(7);
  });

  it('single trade: a raw DB commit failure never leaks the raw error to the client — stable code + correlation id only', async () => {
    getPortfolioMock.mockResolvedValue(basePortfolio());
    getPriceMock.mockResolvedValue(TRUSTED_BTC_PRICE);
    commitInvestmentTransactionMock.mockResolvedValue({
      ok: false,
      error: 'connection terminated unexpectedly at 10.0.0.5:5432',
    });

    const res = await POST(postRequest({ symbol: 'BTC', side: 'BUY', quantity: 1 }));
    const data = await res.json();

    expect(res.status).toBe(500);
    expect(data.ok).toBe(false);
    expect(data.code).toBe('INVESTMENT_COMMIT_FAILED');
    expect(data.requestId).toEqual(expect.any(String));
    expect(JSON.stringify(data)).not.toMatch(/10\.0\.0\.5/);
    expect(JSON.stringify(data)).not.toMatch(/connection terminated/i);
  });

  it('single trade: clientTradeId is passed through as the whole-commit idempotency key', async () => {
    getPortfolioMock.mockResolvedValue(basePortfolio());
    getPriceMock.mockResolvedValue(TRUSTED_BTC_PRICE);

    await POST(postRequest({ symbol: 'BTC', side: 'BUY', quantity: 1, clientTradeId: 'client_req_abc' }));

    const commitInput = commitInvestmentTransactionMock.mock.calls[0][1];
    expect(commitInput.investmentId).toBe('client_req_abc');
    expect(commitInput.legs[0].clientTradeId).toBe('client_req_abc');
  });

  it('single trade: an alreadyApplied replay still returns 200 with the original trade, not an error', async () => {
    getPortfolioMock.mockResolvedValue(basePortfolio());
    getPriceMock.mockResolvedValue(TRUSTED_BTC_PRICE);
    commitInvestmentTransactionMock.mockResolvedValue({
      ok: true,
      alreadyApplied: true,
      tradeIds: ['trade_1'],
      pointsAwarded: 0,
      portfolioVersion: 4,
    });

    const res = await POST(
      postRequest({ symbol: 'BTC', side: 'BUY', quantity: 1, clientTradeId: 'client_req_abc' })
    );
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.trade.id).toBe('trade_1');
  });

  // ---------------------------------------------------------------------
  // invest() — planning behaviour (Phase 18.6, unchanged) + Phase 18.7's
  // atomic commit boundary.
  // ---------------------------------------------------------------------

  it('invest(): ignores a fabricated `prices` map and derives every leg price from the trusted feed', async () => {
    getPortfolioMock.mockResolvedValue(basePortfolio({ cashBalance: 1_000 }));
    getPricesMock.mockResolvedValue({ BTC: TRUSTED_BTC_PRICE, ETH: 3_400 });

    const res = await POST(
      postRequest({
        action: 'invest',
        bagId: 'bag_1',
        amount: 100,
        composition: [{ symbol: 'BTC', weight: 100 }],
        // Client claims BTC costs one cent — would buy ~10,000 BTC with $100.
        prices: { BTC: 0.01 },
      })
    );
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    const commitInput = commitInvestmentTransactionMock.mock.calls[0][1];
    expect(commitInput.legs[0]).toMatchObject({ symbol: 'BTC', price: TRUSTED_BTC_PRICE });
    // Quantity must be derived from the trusted price ($100 / $65,000),
    // not the fabricated one ($100 / $0.01 = 10,000).
    expect(commitInput.legs[0].quantity).toBeCloseTo(100 / TRUSTED_BTC_PRICE, 6);
  });

  it('invest(): rejects the entire investment atomically when the trusted feed has no price for a required leg — zero trades, zero writes', async () => {
    getPortfolioMock.mockResolvedValue(basePortfolio({ cashBalance: 1_000 }));
    getPricesMock.mockResolvedValue({}); // trusted feed priced nothing this round

    const res = await POST(
      postRequest({
        action: 'invest',
        bagId: 'bag_1',
        amount: 100,
        composition: [{ symbol: 'BTC', weight: 100 }],
        prices: { BTC: 65_000 },
      })
    );
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.ok).toBe(false);
    expect(data.trades).toEqual([]);
    expect(data.error).toMatch(/BTC/);
    expect(commitInvestmentTransactionMock).not.toHaveBeenCalled();
  });

  it('invest(): BTC valid + ETH missing -> whole basket rejected, BTC leg (which WOULD have priced fine) is never committed either', async () => {
    getPortfolioMock.mockResolvedValue(basePortfolio({ cashBalance: 1_000 }));
    getPricesMock.mockResolvedValue({ BTC: TRUSTED_BTC_PRICE }); // ETH absent

    const res = await POST(
      postRequest({
        action: 'invest',
        bagId: 'bag_1',
        amount: 100,
        composition: [
          { symbol: 'BTC', weight: 60 },
          { symbol: 'ETH', weight: 40 },
        ],
      })
    );
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.ok).toBe(false);
    expect(data.trades).toEqual([]);
    expect(data.error).toMatch(/ETH/);
    expect(commitInvestmentTransactionMock).not.toHaveBeenCalled();
  });

  it('invest(): BTC valid + ETH invalid (feed returns a non-positive price) -> whole basket rejected', async () => {
    getPortfolioMock.mockResolvedValue(basePortfolio({ cashBalance: 1_000 }));
    getPricesMock.mockResolvedValue({ BTC: TRUSTED_BTC_PRICE, ETH: -1 });

    const res = await POST(
      postRequest({
        action: 'invest',
        bagId: 'bag_1',
        amount: 100,
        composition: [
          { symbol: 'BTC', weight: 60 },
          { symbol: 'ETH', weight: 40 },
        ],
      })
    );
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.ok).toBe(false);
    expect(data.trades).toEqual([]);
    expect(commitInvestmentTransactionMock).not.toHaveBeenCalled();
  });

  it('invest(): a non-tradable symbol in the composition rejects the whole basket rather than silently dropping that leg', async () => {
    getPortfolioMock.mockResolvedValue(basePortfolio({ cashBalance: 1_000 }));
    getPricesMock.mockResolvedValue({ BTC: TRUSTED_BTC_PRICE });

    const res = await POST(
      postRequest({
        action: 'invest',
        bagId: 'bag_1',
        amount: 100,
        composition: [
          { symbol: 'BTC', weight: 60 },
          { symbol: 'HOOD', weight: 40 }, // not in TRADABLE_SYMBOLS
        ],
      })
    );
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.ok).toBe(false);
    expect(data.trades).toEqual([]);
    expect(commitInvestmentTransactionMock).not.toHaveBeenCalled();
  });

  it('invest(): BTC + ETH both valid -> both legs are priced from the trusted feed and committed in ONE atomic call', async () => {
    getPortfolioMock.mockResolvedValue(basePortfolio({ cashBalance: 1_000 }));
    getPricesMock.mockResolvedValue({ BTC: TRUSTED_BTC_PRICE, ETH: 3_400 });

    const res = await POST(
      postRequest({
        action: 'invest',
        bagId: 'bag_1',
        amount: 100,
        composition: [
          { symbol: 'BTC', weight: 60 },
          { symbol: 'ETH', weight: 40 },
        ],
      })
    );
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    // ONE commit call for the whole basket, never one call per leg.
    expect(commitInvestmentTransactionMock).toHaveBeenCalledTimes(1);
    const commitInput = commitInvestmentTransactionMock.mock.calls[0][1];
    expect(commitInput.legs).toHaveLength(2);
    expect(commitInput.legs[0]).toMatchObject({ symbol: 'BTC', price: TRUSTED_BTC_PRICE });
    expect(commitInput.legs[1]).toMatchObject({ symbol: 'ETH', price: 3_400 });
  });

  // ---------------------------------------------------------------------
  // invest() — composition structural validation (Phase 18.7 final
  // hardening). These run BEFORE the trusted price feed is even called, so
  // every case here rejects with zero trades/writes and — except where a
  // test explicitly checks otherwise — `getPricesMock` need not resolve.
  // ---------------------------------------------------------------------

  it('invest(): BTC 60 + ETH 40 (sums to exactly 100) is a valid composition and both legs commit', async () => {
    getPortfolioMock.mockResolvedValue(basePortfolio({ cashBalance: 1_000 }));
    getPricesMock.mockResolvedValue({ BTC: TRUSTED_BTC_PRICE, ETH: 3_400 });

    const res = await POST(
      postRequest({
        action: 'invest',
        bagId: 'bag_1',
        amount: 100,
        composition: [
          { symbol: 'BTC', weight: 60 },
          { symbol: 'ETH', weight: 40 },
        ],
      })
    );
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(commitInvestmentTransactionMock).toHaveBeenCalledTimes(1);
    const commitInput = commitInvestmentTransactionMock.mock.calls[0][1];
    expect(commitInput.legs).toHaveLength(2);
    // No normalization: BTC's allocation is exactly 60% of amount, not
    // rescaled against some other total.
    expect(commitInput.legs.find((l: { symbol: string }) => l.symbol === 'BTC').totalValue).toBeCloseTo(60, 2);
    expect(commitInput.legs.find((l: { symbol: string }) => l.symbol === 'ETH').totalValue).toBeCloseTo(40, 2);
  });

  it('invest(): BTC 50 + ETH 30 (sums to 80, not 100) is rejected — whole basket, zero writes', async () => {
    getPortfolioMock.mockResolvedValue(basePortfolio({ cashBalance: 1_000 }));
    getPricesMock.mockResolvedValue({ BTC: TRUSTED_BTC_PRICE, ETH: 3_400 });

    const res = await POST(
      postRequest({
        action: 'invest',
        bagId: 'bag_1',
        amount: 100,
        composition: [
          { symbol: 'BTC', weight: 50 },
          { symbol: 'ETH', weight: 30 },
        ],
      })
    );
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.ok).toBe(false);
    expect(data.trades).toEqual([]);
    expect(data.error).toMatch(/sum to exactly 100/);
    expect(commitInvestmentTransactionMock).not.toHaveBeenCalled();
  });

  it('invest(): BTC 70 + ETH 50 (sums to 120, not 100) is rejected — whole basket, zero writes', async () => {
    getPortfolioMock.mockResolvedValue(basePortfolio({ cashBalance: 1_000 }));
    getPricesMock.mockResolvedValue({ BTC: TRUSTED_BTC_PRICE, ETH: 3_400 });

    const res = await POST(
      postRequest({
        action: 'invest',
        bagId: 'bag_1',
        amount: 100,
        composition: [
          { symbol: 'BTC', weight: 70 },
          { symbol: 'ETH', weight: 50 },
        ],
      })
    );
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.ok).toBe(false);
    expect(data.trades).toEqual([]);
    expect(data.error).toMatch(/sum to exactly 100/);
    expect(commitInvestmentTransactionMock).not.toHaveBeenCalled();
  });

  it('invest(): BTC 60 + BTC 40 (duplicate symbol) is rejected even though the weights would sum to 100', async () => {
    getPortfolioMock.mockResolvedValue(basePortfolio({ cashBalance: 1_000 }));
    getPricesMock.mockResolvedValue({ BTC: TRUSTED_BTC_PRICE });

    const res = await POST(
      postRequest({
        action: 'invest',
        bagId: 'bag_1',
        amount: 100,
        composition: [
          { symbol: 'BTC', weight: 60 },
          { symbol: 'BTC', weight: 40 },
        ],
      })
    );
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.ok).toBe(false);
    expect(data.trades).toEqual([]);
    expect(data.error).toMatch(/Duplicate symbol "BTC"/);
    expect(commitInvestmentTransactionMock).not.toHaveBeenCalled();
  });

  it('invest(): a 0-weight leg is now rejected outright (no longer silently skipped) — composition must sum to exactly 100 from strictly positive weights', async () => {
    getPortfolioMock.mockResolvedValue(basePortfolio({ cashBalance: 1_000 }));
    getPricesMock.mockResolvedValue({ BTC: TRUSTED_BTC_PRICE });

    const res = await POST(
      postRequest({
        action: 'invest',
        bagId: 'bag_1',
        amount: 100,
        composition: [
          { symbol: 'BTC', weight: 100 },
          { symbol: 'ETH', weight: 0 },
        ],
      })
    );
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.ok).toBe(false);
    expect(data.trades).toEqual([]);
    expect(data.error).toMatch(/ETH.*greater than 0/);
    expect(commitInvestmentTransactionMock).not.toHaveBeenCalled();
  });

  it('invest(): a negative weight is rejected outright', async () => {
    getPortfolioMock.mockResolvedValue(basePortfolio({ cashBalance: 1_000 }));
    getPricesMock.mockResolvedValue({ BTC: TRUSTED_BTC_PRICE, ETH: 3_400 });

    const res = await POST(
      postRequest({
        action: 'invest',
        bagId: 'bag_1',
        amount: 100,
        composition: [
          { symbol: 'BTC', weight: 110 },
          { symbol: 'ETH', weight: -10 },
        ],
      })
    );
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.ok).toBe(false);
    expect(data.trades).toEqual([]);
    expect(data.error).toMatch(/ETH.*greater than 0/);
    expect(commitInvestmentTransactionMock).not.toHaveBeenCalled();
  });

  it('invest(): every leg gets a distinct client_trade_id even within one atomic commit call', async () => {
    getPortfolioMock.mockResolvedValue(basePortfolio({ cashBalance: 1_000 }));
    getPricesMock.mockResolvedValue({ BTC: TRUSTED_BTC_PRICE, ETH: 3_400 });

    await POST(
      postRequest({
        action: 'invest',
        bagId: 'bag_1',
        amount: 100,
        composition: [
          { symbol: 'BTC', weight: 60 },
          { symbol: 'ETH', weight: 40 },
        ],
      })
    );

    const commitInput = commitInvestmentTransactionMock.mock.calls[0][1];
    const ids = commitInput.legs.map((leg: { clientTradeId: string }) => leg.clientTradeId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('invest(): a client-supplied investmentId is passed straight through as the whole-basket idempotency key', async () => {
    getPortfolioMock.mockResolvedValue(basePortfolio({ cashBalance: 1_000 }));
    getPricesMock.mockResolvedValue({ BTC: TRUSTED_BTC_PRICE });

    await POST(
      postRequest({
        action: 'invest',
        bagId: 'bag_1',
        amount: 100,
        investmentId: 'basket_retry_42',
        composition: [{ symbol: 'BTC', weight: 100 }],
      })
    );

    const commitInput = commitInvestmentTransactionMock.mock.calls[0][1];
    expect(commitInput.investmentId).toBe('basket_retry_42');
  });

  it('invest(): a retried request (same investmentId, alreadyApplied) returns 200 with the first commit\'s trades, never a second write', async () => {
    getPortfolioMock.mockResolvedValue(basePortfolio({ cashBalance: 1_000 }));
    getPricesMock.mockResolvedValue({ BTC: TRUSTED_BTC_PRICE });
    commitInvestmentTransactionMock.mockResolvedValue({
      ok: true,
      alreadyApplied: true,
      tradeIds: ['trade_1'],
      pointsAwarded: 0,
      portfolioVersion: 4,
    });

    const res = await POST(
      postRequest({
        action: 'invest',
        bagId: 'bag_1',
        amount: 100,
        investmentId: 'basket_retry_42',
        composition: [{ symbol: 'BTC', weight: 100 }],
      })
    );
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(commitInvestmentTransactionMock).toHaveBeenCalledTimes(1);
  });

  it('invest(): a stale-portfolio commit failure returns 409 so the client can re-plan and retry — no partial write', async () => {
    getPortfolioMock.mockResolvedValue(basePortfolio({ cashBalance: 1_000 }));
    getPricesMock.mockResolvedValue({ BTC: TRUSTED_BTC_PRICE });
    commitInvestmentTransactionMock.mockResolvedValue({ ok: false, error: 'PORTFOLIO_STALE' });

    const res = await POST(
      postRequest({
        action: 'invest',
        bagId: 'bag_1',
        amount: 100,
        composition: [{ symbol: 'BTC', weight: 100 }],
      })
    );
    const data = await res.json();

    expect(res.status).toBe(409);
    expect(data.ok).toBe(false);
    expect(data.trades).toEqual([]);
  });

  it('single trade: a CLIENT_TRADE_ID_CONFLICT commit failure returns 409, a stable code, a correlation id, and no raw DB detail', async () => {
    getPortfolioMock.mockResolvedValue(basePortfolio());
    getPriceMock.mockResolvedValue(TRUSTED_BTC_PRICE);
    commitInvestmentTransactionMock.mockResolvedValue({ ok: false, error: 'CLIENT_TRADE_ID_CONFLICT' });

    const res = await POST(postRequest({ symbol: 'BTC', side: 'BUY', quantity: 1, clientTradeId: 'reused-id' }));
    const data = await res.json();

    expect(res.status).toBe(409);
    expect(data.ok).toBe(false);
    expect(data.error).toBe('CLIENT_TRADE_ID_CONFLICT');
    expect(data.code).toBe('CLIENT_TRADE_ID_CONFLICT');
    expect(typeof data.requestId).toBe('string');
    expect(data.trades).toEqual([]);
    // Never the raw SQL/constraint text a real Postgres error would carry.
    expect(JSON.stringify(data)).not.toMatch(/constraint|duplicate key|SQLSTATE/i);
  });


  it('invest(): a raw DB commit failure never leaks the raw error to the client — stable code + correlation id only', async () => {
    getPortfolioMock.mockResolvedValue(basePortfolio({ cashBalance: 1_000 }));
    getPricesMock.mockResolvedValue({ BTC: TRUSTED_BTC_PRICE });
    commitInvestmentTransactionMock.mockResolvedValue({
      ok: false,
      error: 'duplicate key value violates unique constraint "trades_user_id_client_trade_id_key"',
    });

    const res = await POST(
      postRequest({
        action: 'invest',
        bagId: 'bag_1',
        amount: 100,
        composition: [{ symbol: 'BTC', weight: 100 }],
      })
    );
    const data = await res.json();

    expect(res.status).toBe(500);
    expect(data.ok).toBe(false);
    expect(data.code).toBe('INVESTMENT_COMMIT_FAILED');
    expect(data.trades).toEqual([]);
    expect(JSON.stringify(data)).not.toMatch(/duplicate key/i);
  });
});
