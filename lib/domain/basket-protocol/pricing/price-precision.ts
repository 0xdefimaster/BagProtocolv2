// -----------------------------------------------------------------------------
// Deterministic decimal handling for `AssetPrice.price` (types/basket-protocol.ts).
// Two derived representations exist, deliberately kept separate (spec
// section 7 — "Display price ≠ Protocol price"):
//
//   PROTOCOL price — a scaled `bigint` (`toProtocolPrice()`). This is the
//   only form that should ever feed arithmetic like NAV math (Phase 6). No
//   JS `number` is involved at any step, so no float drift, no matter how
//   many assets/positions get summed.
//
//   DISPLAY price — a rounded decimal string (`toDisplayPrice()`), for
//   showing in UI only. Never fed back into arithmetic.
//
// `AssetPrice.price` itself is a plain, un-scaled decimal string (e.g.
// "43250.12345678") — these two functions are the only sanctioned way to
// turn it into something calculable or something shown. Both work purely
// on the string's digits (no `Number()`/`parseFloat()` anywhere in this
// file), so precision is never bounded by IEEE-754.
// -----------------------------------------------------------------------------

const DECIMAL_STRING_RE = /^-?\d+(\.\d+)?$/;

export function isValidDecimalString(value: string): boolean {
  return DECIMAL_STRING_RE.test(value.trim());
}

function splitDecimal(value: string): { negative: boolean; whole: string; fraction: string } {
  const trimmed = value.trim();
  const negative = trimmed.startsWith('-');
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [whole, fraction = ''] = unsigned.split('.');
  return { negative, whole, fraction };
}

/**
 * Scales a decimal price string to an integer `bigint` at `scaleDecimals`
 * precision — e.g. `toProtocolPrice("43250.125", 6) === 43250125000n`.
 * Truncates (never rounds) any precision beyond `scaleDecimals`, matching
 * how Solidity fixed-point math truncates — rounding here would silently
 * manufacture value that wasn't in the source string.
 */
export function toProtocolPrice(price: string, scaleDecimals: number): bigint {
  if (!isValidDecimalString(price)) {
    throw new Error(`toProtocolPrice: "${price}" is not a valid decimal string.`);
  }
  if (!Number.isInteger(scaleDecimals) || scaleDecimals < 0) {
    throw new Error(`toProtocolPrice: scaleDecimals must be a non-negative integer, got ${scaleDecimals}.`);
  }

  const { negative, whole, fraction } = splitDecimal(price);
  const truncatedFraction = fraction.slice(0, scaleDecimals).padEnd(scaleDecimals, '0');
  const scaled = BigInt(whole + truncatedFraction);
  return negative ? -scaled : scaled;
}

/**
 * Rounds a decimal price string to `displayDecimals` places for UI display
 * only — the result must never be parsed back into protocol math. Uses
 * plain half-up rounding on the decimal string's digits, not float math,
 * so it stays exact for arbitrarily long/precise inputs.
 */
export function toDisplayPrice(price: string, displayDecimals = 2): string {
  if (!isValidDecimalString(price)) {
    throw new Error(`toDisplayPrice: "${price}" is not a valid decimal string.`);
  }
  if (!Number.isInteger(displayDecimals) || displayDecimals < 0) {
    throw new Error(`toDisplayPrice: displayDecimals must be a non-negative integer, got ${displayDecimals}.`);
  }

  const { negative, whole, fraction } = splitDecimal(price);

  if (fraction.length <= displayDecimals) {
    const padded = fraction.padEnd(displayDecimals, '0');
    const result = displayDecimals > 0 ? `${whole}.${padded}` : whole;
    return negative ? `-${result}` : result;
  }

  const keep = fraction.slice(0, displayDecimals);
  const roundDigit = fraction.charCodeAt(displayDecimals) - 48; // '0' === 48
  let scaled = BigInt(whole + keep);
  if (roundDigit >= 5) scaled += BigInt(1);

  const scaledStr = scaled.toString().padStart(displayDecimals + 1, '0');
  const wholePart = scaledStr.slice(0, scaledStr.length - displayDecimals) || '0';
  const fracPart = scaledStr.slice(scaledStr.length - displayDecimals);
  const result = displayDecimals > 0 ? `${wholePart}.${fracPart}` : wholePart;
  return negative ? `-${result}` : result;
}
