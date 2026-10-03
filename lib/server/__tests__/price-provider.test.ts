import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __resetPriceProviderForTests,
  getPriceProvider,
  MockPriceProviderInProductionError,
} from '../price-provider';
import { BagPriceRouter } from '@/lib/domain/basket-protocol/pricing/bag-price-router';
import { MockPriceProvider } from '@/lib/domain/basket-protocol/pricing/mock-provider';

function resetEnv() {
  vi.unstubAllEnvs();
  __resetPriceProviderForTests();
}

describe('getPriceProvider', () => {
  afterEach(resetEnv);

  it('defaults to the REAL multi-chain price router (LI.FI crypto, Robinhood Stock Token API) — never a mock', () => {
    vi.stubEnv('PRICE_PROVIDER', '');
    vi.stubEnv('NODE_ENV', 'development');
    expect(getPriceProvider()).toBeInstanceOf(BagPriceRouter);
    expect(getPriceProvider()).not.toBeInstanceOf(MockPriceProvider);
  });

  it('allows PRICE_PROVIDER=mock outside production, for local dev/CI', () => {
    vi.stubEnv('PRICE_PROVIDER', 'mock');
    vi.stubEnv('NODE_ENV', 'test');
    expect(getPriceProvider()).toBeInstanceOf(MockPriceProvider);
  });

  it('refuses to start a mock price provider in production — fails fast, never silently falls back', () => {
    vi.stubEnv('PRICE_PROVIDER', 'mock');
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => getPriceProvider()).toThrow(MockPriceProviderInProductionError);
  });

  it('uses a real provider in production regardless of the mock flag being unset', () => {
    vi.stubEnv('PRICE_PROVIDER', '');
    vi.stubEnv('NODE_ENV', 'production');
    expect(getPriceProvider()).toBeInstanceOf(BagPriceRouter);
    expect(getPriceProvider()).not.toBeInstanceOf(MockPriceProvider);
  });

  it('memoizes the provider across calls within a process', () => {
    vi.stubEnv('NODE_ENV', 'development');
    const first = getPriceProvider();
    const second = getPriceProvider();
    expect(first).toBe(second);
  });
});
