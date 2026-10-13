import { describe, expect, it, vi } from 'vitest';
import { paymentAmountInQuoteCurrency, paymentAssetUsdPrice, PaymentValuationError, valuePayment } from '../payment-value';
import { NATIVE_ASSET_ADDRESS } from '@/lib/domain/basket-protocol/asset-identity';
import { BAG_CHAINS } from '@/lib/config/chains';
import { ROBINHOOD_REWARD_TOKEN } from '@/lib/config/robinhood-chain';
import type { PriceProvider } from '@/lib/domain/basket-protocol/pricing/provider';

const ETH_RH = { chain: 'robinhood' as const, address: NATIVE_ASSET_ADDRESS };
const USDG = { chain: 'robinhood' as const, address: ROBINHOOD_REWARD_TOKEN.address };

function provider(price: string, quoteCurrency = 'USD'): PriceProvider & { getPrice: ReturnType<typeof vi.fn> } {
  return { getPrice: vi.fn(async (asset) => ({ asset, price, quoteCurrency, timestamp: '2026-10-10T00:00:00Z', source: 'test' })) };
}

describe('payment value in USD', () => {
  it('a settlement stablecoin counts 1:1 and never asks for a price', async () => {
    const p = provider('3000');
    expect(await valuePayment(USDG, ' 250.5 ', p)).toEqual({ quoteAmount: '250.5', inputUsdPrice: '1' });
    expect(p.getPrice).not.toHaveBeenCalled();
  });

  it('native ETH is valued at the chain’s WETH price, from lib/config/chains.ts', async () => {
    const p = provider('3000.25');
    const v = await valuePayment(ETH_RH, '0.05', p);
    expect(p.getPrice).toHaveBeenCalledWith({ chain: 'robinhood', address: BAG_CHAINS.robinhood.wrappedNativeAddress });
    expect(v.inputUsdPrice).toBe('3000.25');
    expect(v.quoteAmount).toBe('150.012500000000000000');
  });

  it('floors at 18 decimals (never values a payment above its worth)', () => {
    // 1 wei × $3000.123456789012345678 = 3.000123456789012345678e-15 → floored to 18 dp
    expect(paymentAmountInQuoteCurrency('0.000000000000000001', '3000.123456789012345678')).toBe('0.000000000000003000');
  });

  it('refuses a non-USD quote and a zero price; Base values native ETH by its WETH', async () => {
    await expect(paymentAssetUsdPrice(ETH_RH, provider('3000', 'EUR'))).rejects.toBeInstanceOf(PaymentValuationError);
    await expect(paymentAssetUsdPrice(ETH_RH, provider('0'))).rejects.toBeInstanceOf(PaymentValuationError);
    const p = provider('3000');
    expect(await paymentAssetUsdPrice({ chain: 'base', address: NATIVE_ASSET_ADDRESS }, p)).toBe('3000');
    expect(p.getPrice).toHaveBeenCalledWith({ chain: 'base', address: '0x4200000000000000000000000000000000000006' });
  });

  it('a price outage propagates (no estimate)', async () => {
    const p: PriceProvider = { getPrice: async () => { throw new Error('LI.FI down'); } };
    await expect(valuePayment(ETH_RH, '1', p)).rejects.toThrow('LI.FI down');
  });
});
