import { describe, it, expect } from 'vitest';
import {
  quoteDecimalToRewardTokenRaw,
  rewardTokenRawToQuoteDecimal,
  ROBINHOOD_CHAIN_ID,
  ROBINHOOD_REWARD_TOKEN,
} from '../robinhood-chain';

describe('robinhood-chain config', () => {
  it('pins the verified chain id and reward token', () => {
    expect(ROBINHOOD_CHAIN_ID).toBe(4663);
    expect(ROBINHOOD_REWARD_TOKEN.symbol).toBe('USDG');
    expect(ROBINHOOD_REWARD_TOKEN.decimals).toBe(6);
  });

  it('converts a whole-dollar quote amount to raw USDG units', () => {
    expect(quoteDecimalToRewardTokenRaw('100')).toBe(BigInt(100_000_000));
  });

  it('converts a fractional quote amount to raw USDG units', () => {
    expect(quoteDecimalToRewardTokenRaw('17.13')).toBe(BigInt(17_130_000));
  });

  it('floors (never rounds up) precision beyond 6 decimals', () => {
    // 0.1234567 -> should floor to 0.123456, NOT round to 0.123457.
    expect(quoteDecimalToRewardTokenRaw('0.1234567')).toBe(BigInt(123_456));
  });

  it('handles negative amounts (e.g. a correction) with floor-toward-zero semantics', () => {
    expect(quoteDecimalToRewardTokenRaw('-5.5')).toBe(-BigInt(5_500_000));
  });

  it('rejects non-numeric input rather than silently coercing it', () => {
    expect(() => quoteDecimalToRewardTokenRaw('not-a-number')).toThrow();
    expect(() => quoteDecimalToRewardTokenRaw('12.34.56')).toThrow();
  });

  it('round-trips a raw amount back to a trimmed decimal string for display', () => {
    expect(rewardTokenRawToQuoteDecimal(BigInt(17_130_000))).toBe('17.13');
    expect(rewardTokenRawToQuoteDecimal(BigInt(100_000_000))).toBe('100');
    expect(rewardTokenRawToQuoteDecimal(BigInt(123_456))).toBe('0.123456');
  });
});
