import { describe, expect, it } from 'vitest';
import { feeSaleFeedCoverage, type CoverageBag } from '../fee-sale-feed-coverage';

// Synthetic addresses only.
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const STOCK_A = '0x00000000000000000000000000000000000000a1';
const STOCK_B = '0x00000000000000000000000000000000000000b2';
const WETH = '0x00000000000000000000000000000000000000e7';
const assetTypes = new Map<string, 'stock' | 'crypto'>([
  [STOCK_A, 'stock'],
  [STOCK_B, 'stock'],
  [WETH, 'crypto'],
]);
const bag = (o: Partial<CoverageBag>): CoverageBag => ({ id: 'b', name: 'B', chain: 'robinhood', feeBps: 1000, assets: [], ...o });

describe('feeSaleFeedCoverage', () => {
  it('only fee-bearing Bags; ready only when every priced leg has a feed', () => {
    const r = feeSaleFeedCoverage({
      settlementTokenAddress: USDG,
      assetTypes,
      feeds: { [STOCK_A]: '0x00000000000000000000000000000000000000f1' },
      bags: [
        bag({ id: 'free', feeBps: 0, assets: [{ address: STOCK_B, symbol: 'B' }] }),
        bag({ id: 'ok', assets: [{ address: STOCK_A, symbol: 'A' }, { address: USDG, symbol: 'USDG' }] }),
        bag({ id: 'missing', assets: [{ address: STOCK_A, symbol: 'A' }, { address: STOCK_B, symbol: 'B' }] }),
        bag({ id: 'crypto', assets: [{ address: WETH, symbol: 'WETH' }] }),
        bag({ id: 'unknown', assets: [{ address: '0x00000000000000000000000000000000000000ff', symbol: '?' }] }),
        bag({ id: 'base', chain: 'base', assets: [{ address: WETH, symbol: 'WETH' }] }),
      ],
    });
    expect(r.map((b) => [b.id, b.status])).toEqual([
      ['ok', 'READY_IF_FEEDS_LIVE'],
      ['missing', 'FEE_SALE_REFUSED'],
      ['crypto', 'FEE_SALE_REFUSED'],
      ['unknown', 'FEE_SALE_REFUSED'],
      ['base', 'CHAIN_NOT_SUPPORTED'],
    ]);
    expect(r[0].legs.map((l) => l.coverage)).toEqual(['FEED_CONFIGURED', 'NOT_PRICED']);
    expect(r[1].legs.map((l) => l.coverage)).toEqual(['FEED_CONFIGURED', 'MISSING_FEED']);
    expect(r[2].legs[0].coverage).toBe('NO_QUALIFIED_SOURCE');
    expect(r[3].legs[0].coverage).toBe('UNKNOWN_ASSET');
  });
});
