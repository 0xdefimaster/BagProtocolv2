// Exact decimal arithmetic for accounting amounts: decimal strings scaled to
// 18 fractional digits as bigint. No floats anywhere in the books.

export const DEC_SCALE = 18;
const ONE = BigInt(10) ** BigInt(DEC_SCALE);

/** "12.5" → 12.5e18 (bigint). Accepts an optional leading minus; more than 18 fractional digits are truncated toward zero. */
export function parseDec(value: string): bigint {
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!m) throw new Error(`Not a decimal string: ${value}`);
  const [, neg, whole, frac = ''] = m;
  const v = BigInt(whole) * ONE + BigInt((frac + '0'.repeat(DEC_SCALE)).slice(0, DEC_SCALE));
  return neg ? -v : v;
}

/** 12.5e18 → "12.5" (trailing zeros trimmed). */
export function formatDec(v: bigint): string {
  const neg = v < BigInt(0);
  const a = neg ? -v : v;
  const whole = a / ONE;
  const frac = (a % ONE).toString().padStart(DEC_SCALE, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

/** A raw integer token amount with `decimals` → its decimal string ("1500000", 6 → "1.5"). */
export function rawToDecimalString(raw: bigint | string, decimals: number): string {
  const r = typeof raw === 'string' ? BigInt(raw) : raw;
  const scaled = decimals <= DEC_SCALE ? r * BigInt(10) ** BigInt(DEC_SCALE - decimals) : r / BigInt(10) ** BigInt(decimals - DEC_SCALE);
  return formatDec(scaled);
}

/** `v * num / den`, truncated toward zero. */
export function mulDiv(v: bigint, num: bigint, den: bigint): bigint {
  if (den === BigInt(0)) throw new Error('division by zero');
  return (v * num) / den;
}

/**
 * Splits a non-negative decimal `total` across `weights` proportionally, exactly: every part is floored at 18
 * places and the last part with a positive weight takes the remainder, so the parts always sum to `total`.
 * All-zero weights split equally.
 */
export function splitDecimal(total: string, weights: bigint[]): string[] {
  if (weights.length === 0) return [];
  const t = parseDec(total);
  if (t < BigInt(0)) throw new Error('splitDecimal: negative total');
  const w = weights.some((x) => x > BigInt(0)) ? weights.map((x) => (x > BigInt(0) ? x : BigInt(0))) : weights.map(() => BigInt(1));
  const sum = w.reduce((a, b) => a + b, BigInt(0));
  const parts = w.map((x) => (t * x) / sum);
  let last = -1;
  w.forEach((x, i) => {
    if (x > BigInt(0)) last = i;
  });
  parts[last] += t - parts.reduce((a, b) => a + b, BigInt(0));
  return parts.map(formatDec);
}

/** Same as splitDecimal for raw integer amounts. */
export function splitRaw(total: bigint, weights: bigint[]): bigint[] {
  if (weights.length === 0) return [];
  const w = weights.some((x) => x > BigInt(0)) ? weights.map((x) => (x > BigInt(0) ? x : BigInt(0))) : weights.map(() => BigInt(1));
  const sum = w.reduce((a, b) => a + b, BigInt(0));
  const parts = w.map((x) => (total * x) / sum);
  let last = -1;
  w.forEach((x, i) => {
    if (x > BigInt(0)) last = i;
  });
  parts[last] += total - parts.reduce((a, b) => a + b, BigInt(0));
  return parts;
}
