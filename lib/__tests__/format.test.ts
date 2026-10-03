import { describe, expect, it } from 'vitest';
import { formatDecimalString, formatDecimalStringUsd, formatRawAmount, formatRawAmountUsd } from '../format';

describe('formatDecimalString', () => {
  it('truncates (never rounds) the fraction to maxFractionDigits, trimming trailing zeros by default', () => {
    expect(formatDecimalString('10.000000000000000000')).toBe('10');
    expect(formatDecimalString('9.99999')).toBe('9.9999'); // truncated at 4, not rounded to 10
    expect(formatDecimalString('1234567.891', { maxFractionDigits: 2 })).toBe('1,234,567.89');
  });

  it('adds thousands separators to the integer part', () => {
    expect(formatDecimalString('1000000')).toBe('1,000,000');
  });

  it('preserves a negative sign', () => {
    expect(formatDecimalString('-42.5')).toBe('-42.5');
  });

  it('pads the fraction when padFraction is set, for a fixed-width currency-style display', () => {
    expect(formatDecimalString('10', { maxFractionDigits: 2, padFraction: true })).toBe('10.00');
  });

  it('handles a value with no fractional part at all', () => {
    expect(formatDecimalString('42')).toBe('42');
  });
});

describe('formatDecimalStringUsd', () => {
  it('formats as $-prefixed, 2 decimals, padded, truncated not rounded', () => {
    expect(formatDecimalStringUsd('10')).toBe('$10.00');
    expect(formatDecimalStringUsd('9.999')).toBe('$9.99'); // truncated, not rounded to $10.00
    expect(formatDecimalStringUsd('1234.5')).toBe('$1,234.50');
  });
});

describe('formatRawAmount', () => {
  it('applies decimals via exact bigint division, then formats like formatDecimalString', () => {
    expect(formatRawAmount('100000000', 6)).toBe('100'); // 100 USDC @ 6 decimals
    expect(formatRawAmount((BigInt(25) * BigInt(10) ** BigInt(18)).toString(), 18)).toBe('25');
  });

  it('never loses precision for a very large raw amount (would silently break under Number(...) division)', () => {
    // 123456789012345678901234.5 shares at 18 decimals — far beyond Number's
    // safe integer range; a Number(...)-based formatter would corrupt this.
    const raw = '123456789012345678901234500000000000000000';
    expect(formatRawAmount(raw, 18, { maxFractionDigits: 6 })).toBe('123,456,789,012,345,678,901,234.5');
  });

  it('truncates a fractional raw amount rather than rounding', () => {
    // 1 raw unit at 18 decimals, displayed with only 4 fraction digits, truncates to 0 (not rounds up).
    expect(formatRawAmount('1', 18, { maxFractionDigits: 4 })).toBe('0');
  });

  it('handles zero', () => {
    expect(formatRawAmount('0', 18)).toBe('0');
  });
});

describe('formatRawAmountUsd', () => {
  it('formats a raw amount as $-prefixed currency', () => {
    expect(formatRawAmountUsd('40000000', 6)).toBe('$40.00'); // 40 USDC @ 6 decimals
  });
});
