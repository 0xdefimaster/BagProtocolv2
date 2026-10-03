import { SupabaseClient } from '@supabase/supabase-js';
import { Portfolio, Position, Trade, TradeSide } from '@/types/domain';
import { STARTING_DEMO_BALANCE } from '@/lib/config/market';

// -----------------------------------------------------------------------------
// Supabase-backed equivalent of the old lib/services/trading-service.ts
// read/write helpers. Same shapes (Portfolio, Position, Trade) so
// lib/domain/trading/engine.ts's pure applyTrade() is reused unchanged —
// only the persistence layer moved from localStorage to Postgres.
//
// Server-only: called exclusively from app/api/portfolio and app/api/trades
// route handlers, using the service-role client so writes can't be spoofed
// by a client that guesses at table names.
// -----------------------------------------------------------------------------

interface PortfolioRow {
  user_id: string;
  cash_balance: number;
  realized_pnl: number;
  portfolio_version: number;
  created_at: string;
  updated_at: string;
}

interface PositionRow {
  user_id: string;
  symbol: string;
  quantity: number;
  avg_cost: number;
}

interface TradeRow {
  id: string;
  user_id: string;
  symbol: string;
  side: TradeSide;
  quantity: number;
  price: number;
  total_value: number;
  realized_pnl: number;
  bag_id: string | null;
  client_trade_id: string | null;
  created_at: string;
}

function tradeFromRow(row: TradeRow): Trade {
  return {
    id: row.id,
    userId: row.user_id,
    symbol: row.symbol,
    side: row.side,
    quantity: row.quantity,
    price: row.price,
    totalValue: row.total_value,
    realizedPnL: row.realized_pnl,
    bagId: row.bag_id ?? undefined,
    clientTradeId: row.client_trade_id ?? undefined,
    createdAt: row.created_at,
  };
}

/** Loads (or lazily creates) the 1:1 portfolio row plus every open position. */
export async function getPortfolio(admin: SupabaseClient, userId: string): Promise<Portfolio> {
  const { data: portfolioRow, error: portfolioError } = await admin
    .from('portfolios')
    .select('user_id, cash_balance, realized_pnl, portfolio_version, created_at, updated_at')
    .eq('user_id', userId)
    .maybeSingle<PortfolioRow>();

  if (portfolioError) throw new Error(portfolioError.message);

  let row = portfolioRow;
  if (!row) {
    // Should already exist from signup (app/api/auth/verify) — created here
    // too so an existing user from before this migration doesn't 500 out.
    const { data: created, error: insertError } = await admin
      .from('portfolios')
      .insert({ user_id: userId, cash_balance: STARTING_DEMO_BALANCE })
      .select('user_id, cash_balance, realized_pnl, portfolio_version, created_at, updated_at')
      .single<PortfolioRow>();
    if (insertError) throw new Error(insertError.message);
    row = created;
  }

  const { data: positionRows, error: positionsError } = await admin
    .from('positions')
    .select('user_id, symbol, quantity, avg_cost')
    .eq('user_id', userId);

  if (positionsError) throw new Error(positionsError.message);

  const positions: Position[] = (positionRows ?? []).map((p: PositionRow) => ({
    symbol: p.symbol,
    quantity: p.quantity,
    avgCost: p.avg_cost,
  }));

  return {
    userId: row.user_id,
    cashBalance: row.cash_balance,
    positions,
    realizedPnL: row.realized_pnl,
    portfolioVersion: row.portfolio_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Persists the post-trade portfolio: updates the balance/PnL row and
 * reconciles the positions table (upsert survivors, delete closed-out
 * symbols) against what applyTrade() computed.
 */
export async function persistPortfolio(admin: SupabaseClient, portfolio: Portfolio): Promise<void> {
  const { error: updateError } = await admin
    .from('portfolios')
    .update({
      cash_balance: portfolio.cashBalance,
      realized_pnl: portfolio.realizedPnL,
      updated_at: portfolio.updatedAt,
    })
    .eq('user_id', portfolio.userId);
  if (updateError) throw new Error(updateError.message);

  const { data: existingRows, error: existingError } = await admin
    .from('positions')
    .select('symbol')
    .eq('user_id', portfolio.userId);
  if (existingError) throw new Error(existingError.message);

  const keepSymbols = new Set(portfolio.positions.map((p) => p.symbol));
  const staleSymbols = (existingRows ?? [])
    .map((r: { symbol: string }) => r.symbol)
    .filter((symbol: string) => !keepSymbols.has(symbol));

  if (staleSymbols.length > 0) {
    const { error: deleteError } = await admin
      .from('positions')
      .delete()
      .eq('user_id', portfolio.userId)
      .in('symbol', staleSymbols);
    if (deleteError) throw new Error(deleteError.message);
  }

  if (portfolio.positions.length > 0) {
    const { error: upsertError } = await admin.from('positions').upsert(
      portfolio.positions.map((p) => ({
        user_id: portfolio.userId,
        symbol: p.symbol,
        quantity: p.quantity,
        avg_cost: p.avgCost,
      })),
      { onConflict: 'user_id,symbol' }
    );
    if (upsertError) throw new Error(upsertError.message);
  }
}

export interface InsertTradeInput {
  id: string;
  userId: string;
  symbol: string;
  side: TradeSide;
  quantity: number;
  price: number;
  totalValue: number;
  realizedPnL: number;
  bagId?: string;
  clientTradeId?: string;
  createdAt: string;
}

/**
 * Inserts a trade row. `trades` has a unique (user_id, client_trade_id)
 * constraint, so a retried request with the same clientTradeId hits a
 * conflict here instead of double-applying — caller should check
 * findTradeByClientId() first for the common case, this is the belt-and-
 * braces backstop against a race between two concurrent requests.
 */
export async function insertTrade(admin: SupabaseClient, input: InsertTradeInput): Promise<Trade> {
  const { data, error } = await admin
    .from('trades')
    .insert({
      id: input.id,
      user_id: input.userId,
      symbol: input.symbol,
      side: input.side,
      quantity: input.quantity,
      price: input.price,
      total_value: input.totalValue,
      realized_pnl: input.realizedPnL,
      bag_id: input.bagId ?? null,
      client_trade_id: input.clientTradeId ?? null,
      created_at: input.createdAt,
    })
    .select()
    .single<TradeRow>();

  if (error) throw new Error(error.message);
  return tradeFromRow(data);
}

export async function findTradeByClientId(
  admin: SupabaseClient,
  userId: string,
  clientTradeId: string
): Promise<Trade | null> {
  const { data, error } = await admin
    .from('trades')
    .select()
    .eq('user_id', userId)
    .eq('client_trade_id', clientTradeId)
    .maybeSingle<TradeRow>();

  if (error) throw new Error(error.message);
  return data ? tradeFromRow(data) : null;
}

// -----------------------------------------------------------------------------
// Phase 18.7 — commitInvestmentTransaction() is the ONLY write path the
// trades route uses to apply a priced/validated plan (planInvestment(), or
// a single BUY/SELL folded through applyTrade() once) to the database. It
// wraps the commit_investment_transaction Postgres RPC (supabase/schema.sql)
// which does the portfolio mutation + every trade insert + points/related
// accounting inside ONE real DB transaction — see that RPC's doc comment
// for the row-locking/idempotency/stale-plan reasoning. persistPortfolio()/
// insertTrade() above remain for other, non-commit callers (app/api/
// portfolio's read path, tests) but are no longer called from the trades
// route's commit phase.
//
// Phase 18.9 — two follow-up fixes, both inside the RPC itself (this
// wrapper's job is just to pass the new field through and recognize the
// new error code):
//   1. Staleness used to be judged by cash_balance alone, so two commits
//      that happened to leave cash unchanged (e.g. a BUY roughly offset by
//      an unrelated SELL) but that DID change positions were wrongly
//      accepted as still-fresh. `expectedPortfolioVersion` replaces that —
//      see `Portfolio.portfolioVersion`'s doc comment in types/domain.ts.
//   2. `trades`'s `on conflict (user_id, client_trade_id) do nothing` used
//      to let a colliding client_trade_id silently skip just that one
//      insert while the rest of the commit (portfolio, positions, points)
//      still applied — the RPC now checks every incoming leg against any
//      existing row for its client_trade_id BEFORE any write; a genuine
//      conflict (same id, different trade content) raises
//      CLIENT_TRADE_ID_CONFLICT and the whole commit rolls back.
// -----------------------------------------------------------------------------

export interface CommitLegInput {
  symbol: string;
  side: TradeSide;
  quantity: number;
  price: number;
  totalValue: number;
  realizedPnL: number;
  clientTradeId: string;
}

export interface CommitInvestmentInput {
  userId: string;
  /** One key per whole request (basket or single trade) — never per leg. */
  investmentId: string;
  bagId?: string | null;
  /** portfolio.portfolioVersion as read when the plan was computed — see that field's doc comment in types/domain.ts for why this replaced expectedCashBalance in Phase 18.9. */
  expectedPortfolioVersion: number;
  /** The full portfolio (cashBalance/realizedPnL/positions) after every leg. */
  finalPortfolio: Portfolio;
  legs: CommitLegInput[];
  /** Non-null only when a SELL leg changed realized PnL and points accounting applies. */
  seasonId?: string | null;
  currentBagPoints?: number;
  currentPointsSpent?: number;
}

export type CommitInvestmentOutcome =
  | { ok: true; alreadyApplied: boolean; tradeIds: string[]; pointsAwarded: number; portfolioVersion: number }
  | { ok: false; error: 'PORTFOLIO_NOT_FOUND' | 'PORTFOLIO_STALE' | 'CLIENT_TRADE_ID_CONFLICT' | string };

interface CommitInvestmentRpcResult {
  alreadyApplied: boolean;
  tradeIds: string[];
  finalCashBalance: number;
  finalRealizedPnl: number;
  pointsAwarded: number;
  portfolioVersion: number;
}

export async function commitInvestmentTransaction(
  admin: SupabaseClient,
  input: CommitInvestmentInput
): Promise<CommitInvestmentOutcome> {
  const { data, error } = await admin.rpc('commit_investment_transaction', {
    p_user_id: input.userId,
    p_investment_id: input.investmentId,
    p_bag_id: input.bagId ?? null,
    p_expected_portfolio_version: input.expectedPortfolioVersion,
    p_final_cash_balance: input.finalPortfolio.cashBalance,
    p_final_realized_pnl: input.finalPortfolio.realizedPnL,
    p_positions: input.finalPortfolio.positions.map((p) => ({
      symbol: p.symbol,
      quantity: p.quantity,
      avg_cost: p.avgCost,
    })),
    p_trades: input.legs.map((leg) => ({
      id: crypto.randomUUID(),
      symbol: leg.symbol,
      side: leg.side,
      quantity: leg.quantity,
      price: leg.price,
      total_value: leg.totalValue,
      realized_pnl: leg.realizedPnL,
      client_trade_id: leg.clientTradeId,
    })),
    p_season_id: input.seasonId ?? null,
    p_current_bag_points: input.currentBagPoints ?? 0,
    p_current_points_spent: input.currentPointsSpent ?? 0,
  });

  if (error) {
    if (error.message.includes('PORTFOLIO_NOT_FOUND')) return { ok: false, error: 'PORTFOLIO_NOT_FOUND' };
    if (error.message.includes('PORTFOLIO_STALE')) return { ok: false, error: 'PORTFOLIO_STALE' };
    if (error.message.includes('CLIENT_TRADE_ID_CONFLICT')) return { ok: false, error: 'CLIENT_TRADE_ID_CONFLICT' };
    return { ok: false, error: error.message };
  }

  const result = data as CommitInvestmentRpcResult;
  return {
    ok: true,
    alreadyApplied: result.alreadyApplied,
    tradeIds: result.tradeIds,
    pointsAwarded: result.pointsAwarded,
    portfolioVersion: result.portfolioVersion,
  };
}

/** Fetches trade rows by id, in no particular order — used to hydrate the
 * client response after commitInvestmentTransaction() returns tradeIds. */
export async function getTradesByIds(admin: SupabaseClient, tradeIds: string[]): Promise<Trade[]> {
  if (tradeIds.length === 0) return [];
  const { data, error } = await admin.from('trades').select().in('id', tradeIds);
  if (error) throw new Error(error.message);
  return (data ?? []).map((row: TradeRow) => tradeFromRow(row));
}

export async function listTrades(admin: SupabaseClient, userId: string, limit = 100): Promise<Trade[]> {
  const { data, error } = await admin
    .from('trades')
    .select()
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw new Error(error.message);
  return (data ?? []).map((row: TradeRow) => tradeFromRow(row));
}
