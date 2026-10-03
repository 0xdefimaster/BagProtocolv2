export type TimeRange = '1D' | '7D' | '30D' | '90D' | '1Y' | 'ALL';

export const TIME_RANGES: TimeRange[] = ['1D', '7D', '30D', '90D', '1Y', 'ALL'];

const POINTS_BY_RANGE: Record<TimeRange, number> = {
  '1D': 24,
  '7D': 28,
  '30D': 30,
  '90D': 36,
  '1Y': 52,
  ALL: 60,
};

// Small deterministic PRNG so charts stay stable across renders/refreshes
// for the same bag id + range, without needing a backend.
function mulberry32(seed: number) {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  }
  return h;
}

export interface SeriesPoint {
  label: string;
  value: number; // cumulative % change from series start
}

export interface PerformanceSeries {
  points: SeriesPoint[];
  changePct: number;
  high: number;
  low: number;
}

const RANGE_LABELS: Record<TimeRange, (i: number, n: number) => string> = {
  '1D': (i) => `${i}:00`,
  '7D': (i) => `Day ${i + 1}`,
  '30D': (i) => `Day ${i + 1}`,
  '90D': (i) => `Wk ${i + 1}`,
  '1Y': (i) => `Wk ${i + 1}`,
  ALL: (i) => `M${i + 1}`,
};

// Anchor points so the generated walk still lands near the bag's known
// headline numbers for the ranges we actually track (7D / 30D / YTD).
function targetChangeForRange(range: TimeRange, perf7d: number, perf30d: number, perfYtd: number): number {
  switch (range) {
    case '1D':
      return perf7d / 7;
    case '7D':
      return perf7d;
    case '30D':
      return perf30d;
    case '90D':
      return perf30d * 2.6;
    case '1Y':
      return perfYtd;
    case 'ALL':
      return perfYtd * 1.4;
  }
}

export function generatePerformanceSeries(
  bagId: string,
  range: TimeRange,
  perf7d: number,
  perf30d: number,
  perfYtd: number
): PerformanceSeries {
  const n = POINTS_BY_RANGE[range];
  const rand = mulberry32(hashSeed(`${bagId}:${range}`));
  const target = targetChangeForRange(range, perf7d, perf30d, perfYtd);
  const volatility = Math.max(1.2, Math.abs(target) / 6);

  const raw: number[] = [0];
  for (let i = 1; i < n; i++) {
    const drift = target / n;
    const noise = (rand() - 0.5) * volatility;
    raw.push(raw[i - 1] + drift + noise);
  }

  // Rescale so the series ends exactly on the known target value.
  const rawEnd = raw[n - 1];
  const correction = rawEnd !== 0 ? target / rawEnd : 1;
  const values = raw.map((v, i) => (i === 0 ? 0 : v * correction));

  const labelFn = RANGE_LABELS[range];
  const points: SeriesPoint[] = values.map((value, i) => ({
    label: labelFn(i, n),
    value: Math.round(value * 100) / 100,
  }));

  return {
    points,
    changePct: points[points.length - 1].value,
    high: Math.max(...values),
    low: Math.min(...values),
  };
}
