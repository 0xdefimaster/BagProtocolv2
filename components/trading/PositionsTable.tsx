'use client';

import { Position } from '@/types/domain';

interface PositionsTableProps {
  positions: Position[];
  prices: Record<string, number>;
  onSell: (symbol: string) => void;
}

export function PositionsTable({ positions, prices, onSell }: PositionsTableProps) {
  if (positions.length === 0) {
    return <div className="positions-empty">No open positions yet — invest in a Bag or buy an asset below to get started.</div>;
  }

  return (
    <table className="positions-table">
      <thead>
        <tr>
          <th>Asset</th>
          <th>Quantity</th>
          <th>Avg Cost</th>
          <th>Current Price</th>
          <th>Unrealized PnL</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {positions.map((p) => {
          const price = prices[p.symbol] ?? p.avgCost;
          const value = price * p.quantity;
          const pnl = (price - p.avgCost) * p.quantity;
          return (
            <tr key={p.symbol}>
              <td style={{ fontWeight: 600 }}>{p.symbol}</td>
              <td className="mono">{p.quantity.toLocaleString(undefined, { maximumFractionDigits: 6 })}</td>
              <td className="mono">${p.avgCost.toLocaleString(undefined, { maximumFractionDigits: 4 })}</td>
              <td className="mono">${price.toLocaleString(undefined, { maximumFractionDigits: 4 })}</td>
              <td className="mono" style={{ color: pnl >= 0 ? 'var(--emerald)' : '#E0847A' }}>
                {pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}{' '}
                <span style={{ color: 'var(--mute)' }}>(${value.toFixed(0)})</span>
              </td>
              <td>
                <button className="btn btn-ghost" style={{ padding: '6px 14px', fontSize: 12 }} onClick={() => onSell(p.symbol)}>
                  Sell
                </button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
