import type { NavSnapshotPoint } from '@/types';

// Pure helpers for the recorded-NAV Performance chart. Display-only math on
// decimal strings (NAV per share), never used for accounting.

export type RecordedRange = '24H' | '7D' | '30D' | 'YTD' | 'ALL';
export const RECORDED_RANGES: RecordedRange[] = ['24H', '7D', '30D', 'YTD', 'ALL'];

const HOUR = 60 * 60 * 1000;

export function rangeStart(range: RecordedRange, now: number): number {
  switch (range) {
    case '24H':
      return now - 24 * HOUR;
    case '7D':
      return now - 7 * 24 * HOUR;
    case '30D':
      return now - 30 * 24 * HOUR;
    case 'YTD':
      return Date.UTC(new Date(now).getUTCFullYear(), 0, 1);
    case 'ALL':
      return Number.NEGATIVE_INFINITY;
  }
}

export interface RecordedSeries {
  points: { t: number; value: number }[];
  /** % change first -> last point of the window. */
  changePct: number;
  /** Absolute change of NAV per share, quote currency. */
  changeAbs: number;
  high: number;
  low: number;
}

/**
 * Snapshots inside `range` (oldest first), starting from the last snapshot at
 * or before the range start when there is one, so the window's change is
 * measured from the value at its start. Null when fewer than two points.
 */
export function recordedSeries(points: NavSnapshotPoint[], range: RecordedRange, now: number = Date.now()): RecordedSeries | null {
  const start = rangeStart(range, now);
  const parsed = points
    .map((p) => ({ t: Date.parse(p.capturedAt), value: Number(p.navPerShare) }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.value) && p.value > 0);
  let firstInside = parsed.findIndex((p) => p.t >= start);
  if (firstInside === -1) return null;
  if (firstInside > 0) firstInside -= 1; // include the value at the window's start
  const window = parsed.slice(firstInside);
  if (window.length < 2) return null;
  const first = window[0].value;
  const last = window[window.length - 1].value;
  const values = window.map((p) => p.value);
  return {
    points: window,
    changePct: ((last - first) / first) * 100,
    changeAbs: last - first,
    high: Math.max(...values),
    low: Math.min(...values),
  };
}
