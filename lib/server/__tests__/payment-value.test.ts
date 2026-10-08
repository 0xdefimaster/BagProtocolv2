import { describe, expect, it, vi } from 'vitest';
import type { CanonicalAsset } from '@/types/basket-protocol';
import { NATIVE_ASSET_ADDRESS } from '@/lib/domain/basket-protocol/asset-identity';
import { ETHEREUM_WETH_ADDRESS, getPaymentAssetUsdPrice, paymentAmountToQuoteCurrency } from '../payment-value';

const getPrice = vi.fn(async () => ({
  asset: { chain: 'ethereum' as const, address: ETHEREUM_WETH_ADDRESS },
  price: '2500',
  quoteCurrency: 'USD',
  timestamp: new Date('2026-10-08T00:00:00Z').toISOString(),
  source: 'test',
}));

vi.mock('@/lib/server/price-provider', () => ({
  getPriceProvider: () => ({ getPrice }),
}));

const ETH = {
  id: 'native:ethereum:ETH',
  chain: 'ethereum' as const,
  address: NATIVE_ASSET_ADDRESS,
  symbol: 'ETH',
  decimals: 18,
  name: 'Ether',
  status: 'VERIFIED',
  assetType: 'crypto',
  createdAt: '',
  updatedAt: '',
} as CanonicalAsset;

describe('payment-value', () => {
  it('keeps settlement token amounts 1:1 in USD', async () => {
    const usdc = { ...ETH, address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', symbol: 'USDC', decimals: 6 };
    expect(await getPaymentAssetUsdPrice(usdc)).toBe('1');
    expect(await paymentAmountToQuoteCurrency(usdc, '100')).toBe('100');
    expect(getPrice).not.toHaveBeenCalled();
  });

  it('values native ETH using the WETH USD price', async () => {
    expect(await getPaymentAssetUsdPrice(ETH)).toBe('2500');
    expect(await paymentAmountToQuoteCurrency(ETH, '0.1')).toBe('250');
    expect(getPrice).toHaveBeenCalledWith({ chain: 'ethereum', address: ETHEREUM_WETH_ADDRESS });
  });
});
