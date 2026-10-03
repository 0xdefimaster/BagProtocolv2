import { describe, expect, it } from 'vitest';
import { AssetHolding, ShareSupply } from '@/types/basket-protocol';
import { MockPriceProvider } from '../../pricing/mock-provider';
import { calculateNav } from '../../nav/nav';
import { getDepositQuote, getSharePrice } from '../shares';

// -----------------------------------------------------------------------------
// Spec section 20 — the full pipeline this phase's Definition of Done
// requires:
//
//   Bag Holdings → NAV → Share State → NAV/share → Deposit Quote
//
// Worked example from the spec: holdings that price out to NAV = $1000,
// share supply = 100 → NAV/share = $10; a $250 deposit → 25 shares. The
// second half of the test is just as important as the first: computing a
// quote must leave `holdings`/`shareSupply` completely untouched — this is
// still only a QUOTE (spec section 10/11/13).
// -----------------------------------------------------------------------------

describe('Share accounting integration — Bag Holdings -> NAV -> Share State -> Deposit Quote', () => {
  it('holdings pricing to NAV $1000, supply 100 -> NAV/share $10; a $250 deposit quotes 25 shares, nothing mutated', async () => {
    const btc = { chain: 'ethereum' as const, address: '0x1111111111111111111111111111111111111b' };
    const holdings: AssetHolding[] = [{ asset: btc, quantityRaw: '10', decimals: 0 }];

    const provider = new MockPriceProvider();
    provider.setPrice(btc, '100'); // 10 * 100 = $1000 NAV

    const nav = await calculateNav(holdings, provider);
    expect(nav.grossNav.split('.')[0]).toBe('1000');

    const shareSupply: ShareSupply = {
      bagId: 'bag_integration',
      totalSharesRaw: (BigInt(100) * BigInt(10) ** BigInt(18)).toString(),
      shareDecimals: 18,
      updatedAt: nav.asOf,
    };

    const sharePrice = getSharePrice(nav, shareSupply);
    expect(sharePrice.value.split('.')[0]).toBe('10');

    const holdingsBefore = JSON.parse(JSON.stringify(holdings));
    const shareSupplyBefore = JSON.parse(JSON.stringify(shareSupply));

    const quote = getDepositQuote(nav, shareSupply, '250');
    expect(BigInt(quote.sharesRaw)).toBe(BigInt(25) * BigInt(10) ** BigInt(18));
    expect(quote.isBootstrap).toBe(false);

    // Still only a quote — the pipeline's inputs are untouched.
    expect(holdings).toEqual(holdingsBefore);
    expect(shareSupply).toEqual(shareSupplyBefore);
  });
});
