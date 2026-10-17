import { describe, expect, it } from 'vitest';
import { computePositionPnl, PnlEvent } from '../position-pnl';

const A = { chain: 'robinhood', address: '0xaaa' };
const B = { chain: 'robinhood', address: '0xbbb' };
let seq = 0;
const ev = (kind: string, legs: PnlEvent['legs'], quote: Record<string, unknown> = {}): PnlEvent => ({ seq: String(++seq), kind, legs, quote });
const buy = (...legs: [typeof A, string, string?][]) => ev('PURCHASE_FILL', legs.map(([a, d, c]) => ({ ...a, deltaRaw: d, costQuote: c ?? null })));
const sell = (...legs: [typeof A, string, string?][]) => ev('REDEEM_FILL', legs.map(([a, d, p]) => ({ ...a, deltaRaw: `-${d}`, proceedsQuote: p ?? null })));

describe('computePositionPnl — average cost', () => {
  it('10 @ $100 + 10 @ $120 → average $110; selling 5 for $600 realizes $50', () => {
    const r = computePositionPnl([buy([A, '10', '1000']), buy([A, '10', '1200']), sell([A, '5', '600'])]);
    expect(r.exits[0]).toMatchObject({ proceedsQuote: '600', costOfSoldQuote: '550', realizedPnlQuote: '50', feeBaseQuote: '50' });
    expect(r.assets).toEqual([{ ...A, quantityRaw: '15', costBasisQuote: '1650', costBasisApproximate: false }]);
    expect(r.costBasisQuote).toBe('1650');
    expect(r.realizedPnlQuote).toBe('50');
  });

  it('a multi-asset exit sums its legs; selling everything leaves no basis behind', () => {
    const r = computePositionPnl([buy([A, '3', '30'], [B, '7', '70']), sell([A, '3', '25'], [B, '7', '90'])]);
    expect(r.exits[0]).toMatchObject({ proceedsQuote: '115', costOfSoldQuote: '100', realizedPnlQuote: '15' });
    expect(r.assets).toEqual([]);
    expect(r.costBasisQuote).toBe('0');
  });

  it('non-terminating averages stay exact enough that a full exit consumes all basis', () => {
    const r = computePositionPnl([buy([A, '3', '10']), sell([A, '1', '4']), sell([A, '2', '8'])]);
    expect(r.assets).toEqual([]);
    expect(r.realizedPnlQuote).toBe('2');
  });

  it('order is by seq, not array order', () => {
    const events = [buy([A, '10', '1000']), sell([A, '5', '600'])];
    expect(computePositionPnl([...events].reverse())).toEqual(computePositionPnl(events));
  });
});

describe('computePositionPnl — fees, high-water mark, loss carry-forward', () => {
  it('a gain after a realized loss is fee-free until the loss is recovered', () => {
    const r = computePositionPnl([
      buy([A, '30', '300']),
      sell([A, '10', '70']), // -30
      sell([A, '10', '120']), // +20 → cumulative -10: no fee base
      sell([A, '10', '150']), // +50 → cumulative +40: fee base 40 (above the 0 mark)
    ]);
    expect(r.exits.map((x) => [x.realizedPnlQuote, x.feeBaseQuote])).toEqual([
      ['-30', '0'],
      ['20', '0'],
      ['50', '40'],
    ]);
    expect(r.realizedHighWaterMarkQuote).toBe('40');
  });

  it('fees actually charged are reported next to the fee base, unchanged', () => {
    const r = computePositionPnl([buy([A, '10', '100']), sell([A, '10', '150']), ev('FEE_CHARGED', [], { amountQuote: '5' })]);
    expect(r.exits[0].feeBaseQuote).toBe('50');
    expect(r.feesChargedQuote).toBe('5');
  });

  it('locked semantics: realized P&L is gross proceeds − basis (before fees); net = realized − fees; the fee never lowers the high-water mark', () => {
    // Sale 1: 100 → 150 gross, fee 10 settled on-chain (user got 140). Sale 2 of a second lot: 100 → 100, no gain.
    const settledFee = ev('FEE_CHARGED', [], { amountQuote: '10', settledOnchain: true });
    const r = computePositionPnl([buy([A, '20', '200']), sell([A, '10', '150']), settledFee, sell([A, '10', '100'])]);
    expect(r.realizedPnlQuote).toBe('50');
    expect(r.feesChargedQuote).toBe('10');
    expect(r.netRealizedPnlQuote).toBe('40');
    // Had the ledger stored net proceeds (140), realized would be 40 and the mark 40: a later recovery of those 10
    // would be charged again. With gross proceeds the mark stays at 50 and the second sale's fee base is 0.
    expect(r.realizedHighWaterMarkQuote).toBe('50');
    expect(r.exits[1].feeBaseQuote).toBe('0');
  });

  it('net realized P&L is unknown when realized P&L is', () => {
    const r = computePositionPnl([buy([A, '10', '100']), sell([A, '10'])]);
    expect(r.realizedPnlQuote).toBeNull();
    expect(r.netRealizedPnlQuote).toBeNull();
  });
});

describe('computePositionPnl — external outflows and unknowns', () => {
  it('an external outflow removes quantity at average cost and realizes nothing', () => {
    const r = computePositionPnl([buy([A, '10', '100']), ev('EXTERNAL_OUTFLOW', [{ ...A, deltaRaw: '-4' }]), sell([A, '6', '90'])]);
    expect(r.basisExitedExternallyQuote).toBe('40');
    expect(r.exits).toHaveLength(1);
    expect(r.exits[0]).toMatchObject({ costOfSoldQuote: '60', realizedPnlQuote: '30' });
  });

  it('missing proceeds → realized unknown (null), never guessed; later exits stay unknown in the running total', () => {
    const r = computePositionPnl([buy([A, '10', '100']), sell([A, '5']), sell([A, '5', '80'])]);
    expect(r.exits[0]).toMatchObject({ proceedsQuote: null, realizedPnlQuote: null, feeBaseQuote: null });
    expect(r.exits[1]).toMatchObject({ realizedPnlQuote: '30', feeBaseQuote: null });
    expect(r.realizedPnlQuote).toBeNull();
  });

  it('an opening balance without per-asset cost makes that basis unknown until the asset is fully exited', () => {
    const r = computePositionPnl([
      ev('OPENING_BALANCE', [{ ...A, deltaRaw: '10' }], { costBasisDeltaQuote: '100' }),
      sell([A, '10', '120']),
      buy([A, '5', '50']),
    ]);
    expect(r.exits[0].costOfSoldQuote).toBeNull();
    expect(r.assets).toEqual([{ ...A, quantityRaw: '5', costBasisQuote: '50', costBasisApproximate: false }]);
  });

  it('selling more than the books hold yields unknown cost (the books were wrong, not the user)', () => {
    const r = computePositionPnl([buy([A, '5', '50']), sell([A, '6', '70'])]);
    expect(r.exits[0].costOfSoldQuote).toBeNull();
  });

  it('royalty and classification events do not touch the position', () => {
    const base = [buy([A, '10', '100'])];
    expect(computePositionPnl([...base, ev('ROYALTY_ACCRUED', [], { amountQuote: '1' }), ev('OUTFLOW_CLASSIFIED', [])]).assets).toEqual(computePositionPnl(base).assets);
  });
});

describe('computePositionPnl — rebalance (R3)', () => {
  const C = { chain: 'robinhood', address: '0xccc' };
  const rebalance = (sold: [typeof A, string][], bought: [typeof A, string, number][]) =>
    ev('REBALANCE_FILL', [
      ...sold.map(([a, d]) => ({ ...a, deltaRaw: `-${d}` })),
      ...bought.map(([a, d, w]) => ({ ...a, deltaRaw: d, weightBps: w })),
    ]);

  it('realizes nothing: the basis of what was sold moves to what was bought, by weight', () => {
    // 10 A for $1000; half of it rebalanced into B (60%) and C (40%).
    const r = computePositionPnl([buy([A, '10', '1000']), rebalance([[A, '5']], [[B, '30', 6000], [C, '8', 4000]])]);
    expect(r.exits).toEqual([]);
    expect(r.realizedPnlQuote).toBe('0');
    expect(r.assets).toEqual([
      { ...A, quantityRaw: '5', costBasisQuote: '500', costBasisApproximate: false },
      { ...B, quantityRaw: '30', costBasisQuote: '300', costBasisApproximate: false },
      { ...C, quantityRaw: '8', costBasisQuote: '200', costBasisApproximate: false },
    ]);
    expect(r.costBasisQuote).toBe('1000'); // conserved
  });

  it('a gain made before the rebalance is still charged at the exit (it does not escape the fee base)', () => {
    // Bought A for $100; A doubles; rebalanced fully into B; B sold for $200 → $100 realized at the exit.
    const r = computePositionPnl([buy([A, '1', '100']), rebalance([[A, '1']], [[B, '4', 10000]]), sell([B, '4', '200'])]);
    expect(r.exits[0]).toMatchObject({ proceedsQuote: '200', costOfSoldQuote: '100', realizedPnlQuote: '100', feeBaseQuote: '100' });
  });

  it('rounding: the last bought leg takes the remainder, so no basis is created or lost', () => {
    const r = computePositionPnl([buy([A, '3', '1']), rebalance([[A, '3']], [[B, '1', 3333], [C, '1', 6667]])]);
    expect(r.costBasisQuote).toBe('1');
  });

  it('selling something the books do not hold makes the bought basis unknown, never estimated', () => {
    const r = computePositionPnl([rebalance([[A, '1']], [[B, '1', 10000]])]);
    expect(r.assets).toEqual([{ ...B, quantityRaw: '1', costBasisQuote: null, costBasisApproximate: false }]);
    expect(r.costBasisQuote).toBeNull();
  });
});
