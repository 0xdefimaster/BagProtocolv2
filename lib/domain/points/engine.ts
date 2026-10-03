// Every $10 of net realized profit = 1 BAG Point.
// Points are always derived from totalRealizedPnL — never accumulated by
// summing per-trade deltas — so there's a single source of truth and no
// drift from rounding or replayed events.
export const USD_PER_POINT = 10;

export function realizedPnLToPoints(totalRealizedPnL: number): number {
  if (totalRealizedPnL <= 0) return 0;
  return Math.floor(totalRealizedPnL / USD_PER_POINT);
}
