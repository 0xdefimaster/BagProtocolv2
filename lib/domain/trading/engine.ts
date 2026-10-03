import { Portfolio, Position, TradeSide } from '@/types/domain';

export interface ApplyTradeInput {
  portfolio: Portfolio;
  symbol: string;
  side: TradeSide;
  quantity: number;
  price: number;
}

export interface ApplyTradeOutput {
  ok: boolean;
  error?: string;
  portfolio?: Portfolio;
  totalValue?: number;
  realizedPnL?: number;
}

const EPSILON = 1e-9;

/**
 * Pure function — given a portfolio snapshot and a trade request, returns the
 * resulting portfolio (or a validation error). No I/O, no randomness, no
 * side effects: this is what a server-side handler would run after loading
 * the caller's portfolio from the database and before saving it back.
 */
export function applyTrade(input: ApplyTradeInput): ApplyTradeOutput {
  const { portfolio, symbol, side, price } = input;
  const quantity = round(input.quantity, 8);

  if (!Number.isFinite(quantity) || quantity <= 0) {
    return { ok: false, error: 'Quantity must be greater than zero.' };
  }
  if (!Number.isFinite(price) || price <= 0) {
    return { ok: false, error: 'Invalid market price.' };
  }

  const totalValue = round(quantity * price, 2);
  const positions = portfolio.positions.map((p) => ({ ...p }));
  const existingIndex = positions.findIndex((p) => p.symbol === symbol);

  if (side === 'BUY') {
    if (totalValue > portfolio.cashBalance + EPSILON) {
      return { ok: false, error: 'Insufficient cash balance for this trade.' };
    }

    if (existingIndex >= 0) {
      const existing = positions[existingIndex];
      const newQuantity = round(existing.quantity + quantity, 8);
      const newAvgCost = round(
        (existing.avgCost * existing.quantity + price * quantity) / newQuantity,
        8
      );
      positions[existingIndex] = { ...existing, quantity: newQuantity, avgCost: newAvgCost };
    } else {
      positions.push({ symbol, quantity, avgCost: price });
    }

    const nextPortfolio: Portfolio = {
      ...portfolio,
      cashBalance: round(portfolio.cashBalance - totalValue, 2),
      positions,
      updatedAt: new Date().toISOString(),
    };

    return { ok: true, portfolio: nextPortfolio, totalValue, realizedPnL: 0 };
  }

  // SELL
  if (existingIndex < 0) {
    return { ok: false, error: 'You do not own this asset.' };
  }

  const existing = positions[existingIndex];
  if (quantity > existing.quantity + EPSILON) {
    return { ok: false, error: 'You cannot sell more than you own.' };
  }

  const realizedPnL = round((price - existing.avgCost) * quantity, 2);
  const remainingQuantity = round(existing.quantity - quantity, 8);

  if (remainingQuantity <= EPSILON) {
    positions.splice(existingIndex, 1);
  } else {
    positions[existingIndex] = { ...existing, quantity: remainingQuantity };
  }

  const nextPortfolio: Portfolio = {
    ...portfolio,
    cashBalance: round(portfolio.cashBalance + totalValue, 2),
    positions,
    realizedPnL: round(portfolio.realizedPnL + realizedPnL, 2),
    updatedAt: new Date().toISOString(),
  };

  return { ok: true, portfolio: nextPortfolio, totalValue, realizedPnL };
}

export function computePositionsValue(positions: Position[], prices: Record<string, number>): number {
  return round(
    positions.reduce((sum, p) => sum + p.quantity * (prices[p.symbol] ?? p.avgCost), 0),
    2
  );
}

export function computeUnrealizedPnL(positions: Position[], prices: Record<string, number>): number {
  return round(
    positions.reduce((sum, p) => {
      const price = prices[p.symbol] ?? p.avgCost;
      return sum + (price - p.avgCost) * p.quantity;
    }, 0),
    2
  );
}

export function round(n: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round((n + Number.EPSILON) * factor) / factor;
}
