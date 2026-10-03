import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/blockchain/lifi-execution-adapter', () => ({ quoteSwapStep: vi.fn() }));

import { checkAssetRoute, clearAssetRouteCache } from '../asset-route-check';
import { PAYMENT_TOKEN_BY_CHAIN } from '../payment-assets';

const QNT = { chain: 'robinhood' as const, address: '0x55601b1ad2d23000000000000000000000000001' };
const okQuote = { quote: { outputAmountRaw: '1' }, error: null };
const noRoute = { quote: null, error: { code: 'QUOTE_UNAVAILABLE', message: 'No route' } };
const providerDown = { quote: null, error: { code: 'PROVIDER_ERROR', message: 'timeout' } };

describe('checkAssetRoute', () => {
  beforeEach(() => clearAssetRouteCache());

  it('ROUTABLE when LI.FI quotes the payment token into the asset', async () => {
    const quote = vi.fn().mockResolvedValue(okQuote);
    expect(await checkAssetRoute(QNT, 0, quote as never)).toBe('ROUTABLE');
    expect(quote.mock.calls[0][0].address).toBe(PAYMENT_TOKEN_BY_CHAIN.robinhood!.address);
  });

  it('NO_ROUTE on a no-route error, and caches it', async () => {
    const quote = vi.fn().mockResolvedValue(noRoute);
    expect(await checkAssetRoute(QNT, 0, quote as never)).toBe('NO_ROUTE');
    expect(await checkAssetRoute(QNT, 1000, quote as never)).toBe('NO_ROUTE');
    expect(quote).toHaveBeenCalledTimes(1);
  });

  it('re-probes once the cache entry expires', async () => {
    const quote = vi.fn().mockResolvedValueOnce(noRoute).mockResolvedValueOnce(okQuote);
    await checkAssetRoute(QNT, 0, quote as never);
    expect(await checkAssetRoute(QNT, 11 * 60 * 1000, quote as never)).toBe('ROUTABLE');
  });

  it('UNKNOWN (never NO_ROUTE) on a provider error, and does not cache it', async () => {
    const quote = vi.fn().mockResolvedValueOnce(providerDown).mockResolvedValueOnce(okQuote);
    expect(await checkAssetRoute(QNT, 0, quote as never)).toBe('UNKNOWN');
    expect(await checkAssetRoute(QNT, 1, quote as never)).toBe('ROUTABLE');
  });

  it('the payment token itself is ROUTABLE without a quote', async () => {
    const quote = vi.fn();
    const usdg = { chain: 'robinhood' as const, address: PAYMENT_TOKEN_BY_CHAIN.robinhood!.address };
    expect(await checkAssetRoute(usdg, 0, quote as never)).toBe('ROUTABLE');
    expect(quote).not.toHaveBeenCalled();
  });
});
