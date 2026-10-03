import { describe, expect, it, vi } from 'vitest';
import { CoinGeckoPriceProvider } from '../coingecko-provider';
import { PriceUnavailableError } from '../provider';

const ETH_NATIVE = { chain: 'ethereum' as const, address: '0x0000000000000000000000000000000000000000' };
const USDC = { chain: 'ethereum' as const, address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' };

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as unknown as Response;
}

describe('CoinGeckoPriceProvider', () => {
  it('returns a price using the upstream last_updated_at as the timestamp, not fetch time', async () => {
    const upstreamUnix = 1_700_000_000; // fixed point in the past
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        [USDC.address.toLowerCase()]: { usd: 1.0002, usd_last_updated_at: upstreamUnix },
      })
    );
    const provider = new CoinGeckoPriceProvider({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const price = await provider.getPrice(USDC);
    expect(price.price).toBe('1.0002');
    expect(price.source).toBe('coingecko');
    expect(price.timestamp).toBe(new Date(upstreamUnix * 1000).toISOString());
  });

  it('resolves the native asset via the coin id, not the sentinel address', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ ethereum: { usd: 3000, usd_last_updated_at: 1_700_000_000 } })
    );
    const provider = new CoinGeckoPriceProvider({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const price = await provider.getPrice(ETH_NATIVE);
    expect(price.price).toBe('3000');
    const calledUrl = fetchImpl.mock.calls[0][0] as string;
    expect(calledUrl).toContain('/simple/price');
    expect(calledUrl).toContain('ids=ethereum');
  });

  it('fails closed on a non-2xx response — never fabricates a price', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, false));
    const provider = new CoinGeckoPriceProvider({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(provider.getPrice(USDC)).rejects.toThrow(PriceUnavailableError);
  });

  it('fails closed when the asset is missing from the response body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}));
    const provider = new CoinGeckoPriceProvider({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(provider.getPrice(USDC)).rejects.toThrow(PriceUnavailableError);
  });

  it('fails closed on a zero or negative price rather than passing it through', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ [USDC.address.toLowerCase()]: { usd: 0, usd_last_updated_at: 1_700_000_000 } })
    );
    const provider = new CoinGeckoPriceProvider({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(provider.getPrice(USDC)).rejects.toThrow(PriceUnavailableError);
  });

  it('fails closed when last_updated_at is missing (cannot assess staleness)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ [USDC.address.toLowerCase()]: { usd: 1 } }));
    const provider = new CoinGeckoPriceProvider({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(provider.getPrice(USDC)).rejects.toThrow(PriceUnavailableError);
  });

  it('fails closed for a chain with no CoinGecko platform mapping (e.g. robinhood) without ever calling fetch', async () => {
    const fetchImpl = vi.fn();
    const provider = new CoinGeckoPriceProvider({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(provider.getPrice({ chain: 'robinhood', address: '0x1234567890123456789012345678901234567890' })).rejects.toThrow(
      PriceUnavailableError
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('retries transient/network failures but never retries a successfully-parsed invalid response', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network down'));
    const provider = new CoinGeckoPriceProvider({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(provider.getPrice(USDC)).rejects.toThrow(PriceUnavailableError);
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(1); // retried

    const fetchImplBadData = vi.fn().mockResolvedValue(jsonResponse({}));
    const provider2 = new CoinGeckoPriceProvider({ fetchImpl: fetchImplBadData as unknown as typeof fetch });
    await expect(provider2.getPrice(USDC)).rejects.toThrow(PriceUnavailableError);
    expect(fetchImplBadData.mock.calls.length).toBe(1); // not retried
  });

  it('formats very small and very large magnitudes without exponential notation', async () => {
    const cases: Array<[number, string]> = [
      [0.00000123, '0.00000123'],
      [123000000, '123000000'],
      [0.1, '0.1'],
    ];
    for (const [input, expected] of cases) {
      const fetchImpl = vi.fn().mockResolvedValue(
        jsonResponse({ [USDC.address.toLowerCase()]: { usd: input, usd_last_updated_at: 1_700_000_000 } })
      );
      const provider = new CoinGeckoPriceProvider({ fetchImpl: fetchImpl as unknown as typeof fetch });
      const price = await provider.getPrice(USDC);
      expect(price.price).toBe(expected);
    }
  });

  it('caches a resolved price for the configured TTL instead of re-fetching', async () => {
    let now = new Date('2026-01-01T00:00:00Z');
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ [USDC.address.toLowerCase()]: { usd: 1, usd_last_updated_at: 1_700_000_000 } })
    );
    const provider = new CoinGeckoPriceProvider({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      cacheTtlMs: 10_000,
      now: () => now,
    });

    await provider.getPrice(USDC);
    await provider.getPrice(USDC);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    now = new Date(now.getTime() + 11_000);
    await provider.getPrice(USDC);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
