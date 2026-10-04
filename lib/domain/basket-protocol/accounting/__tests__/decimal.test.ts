import { describe, expect, it } from 'vitest';
import { formatDec, parseDec, rawToDecimalString, splitDecimal, splitRaw } from '../decimal';

describe('decimal', () => {
  it('parses and formats exactly, signs included', () => {
    for (const v of ['0', '1', '12.5', '-3.25', '0.000000000000000001', '123456789.123456789123456789']) {
      const expected = v === '123456789.123456789123456789' ? '123456789.123456789123456789' : v;
      expect(formatDec(parseDec(v))).toBe(expected);
    }
    expect(formatDec(parseDec('1.1234567890123456789999'))).toBe('1.123456789012345678'); // truncated at 18
    expect(() => parseDec('1e5')).toThrow();
  });
  it('raw token amounts to decimal strings', () => {
    expect(rawToDecimalString('1500000', 6)).toBe('1.5');
    expect(rawToDecimalString(BigInt('1000000000000000000'), 18)).toBe('1');
    expect(rawToDecimalString('1', 24)).toBe('0');
  });
  it('splits proportionally; parts always sum to the total; zero weights get nothing', () => {
    expect(splitDecimal('10', [BigInt(1), BigInt(1), BigInt(1)])).toEqual(['3.333333333333333333', '3.333333333333333333', '3.333333333333333334']);
    expect(splitDecimal('10', [BigInt(3), BigInt(0), BigInt(1)])).toEqual(['7.5', '0', '2.5']);
    expect(splitDecimal('5', [BigInt(0), BigInt(0)])).toEqual(['2.5', '2.5']);
    expect(splitRaw(BigInt(10), [BigInt(1), BigInt(2)])).toEqual([BigInt(3), BigInt(7)]);
    const parts = splitDecimal('13.37', [BigInt(7), BigInt(11), BigInt(13)]);
    expect(parts.reduce((a, p) => a + parseDec(p), BigInt(0))).toBe(parseDec('13.37'));
  });

  it('property: for many random totals and weights, parts are never negative and always sum exactly to the total', () => {
    let seed = 42;
    const rnd = (max: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % max;
    };
    for (let i = 0; i < 500; i++) {
      const weights = Array.from({ length: 1 + rnd(8) }, () => BigInt(rnd(5) === 0 ? 0 : rnd(10_000_000)));
      const totalRaw = BigInt(rnd(1_000_000_000)) * BigInt(1 + rnd(1000));
      const raw = splitRaw(totalRaw, weights);
      expect(raw.reduce((a, b) => a + b, BigInt(0))).toBe(totalRaw);
      expect(raw.every((x) => x >= BigInt(0))).toBe(true);
      const total = `${rnd(100000)}.${String(rnd(1_000_000)).padStart(6, '0')}`;
      const dec = splitDecimal(total, weights);
      expect(dec.reduce((a, p) => a + parseDec(p), BigInt(0))).toBe(parseDec(total));
      expect(dec.every((p) => !p.startsWith('-'))).toBe(true);
    }
  });
});
