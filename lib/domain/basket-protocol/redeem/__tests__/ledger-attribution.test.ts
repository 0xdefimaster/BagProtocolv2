import { describe, expect, it } from 'vitest';
import { attributeSaleToLedger, ledgerKey } from '../ledger-attribution';

const A = '0x00000000000000000000000000000000000000A1';
const B = '0x00000000000000000000000000000000000000b2';
const cover = (shares: string, tracked: Record<string, string>) => ({
  sharesRaw: BigInt(shares),
  trackedRaw: new Map(Object.entries(tracked).map(([addr, q]) => [ledgerKey('robinhood', addr), BigInt(q)])),
});
const sale = (legs: [string, string, string | null][], burn: string, value: string) => ({
  legs: legs.map(([address, q, p]) => ({ chain: 'robinhood', address, quantityRaw: BigInt(q), proceedsRaw: p === null ? null : BigInt(p) })),
  sharesBurnRaw: BigInt(burn),
  redeemValueQuote: value,
});

describe('attributeSaleToLedger', () => {
  it('changes nothing when the ledger covers the sale', () => {
    const s = sale([[A, '40', '20'], [B, '50', '25']], '50', '45');
    expect(attributeSaleToLedger(s, cover('100', { [A]: '40', [B]: '100' }))).toEqual({ ...s, reduced: false });
  });

  it('debits at most what is tracked, burns at most the remaining shares, scales proceeds and value alike', () => {
    const r = attributeSaleToLedger(sale([[A, '40', '20'], [B, '55', '27500000']], '100', '50'), cover('50', { [A.toLowerCase()]: '50', [B]: '50' }));
    expect(r.reduced).toBe(true);
    expect(r.legs.map((l) => [l.quantityRaw, l.proceedsRaw])).toEqual([
      [BigInt(40), BigInt(20)],
      [BigInt(50), BigInt(25000000)],
    ]);
    expect(r.sharesBurnRaw).toBe(BigInt(50));
  });

  it('drops a leg with nothing tracked; two legs of one asset share what is tracked; unknown proceeds stay unknown', () => {
    const r = attributeSaleToLedger(sale([[A, '30', null], [A, '30', '10'], [B, '5', '5']], '10', '20'), cover('10', { [A]: '40' }));
    expect(r.legs.map((l) => [l.address, l.quantityRaw, l.proceedsRaw])).toEqual([
      [A, BigInt(30), null],
      [A, BigInt(10), BigInt(3)],
    ]);
    // Value scales by the known proceeds kept: (0 + 3) / (10 + 5).
    expect(r.redeemValueQuote).toBe('4');
  });
});
