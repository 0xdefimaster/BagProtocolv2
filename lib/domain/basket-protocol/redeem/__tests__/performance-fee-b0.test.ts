import { describe, expect, it } from 'vitest';
import { computeB0Fee, decimalToRawCeil, feeBasisFromPositionPnl } from '../performance-fee-b0';
import { computePositionPnl, type PnlEvent } from '../../accounting/position-pnl';
import { parseDec } from '../../accounting/decimal';

// USDG has 6 decimals: $1 = 1_000_000 raw.
const usd = (v: string) => decimalToRawCeil(parseDec(v), 6);
const fee = (grossMin: string, basis: string, carry = '0', rateBps = 1000, creatorIsRedeemer = false) =>
  computeB0Fee({ grossMinimumProceedsRaw: usd(grossMin), consumedBasisRaw: usd(basis), lossCarryRaw: usd(carry), rateBps, creatorIsRedeemer });

describe('computeB0Fee — the worked cases of docs/FEE_ECONOMICS_DESIGN.md §4 (10%, basis $100)', () => {
  it('case 1 and 2 (grossMinimumProceeds 118.80): fee 1.88, minUserProceeds 116.92', () => {
    expect(fee('118.80', '100')).toEqual({ feeBaseRaw: usd('18.80'), feeRaw: usd('1.88'), minUserProceedsRaw: usd('116.92') });
  });

  it('case 2b (floor 99.495 < basis): no fee, the user floor is the whole minimum', () => {
    expect(fee('99.495', '100')).toEqual({ feeBaseRaw: BigInt(0), feeRaw: BigInt(0), minUserProceedsRaw: usd('99.495') });
  });

  it('loss carry-forward: sale gain 10 after an earlier realized loss of 10 → no fee; +5 above the mark → 0.50', () => {
    expect(fee('110', '100', '10').feeRaw).toBe(BigInt(0));
    expect(fee('105', '100', '0').feeRaw).toBe(usd('0.5'));
  });

  it('creator selling their own Bag and a 0% rate pay nothing', () => {
    expect(fee('118.80', '100', '0', 1000, true).feeRaw).toBe(BigInt(0));
    expect(fee('118.80', '100', '0', 0).feeRaw).toBe(BigInt(0));
  });

  it('rounding is one integer rule in raw units, always down (never half-up to the cent)', () => {
    // fee base 0.000015 USDG × 10% = 0.0000015 → floor → 1 raw unit (0.000001), never 2.
    expect(computeB0Fee({ grossMinimumProceedsRaw: BigInt(15), consumedBasisRaw: BigInt(0), lossCarryRaw: BigInt(0), rateBps: 1000, creatorIsRedeemer: false }).feeRaw).toBe(BigInt(1));
    // A fee of 0.005 USDG stays 0.005 (half a cent is not rounded up to 0.01 as the legacy cent rule did).
    expect(fee('100.05', '100').feeRaw).toBe(usd('0.005'));
  });

  it('property: for every actual ≥ floor, charged fee ≤ rate × max(0, actual − basis − carry) (never charged on unrealized gain)', () => {
    let seed = 7;
    const rnd = (n: number) => ((seed = (seed * 48271) % 2147483647) % n);
    for (let i = 0; i < 2000; i++) {
      const grossMin = BigInt(rnd(300_000_000));
      const basis = BigInt(rnd(200_000_000));
      const carry = BigInt(rnd(20_000_000));
      const rate = rnd(3001);
      const actual = grossMin + BigInt(rnd(5_000_000));
      const { feeRaw, minUserProceedsRaw } = computeB0Fee({ grossMinimumProceedsRaw: grossMin, consumedBasisRaw: basis, lossCarryRaw: carry, rateBps: rate, creatorIsRedeemer: false });
      const realizable = actual - basis - carry > BigInt(0) ? actual - basis - carry : BigInt(0);
      expect(feeRaw * BigInt(10000) <= realizable * BigInt(rate)).toBe(true);
      // The router invariant: swapOutput ≥ minUserProceeds + fee  ⇔  swapOutput ≥ grossMinimumProceeds.
      expect(minUserProceedsRaw + feeRaw).toBe(grossMin);
      expect(feeRaw <= grossMin).toBe(true);
    }
  });

  it('rejects inputs it cannot honour', () => {
    expect(() => computeB0Fee({ grossMinimumProceedsRaw: BigInt(1), consumedBasisRaw: BigInt(-1), lossCarryRaw: BigInt(0), rateBps: 1, creatorIsRedeemer: false })).toThrow();
    expect(() => computeB0Fee({ grossMinimumProceedsRaw: BigInt(1), consumedBasisRaw: BigInt(0), lossCarryRaw: BigInt(0), rateBps: 10001, creatorIsRedeemer: false })).toThrow();
  });
});

describe('decimalToRawCeil', () => {
  it('rounds up into raw units and never goes negative', () => {
    expect(decimalToRawCeil(parseDec('1.5'), 6)).toBe(BigInt(1_500_000));
    expect(decimalToRawCeil(parseDec('0.0000001'), 6)).toBe(BigInt(1));
    expect(decimalToRawCeil(parseDec('-3'), 6)).toBe(BigInt(0));
  });
});

describe('feeBasisFromPositionPnl — basis from the A3 ledger (F2), loss carry from the realized high-water mark (F4)', () => {
  const A = { chain: 'robinhood', address: '0x00000000000000000000000000000000000000a1' };
  const B = { chain: 'robinhood', address: '0x00000000000000000000000000000000000000b2' };
  const buy = (seq: number, legs: { a: typeof A; qty: string; cost: string }[]): PnlEvent => ({
    seq: String(seq), kind: 'PURCHASE_FILL', quote: {}, legs: legs.map((l) => ({ ...l.a, deltaRaw: l.qty, costQuote: l.cost })),
  });
  const sell = (seq: number, legs: { a: typeof A; qty: string; proceeds: string }[]): PnlEvent => ({
    seq: String(seq), kind: 'REDEEM_FILL', quote: {}, legs: legs.map((l) => ({ ...l.a, deltaRaw: `-${l.qty}`, proceedsQuote: l.proceeds })),
  });

  it('sells half of two assets bought at different costs: basis = Σ average cost × quantity sold (not shares)', () => {
    const pnl = computePositionPnl([buy(1, [{ a: A, qty: '1000', cost: '60' }, { a: B, qty: '400', cost: '40' }])]);
    const r = feeBasisFromPositionPnl(pnl, [{ ...A, quantityRaw: '500' }, { ...B, quantityRaw: '200' }]);
    expect(r).toEqual({ ok: true, consumedBasisQuote: parseDec('50'), lossCarryQuote: BigInt(0) });
  });

  it('after a realized loss, the carry is the high-water mark minus cumulative realized', () => {
    const pnl = computePositionPnl([
      buy(1, [{ a: A, qty: '1000', cost: '100' }]),
      sell(2, [{ a: A, qty: '1000', proceeds: '90' }]), // −10
      buy(3, [{ a: A, qty: '1000', cost: '100' }]),
    ]);
    const r = feeBasisFromPositionPnl(pnl, [{ ...A, quantityRaw: '1000' }]);
    expect(r).toEqual({ ok: true, consumedBasisQuote: parseDec('100'), lossCarryQuote: parseDec('10') });
  });

  it('never guesses: selling more than the books hold, unknown basis, unknown realized P&L', () => {
    const pnl = computePositionPnl([buy(1, [{ a: A, qty: '1000', cost: '100' }])]);
    expect(feeBasisFromPositionPnl(pnl, [{ ...A, quantityRaw: '1001' }])).toEqual({ ok: false, reason: 'SOLD_EXCEEDS_BOOKS' });
    expect(feeBasisFromPositionPnl(pnl, [{ ...B, quantityRaw: '1' }])).toEqual({ ok: false, reason: 'SOLD_EXCEEDS_BOOKS' });
    const unknownCost = computePositionPnl([{ seq: '1', kind: 'OPENING_BALANCE', quote: {}, legs: [{ ...A, deltaRaw: '1000', costQuote: null }] }]);
    expect(feeBasisFromPositionPnl(unknownCost, [{ ...A, quantityRaw: '10' }])).toEqual({ ok: false, reason: 'BASIS_UNKNOWN' });
    const unknownRealized = computePositionPnl([
      buy(1, [{ a: A, qty: '1000', cost: '100' }]),
      { seq: '2', kind: 'REDEEM_FILL', quote: {}, legs: [{ ...A, deltaRaw: '-10', proceedsQuote: null }] },
    ]);
    expect(feeBasisFromPositionPnl(unknownRealized, [{ ...A, quantityRaw: '10' }])).toEqual({ ok: false, reason: 'REALIZED_PNL_UNKNOWN' });
  });
});

describe('settlement floor: what a signed minUserProceeds admits on chain', () => {
  // RedeemSettlement charges computeFee(received) = computeB0Fee with gross = received and requires
  // received − fee ≥ minUserProceeds. The backend signs minUserProceeds = computeB0Fee(grossMinimum). The user's share
  // never decreases as received grows and drops by at least 1 every 2 raw units (rate ≤ 30%), so the floor admits
  // no settlement more than 1 raw unit below the gross minimum.
  const proceedsAt = (received: bigint, basis: bigint, carry: bigint, rateBps: number) =>
    received - computeB0Fee({ grossMinimumProceedsRaw: received, consumedBasisRaw: basis, lossCarryRaw: carry, rateBps, creatorIsRedeemer: false }).feeRaw;

  it('received below grossMinimum − 1 never reaches the floor (MAX_FEE_RATE_BPS = 3000)', () => {
    let seed = 7;
    const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
    for (let i = 0; i < 2000; i++) {
      const grossMinimum = BigInt(1 + rand(5_000_000_000));
      const basis = BigInt(rand(5_000_000_000));
      const carry = BigInt(rand(1_000_000_000));
      const rateBps = rand(3001);
      const floor = computeB0Fee({ grossMinimumProceedsRaw: grossMinimum, consumedBasisRaw: basis, lossCarryRaw: carry, rateBps, creatorIsRedeemer: false }).minUserProceedsRaw;
      expect(proceedsAt(grossMinimum, basis, carry, rateBps)).toBe(floor);
      for (const below of [BigInt(2), BigInt(3), BigInt(1000), grossMinimum / BigInt(10)]) {
        if (below >= BigInt(2) && grossMinimum > below) expect(proceedsAt(grossMinimum - below, basis, carry, rateBps) < floor).toBe(true);
      }
    }
  });
});
