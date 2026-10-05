import { describe, expect, it } from 'vitest';
import { FEE_REDEEM_MAX_PRICE_DEVIATION_BPS, referenceValueRaw, selectRedeemLegQuote, tokenAmountForValue } from '../redeem-quote-quality';

const E18 = BigInt(10) ** BigInt(18);

describe('referenceValueRaw / tokenAmountForValue', () => {
  it('values a token amount at the verified price in USDG raw units (6 decimals), rounding down', () => {
    expect(referenceValueRaw(BigInt(2) * E18, 18, '12.5', 6)).toBe(BigInt(25_000_000));
    expect(referenceValueRaw(BigInt(1), 18, '1', 6)).toBe(BigInt(0));
    expect(() => referenceValueRaw(E18, 18, '0', 6)).toThrow();
  });
  it('sizes a representative sale from the price', () => {
    expect(tokenAmountForValue(25, 18, '12.5')).toBe(BigInt(2) * E18);
    expect(referenceValueRaw(tokenAmountForValue(100, 18, '201.37'), 18, '201.37', 6)).toBeLessThanOrEqual(BigInt(100_000_000));
  });
});

describe('selectRedeemLegQuote — best tier, then the reference check', () => {
  const ref = BigInt(25_000_000); // $25 of stock at the verified price

  it('takes the BEST tier, not the first that answers', () => {
    const r = selectRedeemLegQuote(
      [
        { feeTier: 3000, amountOut: BigInt(24_000_000) },
        { feeTier: 500, amountOut: BigInt(24_850_000) },
        { feeTier: 10000, amountOut: BigInt(23_000_000) },
      ],
      ref,
      FEE_REDEEM_MAX_PRICE_DEVIATION_BPS
    );
    expect(r).toEqual({ ok: true, feeTier: 500, quoteRaw: BigInt(24_850_000), referenceRaw: ref, deviationBps: 60 });
  });

  it('the live AAOI case: the only quote is a near-empty pool ($25 → $0.18) — refused', () => {
    const r = selectRedeemLegQuote([{ feeTier: 10000, amountOut: BigInt(180_000) }], ref, FEE_REDEEM_MAX_PRICE_DEVIATION_BPS);
    expect(r).toMatchObject({ ok: false, reason: 'PRICE_DEVIATION', feeTier: 10000, deviationBps: 9928 });
  });

  it('the best quote can still be bad: every tier at half the fair value — refused', () => {
    const r = selectRedeemLegQuote(
      [
        { feeTier: 500, amountOut: BigInt(12_000_000) },
        { feeTier: 3000, amountOut: BigInt(12_100_000) },
        { feeTier: 10000, amountOut: BigInt(12_200_000) },
      ],
      ref,
      FEE_REDEEM_MAX_PRICE_DEVIATION_BPS
    );
    expect(r).toMatchObject({ ok: false, reason: 'PRICE_DEVIATION', feeTier: 10000, deviationBps: 5120 });
  });

  it('boundary: exactly at the allowed deviation passes, one bp beyond is refused; above the reference is deviation 0', () => {
    expect(selectRedeemLegQuote([{ feeTier: 3000, amountOut: BigInt(23_750_000) }], ref, 500)).toMatchObject({ ok: true, deviationBps: 500 });
    expect(selectRedeemLegQuote([{ feeTier: 3000, amountOut: BigInt(23_747_500) }], ref, 500)).toMatchObject({ ok: false, deviationBps: 501 });
    expect(selectRedeemLegQuote([{ feeTier: 3000, amountOut: BigInt(25_100_000) }], ref, 500)).toMatchObject({ ok: true, deviationBps: 0 });
  });

  it('no quote at all, or only zero outputs → NO_QUOTE', () => {
    expect(selectRedeemLegQuote([], ref, 500)).toEqual({ ok: false, reason: 'NO_QUOTE' });
    expect(selectRedeemLegQuote([{ feeTier: 3000, amountOut: BigInt(0) }], ref, 500)).toEqual({ ok: false, reason: 'NO_QUOTE' });
  });
});
