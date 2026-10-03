import { isValidDecimalString, toProtocolPrice } from './price-precision';
import { formatNavValue } from '../nav/nav';

// Exact decimal-string arithmetic for the price layer (no JS `number`
// anywhere). All operands are scaled to `SCALE` decimals as bigints.

export const SCALE = 18;
const ONE = BigInt(10) ** BigInt(SCALE);

/** Parses an unsigned decimal string (or a finite non-negative JSON number) to a SCALE-decimal bigint; null when it is not one. */
export function parseUnsignedDecimal(value: unknown): bigint | null {
  let s: string;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) return null;
    // JSON numbers from an API: use the shortest round-trip form, never exponent notation.
    s = value.toString();
    if (/e/i.test(s)) return null;
  } else if (typeof value === 'string') {
    s = value.trim();
  } else {
    return null;
  }
  if (!isValidDecimalString(s) || s.startsWith('-')) return null;
  return toProtocolPrice(s, SCALE);
}

export const mulScaled = (a: bigint, b: bigint) => (a * b) / ONE;
export const midScaled = (a: bigint, b: bigint) => (a + b) / BigInt(2);
export const toDecimalString = (scaled: bigint) => formatNavValue(scaled, SCALE);

/** |a - b| / min(a, b) in basis points (rounded down). Both must be > 0. */
export function deviationBps(a: bigint, b: bigint): bigint {
  const lo = a < b ? a : b;
  const diff = a > b ? a - b : b - a;
  return (diff * BigInt(10_000)) / lo;
}
