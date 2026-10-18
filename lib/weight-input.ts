// Target weights typed as percentages with up to two decimals ("33.33") <-> basis points (3333), as integers so
// the total is exact (no floating-point sums).

const PERCENT_RE = /^\d{1,3}(\.\d{0,2})?$/;

/** "33.33" -> 3333; null when it isn't a percentage between 0 and 100 with at most two decimals. */
export function percentToBps(value: string): number | null {
  const v = value.trim();
  if (!PERCENT_RE.test(v)) return null;
  const [whole, frac = ''] = v.split('.');
  const bps = parseInt(whole, 10) * 100 + parseInt((frac + '00').slice(0, 2), 10);
  return bps <= 10_000 ? bps : null;
}

/** 3333 -> "33.33", 5000 -> "50". */
export function bpsToPercent(bps: number): string {
  const whole = Math.floor(bps / 100);
  const frac = bps % 100;
  return frac === 0 ? `${whole}` : `${whole}.${frac.toString().padStart(2, '0').replace(/0$/, '')}`;
}

/** Equal weights over `count` assets summing to exactly 10000; the first ones take the remainder. */
export function equalWeightsBps(count: number): number[] {
  if (count <= 0) return [];
  const base = Math.floor(10_000 / count);
  const rest = 10_000 - base * count;
  return Array.from({ length: count }, (_, i) => base + (i < rest ? 1 : 0));
}

/** Splits `total` over `weights` in proportion, as integers summing to exactly `total` (largest remainder first). */
function apportion(weights: number[], total: number): number[] {
  const sum = weights.reduce((s, w) => s + w, 0);
  if (weights.length === 0) return [];
  if (sum <= 0) {
    const base = Math.floor(total / weights.length);
    const rest = total - base * weights.length;
    return weights.map((_, i) => base + (i < rest ? 1 : 0));
  }
  const exact = weights.map((w) => w * total);
  const out = exact.map((x) => Math.floor(x / sum));
  let left = total - out.reduce((s, x) => s + x, 0);
  const order = exact.map((x, i) => ({ i, r: x % sum })).sort((a, b) => b.r - a.r || a.i - b.i);
  for (let k = 0; left > 0; k = (k + 1) % order.length, left--) out[order[k].i] += 1;
  return out;
}

/**
 * Sets one weight (in bps) and moves the others so the total stays exactly 10000: they absorb the difference in
 * proportion to their current weights (equally when they are all zero). Used by the weight sliders.
 */
export function setWeightKeepingTotal(weightsBps: number[], index: number, valueBps: number): number[] {
  if (weightsBps.length <= 1) return weightsBps.length === 1 ? [10_000] : [];
  const v = Math.max(0, Math.min(10_000, Math.round(valueBps)));
  const others = weightsBps.map((w, i) => (i === index ? null : Math.max(0, w)));
  const spread = apportion(others.filter((w): w is number => w !== null), 10_000 - v);
  let k = 0;
  return weightsBps.map((_, i) => (i === index ? v : spread[k++]));
}

/** Scales weights back to exactly 10000 in proportion (after an asset is removed). */
export function normalizeToTotal(weightsBps: number[]): number[] {
  return apportion(weightsBps.map((w) => Math.max(0, w)), 10_000);
}
