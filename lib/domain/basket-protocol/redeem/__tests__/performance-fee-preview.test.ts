import { describe, it, expect } from 'vitest';
import { previewPerformanceFee } from '../performance-fee-preview';

// -----------------------------------------------------------------------------
// Every case here has a hand-computed expected value — not just "does it
// run" — since this function's entire reason to exist is matching
// apply_redeem_execution()'s SQL arithmetic bit-for-bit (see that
// function's `round(v_profit * bps / 10000.0, 2)` in supabase/migrations/
// 0013_add_creator_rewards.sql).
// -----------------------------------------------------------------------------

describe('previewPerformanceFee', () => {
  it('profit case: straightforward 10% fee on a clean profit', () => {
    // position: cost basis $1000 for 100 shares. Redeeming all 100 shares
    // for $1200 -> consumed cost basis = $1000, profit = $200, fee@10% = $20.
    const result = previewPerformanceFee({
      positionCostBasisQuote: '1000.00',
      positionSharesRaw: '100',
      sharesBurnRaw: '100',
      redeemValueQuote: '1200.00',
      performanceFeeBps: 1000,
      creatorIsRedeemer: false,
    });
    expect(result.profitQuote).toBe('200.00');
    expect(result.feeAmountQuote).toBe('20.00');
  });

  it('loss case: never a negative or nonzero fee', () => {
    const result = previewPerformanceFee({
      positionCostBasisQuote: '1000.00',
      positionSharesRaw: '100',
      sharesBurnRaw: '100',
      redeemValueQuote: '800.00',
      performanceFeeBps: 1000,
      creatorIsRedeemer: false,
    });
    expect(result.profitQuote).toBe('-200.00');
    expect(result.feeAmountQuote).toBe('0.00');
  });

  it('zero profit: exactly break-even charges nothing', () => {
    const result = previewPerformanceFee({
      positionCostBasisQuote: '500.00',
      positionSharesRaw: '50',
      sharesBurnRaw: '50',
      redeemValueQuote: '500.00',
      performanceFeeBps: 2000,
      creatorIsRedeemer: false,
    });
    expect(result.profitQuote).toBe('0.00');
    expect(result.feeAmountQuote).toBe('0.00');
  });

  it('creator redeeming their own bag: never charged, even with real profit', () => {
    const result = previewPerformanceFee({
      positionCostBasisQuote: '100.00',
      positionSharesRaw: '10',
      sharesBurnRaw: '10',
      redeemValueQuote: '500.00',
      performanceFeeBps: 1000,
      creatorIsRedeemer: true,
    });
    expect(result.feeAmountQuote).toBe('0.00');
  });

  it('zero bps configured on the bag: never charged regardless of profit', () => {
    const result = previewPerformanceFee({
      positionCostBasisQuote: '100.00',
      positionSharesRaw: '10',
      sharesBurnRaw: '10',
      redeemValueQuote: '500.00',
      performanceFeeBps: 0,
      creatorIsRedeemer: false,
    });
    expect(result.feeAmountQuote).toBe('0.00');
  });

  it('partial redemption: proportionally consumes only part of the cost basis', () => {
    // position: cost basis $1000 for 100 shares ($10/share cost). Redeem
    // 40 of 100 shares for $600 quoted value.
    // consumedCostBasis = 1000 * 40/100 = 400. profit = 600 - 400 = 200.
    const result = previewPerformanceFee({
      positionCostBasisQuote: '1000.00',
      positionSharesRaw: '100',
      sharesBurnRaw: '40',
      redeemValueQuote: '600.00',
      performanceFeeBps: 1000,
      creatorIsRedeemer: false,
    });
    expect(result.profitQuote).toBe('200.00');
    expect(result.feeAmountQuote).toBe('20.00');
  });

  it('exact rounding boundary: half-away-from-zero, matching Postgres numeric round()', () => {
    // profit = 100.01 (odd cent), fee bps = 12.5% -> 100.01 * 0.125 = 12.50125 -> rounds to 12.50
    const a = previewPerformanceFee({
      positionCostBasisQuote: '0.00',
      positionSharesRaw: '1',
      sharesBurnRaw: '1',
      redeemValueQuote: '100.01',
      performanceFeeBps: 1250,
      creatorIsRedeemer: false,
    });
    expect(a.feeAmountQuote).toBe('12.50');

    // A case that lands exactly on .5 of a cent: profit = 1.00, bps = 2505
    // -> 1.00 * 0.2505 = 0.2505 -> rounds to 0.25 (down, since .05 of a
    // cent rounds the THIRD digit, not a genuine .5-cent tie — included to
    // document the boundary, not because it's a tie itself).
    const b = previewPerformanceFee({
      positionCostBasisQuote: '0.00',
      positionSharesRaw: '1',
      sharesBurnRaw: '1',
      redeemValueQuote: '1.00',
      performanceFeeBps: 2505,
      creatorIsRedeemer: false,
    });
    expect(b.feeAmountQuote).toBe('0.25');

    // A genuine half-cent tie: profit = 4.00, bps = 1250 (12.5%) exactly
    // -> 4.00 * 0.125 = 0.50 exactly -> no rounding ambiguity, sanity check.
    const c = previewPerformanceFee({
      positionCostBasisQuote: '0.00',
      positionSharesRaw: '1',
      sharesBurnRaw: '1',
      redeemValueQuote: '4.00',
      performanceFeeBps: 1250,
      creatorIsRedeemer: false,
    });
    expect(c.feeAmountQuote).toBe('0.50');
  });

  it('very large values: no precision loss at scale (bigint throughout, never Number())', () => {
    const result = previewPerformanceFee({
      positionCostBasisQuote: '1000000000.00', // $1B cost basis
      positionSharesRaw: '1000000000000000000', // 1e18 raw shares
      sharesBurnRaw: '1000000000000000000', // redeem all of it
      redeemValueQuote: '1500000000.00', // $1.5B redemption value
      performanceFeeBps: 2000, // 20%
      creatorIsRedeemer: false,
    });
    // profit = 1.5B - 1B = 500M; fee@20% = 100M
    expect(result.profitQuote).toBe('500000000.00');
    expect(result.feeAmountQuote).toBe('100000000.00');
  });

  it('fractional (sub-cent-precision input) amounts round consistently, never truncate silently', () => {
    const result = previewPerformanceFee({
      positionCostBasisQuote: '100.005', // upstream float noise beyond 2dp
      positionSharesRaw: '1',
      sharesBurnRaw: '1',
      redeemValueQuote: '200.007',
      performanceFeeBps: 1000,
      creatorIsRedeemer: false,
    });
    // 100.005 -> rounds to 100.01 (5 rounds up); 200.007 -> rounds to
    // 200.01 (7 rounds up at the 3rd digit boundary already captured by
    // decimalToCents's own rounding). profit = 200.01 - 100.01 = 100.00;
    // fee@10% = 10.00.
    expect(result.profitQuote).toBe('100.00');
    expect(result.feeAmountQuote).toBe('10.00');
  });

  it('throws (never silently substitutes 0) if sharesBurnRaw exceeds the position', () => {
    expect(() =>
      previewPerformanceFee({
        positionCostBasisQuote: '100.00',
        positionSharesRaw: '10',
        sharesBurnRaw: '11',
        redeemValueQuote: '50.00',
        performanceFeeBps: 1000,
        creatorIsRedeemer: false,
      })
    ).toThrow(/exceeds positionSharesRaw/);
  });

  it('throws on a zero-share position rather than dividing by zero', () => {
    expect(() =>
      previewPerformanceFee({
        positionCostBasisQuote: '0.00',
        positionSharesRaw: '0',
        sharesBurnRaw: '0',
        redeemValueQuote: '0.00',
        performanceFeeBps: 1000,
        creatorIsRedeemer: false,
      })
    ).toThrow(/no position to redeem from/);
  });
});
