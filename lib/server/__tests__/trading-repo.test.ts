import { describe, expect, it, vi } from 'vitest';
import { commitInvestmentTransaction, getTradesByIds } from '../trading-repo';
import { Portfolio } from '@/types/domain';

// -----------------------------------------------------------------------------
// Phase 18.7 — commitInvestmentTransaction() is the ONLY write path used by
// app/api/trades/route.ts to apply a priced/validated plan (a whole
// invest() basket, or a single BUY/SELL folded through applyTrade() once).
// It wraps the commit_investment_transaction Postgres RPC (supabase/
// schema.sql) that does the portfolio mutation + every trade insert +
// points/related accounting inside ONE real DB transaction.
//
// These tests mock the Supabase client at the `.rpc()`/`.from()` boundary —
// same convention as lib/server/__tests__/box-repo.test.ts for buy_box().
// They verify this wrapper calls the RPC with the exact param shape the SQL
// function expects and maps its typed/raw errors correctly. They do NOT
// exercise the RPC's own SQL-level atomicity (the `for update` row lock,
// the real ROLLBACK on a mid-transaction failure, concurrent-request
// behaviour under real Postgres) — that requires a real Postgres instance,
// which this test environment does not have. See docs/PHASE_18_7_REPORT.md.
// -----------------------------------------------------------------------------

function fakePortfolio(overrides: Partial<Portfolio> = {}): Portfolio {
  return {
    userId: 'user_1',
    cashBalance: 900,
    positions: [{ symbol: 'BTC', quantity: 0.01, avgCost: 65_000 }],
    realizedPnL: 0,
    portfolioVersion: 3,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function fakeAdmin(overrides: { rpc?: unknown } = {}) {
  const rpc = overrides.rpc ?? vi.fn();
  return { rpc } as unknown as { rpc: ReturnType<typeof vi.fn> };
}

describe('commitInvestmentTransaction', () => {
  it('calls commit_investment_transaction with the exact param shape the RPC expects', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { alreadyApplied: false, tradeIds: ['t1'], finalCashBalance: 900, finalRealizedPnl: 0, pointsAwarded: 0, portfolioVersion: 6 },
      error: null,
    });
    const admin = fakeAdmin({ rpc });

    await commitInvestmentTransaction(admin as never, {
      userId: 'user_1',
      investmentId: 'inv_1',
      bagId: 'bag_1',
      expectedPortfolioVersion: 5,
      finalPortfolio: fakePortfolio(),
      legs: [
        {
          symbol: 'BTC',
          side: 'BUY',
          quantity: 0.01,
          price: 65_000,
          totalValue: 650,
          realizedPnL: 0,
          clientTradeId: 'leg_1',
        },
      ],
    });

    expect(rpc).toHaveBeenCalledWith('commit_investment_transaction', {
      p_user_id: 'user_1',
      p_investment_id: 'inv_1',
      p_bag_id: 'bag_1',
      p_expected_portfolio_version: 5,
      p_final_cash_balance: 900,
      p_final_realized_pnl: 0,
      p_positions: [{ symbol: 'BTC', quantity: 0.01, avg_cost: 65_000 }],
      p_trades: [
        expect.objectContaining({
          symbol: 'BTC',
          side: 'BUY',
          quantity: 0.01,
          price: 65_000,
          total_value: 650,
          realized_pnl: 0,
          client_trade_id: 'leg_1',
        }),
      ],
      p_season_id: null,
      p_current_bag_points: 0,
      p_current_points_spent: 0,
    });
  });

  it('sends every leg in ONE call, never one RPC call per leg', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { alreadyApplied: false, tradeIds: ['t1', 't2'], finalCashBalance: 500, finalRealizedPnl: 0, pointsAwarded: 0, portfolioVersion: 6 },
      error: null,
    });
    const admin = fakeAdmin({ rpc });

    await commitInvestmentTransaction(admin as never, {
      userId: 'user_1',
      investmentId: 'inv_basket',
      bagId: 'bag_1',
      expectedPortfolioVersion: 5,
      finalPortfolio: fakePortfolio({ cashBalance: 500 }),
      legs: [
        { symbol: 'BTC', side: 'BUY', quantity: 0.005, price: 65_000, totalValue: 325, realizedPnL: 0, clientTradeId: 'leg_1' },
        { symbol: 'ETH', side: 'BUY', quantity: 0.1, price: 3_400, totalValue: 340, realizedPnL: 0, clientTradeId: 'leg_2' },
      ],
    });

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0][1].p_trades).toHaveLength(2);
  });

  it('maps a PORTFOLIO_STALE RPC error to a typed outcome — never a raw error string', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: 'PORTFOLIO_STALE' } });
    const admin = fakeAdmin({ rpc });

    const outcome = await commitInvestmentTransaction(admin as never, {
      userId: 'user_1',
      investmentId: 'inv_1',
      expectedPortfolioVersion: 5,
      finalPortfolio: fakePortfolio(),
      legs: [],
    });

    expect(outcome).toEqual({ ok: false, error: 'PORTFOLIO_STALE' });
  });

  it('Phase 18.9 — maps a CLIENT_TRADE_ID_CONFLICT RPC error to a typed outcome — never a raw error string', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: { message: 'CLIENT_TRADE_ID_CONFLICT: leg_1' },
    });
    const admin = fakeAdmin({ rpc });

    const outcome = await commitInvestmentTransaction(admin as never, {
      userId: 'user_1',
      investmentId: 'inv_1',
      expectedPortfolioVersion: 5,
      finalPortfolio: fakePortfolio(),
      legs: [],
    });

    expect(outcome).toEqual({ ok: false, error: 'CLIENT_TRADE_ID_CONFLICT' });
  });

  it('Phase 18.9 — sends p_expected_portfolio_version, NOT a cash balance, as the staleness param', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { alreadyApplied: false, tradeIds: ['t1'], finalCashBalance: 900, finalRealizedPnl: 0, pointsAwarded: 0, portfolioVersion: 6 },
      error: null,
    });
    const admin = fakeAdmin({ rpc });

    await commitInvestmentTransaction(admin as never, {
      userId: 'user_1',
      investmentId: 'inv_1',
      expectedPortfolioVersion: 5,
      finalPortfolio: fakePortfolio(),
      legs: [],
    });

    expect(rpc.mock.calls[0][1]).toMatchObject({ p_expected_portfolio_version: 5 });
    expect(rpc.mock.calls[0][1]).not.toHaveProperty('p_expected_cash_balance');
  });

  it('Phase 18.9 — a successful commit surfaces the RPC-returned portfolioVersion, not the caller-supplied expected one', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { alreadyApplied: false, tradeIds: ['t1'], finalCashBalance: 900, finalRealizedPnl: 0, pointsAwarded: 0, portfolioVersion: 6 },
      error: null,
    });
    const admin = fakeAdmin({ rpc });

    const outcome = await commitInvestmentTransaction(admin as never, {
      userId: 'user_1',
      investmentId: 'inv_1',
      expectedPortfolioVersion: 5, // the OLD version this plan was computed against
      finalPortfolio: fakePortfolio(),
      legs: [],
    });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.portfolioVersion).toBe(6); // the NEW version after commit
  });

  it('maps a PORTFOLIO_NOT_FOUND RPC error to a typed outcome', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: 'PORTFOLIO_NOT_FOUND' } });
    const admin = fakeAdmin({ rpc });

    const outcome = await commitInvestmentTransaction(admin as never, {
      userId: 'user_1',
      investmentId: 'inv_1',
      expectedPortfolioVersion: 5,
      finalPortfolio: fakePortfolio(),
      legs: [],
    });

    expect(outcome).toEqual({ ok: false, error: 'PORTFOLIO_NOT_FOUND' });
  });

  it('a raw/unrecognized RPC error is passed through as-is for the route to sanitize before it reaches a client', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: { message: 'connection terminated unexpectedly' },
    });
    const admin = fakeAdmin({ rpc });

    const outcome = await commitInvestmentTransaction(admin as never, {
      userId: 'user_1',
      investmentId: 'inv_1',
      expectedPortfolioVersion: 5,
      finalPortfolio: fakePortfolio(),
      legs: [],
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toBe('connection terminated unexpectedly');
  });

  it('a replayed/duplicated investmentId returns alreadyApplied — the wrapper surfaces it, never treats it as a failure', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { alreadyApplied: true, tradeIds: ['t1'], finalCashBalance: 900, finalRealizedPnl: 0, pointsAwarded: 0, portfolioVersion: 5 },
      error: null,
    });
    const admin = fakeAdmin({ rpc });

    const outcome = await commitInvestmentTransaction(admin as never, {
      userId: 'user_1',
      investmentId: 'inv_1',
      expectedPortfolioVersion: 5,
      finalPortfolio: fakePortfolio(),
      legs: [],
    });

    expect(outcome).toEqual({ ok: true, alreadyApplied: true, tradeIds: ['t1'], pointsAwarded: 0, portfolioVersion: 5 });
  });

  it('passes seasonId/currentBagPoints/currentPointsSpent through for a SELL leg (points accounting inside the same call)', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { alreadyApplied: false, tradeIds: ['t1'], finalCashBalance: 950, finalRealizedPnl: 50, pointsAwarded: 5, portfolioVersion: 6 },
      error: null,
    });
    const admin = fakeAdmin({ rpc });

    await commitInvestmentTransaction(admin as never, {
      userId: 'user_1',
      investmentId: 'inv_1',
      expectedPortfolioVersion: 5,
      finalPortfolio: fakePortfolio({ cashBalance: 950, realizedPnL: 50 }),
      legs: [
        { symbol: 'BTC', side: 'SELL', quantity: 0.01, price: 70_000, totalValue: 700, realizedPnL: 50, clientTradeId: 'leg_1' },
      ],
      seasonId: 'season_1',
      currentBagPoints: 2,
      currentPointsSpent: 0,
    });

    expect(rpc.mock.calls[0][1]).toMatchObject({
      p_season_id: 'season_1',
      p_current_bag_points: 2,
      p_current_points_spent: 0,
    });
  });
});

describe('getTradesByIds', () => {
  it('returns an empty array without querying when given no ids', async () => {
    const from = vi.fn();
    const admin = { rpc: vi.fn(), from } as unknown as { rpc: ReturnType<typeof vi.fn>; from: typeof from };

    const trades = await getTradesByIds(admin as never, []);

    expect(trades).toEqual([]);
    expect(from).not.toHaveBeenCalled();
  });

  it('queries trades by id and maps rows back to the Trade shape', async () => {
    const inMock = vi.fn().mockResolvedValue({
      data: [
        {
          id: 't1',
          user_id: 'user_1',
          symbol: 'BTC',
          side: 'BUY',
          quantity: 0.01,
          price: 65_000,
          total_value: 650,
          realized_pnl: 0,
          bag_id: 'bag_1',
          client_trade_id: 'leg_1',
          created_at: '2026-01-01T00:00:00Z',
        },
      ],
      error: null,
    });
    const select = vi.fn().mockReturnValue({ in: inMock });
    const from = vi.fn().mockReturnValue({ select });
    const admin = { rpc: vi.fn(), from } as unknown as { rpc: ReturnType<typeof vi.fn>; from: typeof from };

    const trades = await getTradesByIds(admin as never, ['t1']);

    expect(from).toHaveBeenCalledWith('trades');
    expect(inMock).toHaveBeenCalledWith('id', ['t1']);
    expect(trades).toEqual([
      expect.objectContaining({ id: 't1', symbol: 'BTC', side: 'BUY', bagId: 'bag_1', clientTradeId: 'leg_1' }),
    ]);
  });
});
