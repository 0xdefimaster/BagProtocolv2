import { describe, expect, it, vi } from 'vitest';
import {
  ServerTradingPriceFeed,
  TradingPriceUnavailableError,
  __setTradingPriceFeedForTests,
  getTradingPriceFeed,
} from '../trading-price-provider';

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as unknown as Response;
}

describe('ServerTradingPriceFeed', () => {
  it('resolves a known symbol from CoinGecko\'s simple/price response, never a caller-supplied number', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        bitcoin: { usd: 65000 },
        ethereum: { usd: 3400 },
        solana: { usd: 165 },
        binancecoin: { usd: 580 },
        ripple: { usd: 0.62 },
        dogecoin: { usd: 0.14 },
        chainlink: { usd: 14.5 },
        'avalanche-2': { usd: 32 },
      })
    );
    const feed = new ServerTradingPriceFeed({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(feed.getPrice('BTC')).resolves.toBe(65000);
    // One upstream call serves every symbol, not one call per symbol.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('fails closed for an unknown symbol — throws rather than returning undefined/0', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ bitcoin: { usd: 65000 } }));
    const feed = new ServerTradingPriceFeed({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(feed.getPrice('NOT_A_SYMBOL')).rejects.toThrow(TradingPriceUnavailableError);
  });

  it('fails closed when CoinGecko has no entry for a symbol this round', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({})); // nothing priced
    const feed = new ServerTradingPriceFeed({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(feed.getPrice('BTC')).rejects.toThrow(TradingPriceUnavailableError);
    const prices = await feed.getPrices();
    expect(prices).toEqual({});
  });

  it('fails closed on a non-2xx response after retrying, without throwing out of getPrices()', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, false));
    const feed = new ServerTradingPriceFeed({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 50,
    });

    const prices = await feed.getPrices();
    expect(prices).toEqual({});
    // Initial attempt + MAX_RETRIES(2) = 3 calls.
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('ignores a zero or negative upstream price rather than passing it through', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ bitcoin: { usd: 0 } }));
    const feed = new ServerTradingPriceFeed({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(feed.getPrice('BTC')).rejects.toThrow(TradingPriceUnavailableError);
  });

  it('caches the batch response across calls within the TTL — no repeated upstream calls', async () => {
    let now = 0;
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ bitcoin: { usd: 65000 } }));
    const feed = new ServerTradingPriceFeed({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => new Date(now),
      cacheTtlMs: 15_000,
    });

    await feed.getPrice('BTC');
    now += 5_000;
    await feed.getPrice('BTC');
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    now += 20_000; // past the TTL
    await feed.getPrice('BTC');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('collapses concurrent callers onto a single in-flight upstream request', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ bitcoin: { usd: 65000 } }));
    const feed = new ServerTradingPriceFeed({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const [a, b] = await Promise.all([feed.getPrice('BTC'), feed.getPrice('BTC')]);
    expect(a).toBe(65000);
    expect(b).toBe(65000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('getTradingPriceFeed', () => {
  it('memoizes the feed across calls within a process', () => {
    __setTradingPriceFeedForTests(null);
    const first = getTradingPriceFeed();
    const second = getTradingPriceFeed();
    expect(first).toBe(second);
    __setTradingPriceFeedForTests(null);
  });

  it('lets tests inject a fake feed via __setTradingPriceFeedForTests', () => {
    const fake = new ServerTradingPriceFeed({ fetchImpl: vi.fn() as unknown as typeof fetch });
    __setTradingPriceFeedForTests(fake);
    expect(getTradingPriceFeed()).toBe(fake);
    __setTradingPriceFeedForTests(null);
  });
});
