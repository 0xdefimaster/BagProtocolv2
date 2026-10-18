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
