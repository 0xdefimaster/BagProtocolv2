import { describe, expect, it } from 'vitest';
import { CanonicalAsset } from '@/types/basket-protocol';
import { paymentAssetsFor } from '../payment-assets';

const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

function asset(symbol: string, address: string, overrides: Partial<CanonicalAsset> = {}): CanonicalAsset {
  return {
    id: `${symbol}-${address}`,
    chain: 'robinhood',
    address,
    symbol,
    decimals: 6,
    name: symbol,
    status: 'VERIFIED',
    assetType: 'crypto',
    createdAt: '',
    updatedAt: '',
    ...overrides,
  };
}

describe('paymentAssetsFor', () => {
  it('on Robinhood Chain offers only the pinned USDG contract — never a Stock Token, WETH or another coin', () => {
    const result = paymentAssetsFor(
      [
        asset('AAPL', '0x1111111111111111111111111111111111111111', { assetType: 'stock' }),
        asset('WETH', '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73'),
        asset('USDG', USDG.toLowerCase()),
      ],
      'robinhood'
    );
    expect(result.map((a) => a.symbol)).toEqual(['USDG']);
  });

  it('ignores a look-alike token that only shares the USDG symbol', () => {
    expect(paymentAssetsFor([asset('USDG', '0x0A3B763d66c0e8c7555c986A3701E1DC1Bf3954F')], 'robinhood')).toEqual([]);
  });

  it('ignores a DEPRECATED USDG and USDG from another chain', () => {
    expect(
      paymentAssetsFor([asset('USDG', USDG, { status: 'DEPRECATED' }), asset('USDG', USDG, { chain: 'base' })], 'robinhood')
    ).toEqual([]);
  });

  it('uses the pinned native USDC elsewhere', () => {
    const result = paymentAssetsFor(
      [asset('USDC', BASE_USDC, { chain: 'base' }), asset('USDC', '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA', { chain: 'base' })],
      'base'
    );
    expect(result.map((a) => a.address)).toEqual([BASE_USDC]);
  });
});


describe('native ETH payment asset', () => {
  it('adds native ETH after Ethereum USDC without touching Robinhood USDG', () => {
    const ethereumUsdc = asset('USDC', '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', { chain: 'ethereum', decimals: 6 });
    const ethereum = paymentAssetsFor([ethereumUsdc], 'ethereum');
    expect(ethereum.map((a) => a.symbol)).toEqual(['USDC', 'ETH']);
    expect(ethereum[1].address).toBe('0x0000000000000000000000000000000000000000');
    expect(ethereum[1].decimals).toBe(18);
    expect(ethereum[1].id).toBe('native:ethereum:ETH');

    const robinhood = paymentAssetsFor([asset('USDG', USDG)], 'robinhood');
    expect(robinhood.map((a) => a.symbol)).toEqual(['USDG']);
  });
});
