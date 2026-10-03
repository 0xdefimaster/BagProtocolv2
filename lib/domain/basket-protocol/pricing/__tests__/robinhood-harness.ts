import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Hex } from 'viem';
import { RateLimiter, RobinhoodStockApi } from '../robinhood-stock-api';
import type { FeedReadClient } from '../chainlink-feed-provider';

// Shared scripted /rhj API for pricing tests. The registry is the live-capture
// fixture (AAPL, CRWD ×4, CRM, SGOV, NVDA) plus three clearly SYNTHETIC entries
// exercising the filters (inactive, Arbitrum-only, untradable).

export const fixture = (name: string) => JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8'));

export const AAPL = '0xaf3d76f1834a1d425780943c99ea8a608f8a93f9';
export const CRWD = '0xea72ecca2d0f6bfa1394dbbcff85b52cd4233931';
export const IMPOSTOR = '0x1111111111111111111111111111111111111111';
export const UNTRADABLE = '0x6666666666666666666666666666666666666666';
export const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
export const NOW = Date.parse('2026-09-28T14:00:00Z');

const tradable = { market: { whole: 'TRADING_STATUS_TRADABLE', fractional: 'TRADING_STATUS_TRADABLE' } };
export function registryBody() {
  const live = fixture('rhj-assets.json').assets;
  return {
    assets: [
      ...live,
      { id: 's1', tokenSymbol: 'OLD', tokenName: 'Synthetic inactive', deployments: [{ contractAddress: '0x3333333333333333333333333333333333333333', chainId: 4663 }], currentMultiplier: '1', pendingMultiplier: '', status: 'ASSET_STATUS_INACTIVE', tradingCapabilities: tradable, tokenDecimals: 18 },
      { id: 's2', tokenSymbol: 'ARBO', tokenName: 'Synthetic Arbitrum-only', deployments: [{ contractAddress: '0x4444444444444444444444444444444444444444', chainId: 42161 }], currentMultiplier: '1', pendingMultiplier: '', status: 'ASSET_STATUS_ACTIVE', tradingCapabilities: tradable, tokenDecimals: 18 },
      { id: 's3', tokenSymbol: 'HALTD', tokenName: 'Synthetic untradable', deployments: [{ contractAddress: UNTRADABLE, chainId: 4663 }], currentMultiplier: '1', pendingMultiplier: '2.0', pendingMultiplierEffectiveTime: { year: 2026, month: 11, day: 2 }, status: 'ASSET_STATUS_ACTIVE', tradingCapabilities: { market: { whole: 'TRADING_STATUS_UNTRADABLE', fractional: 'TRADING_STATUS_UNTRADABLE' } }, tokenDecimals: 18 },
    ],
  };
}

export type PriceBody = Record<string, unknown>;
/** A live-shaped /prices body: {"quotes":[{…}]}. */
export const quoteBody = (symbol: string, bid: string, ask: string, o: Partial<PriceBody> = {}): PriceBody => ({
  quotes: [{ tokenSymbol: symbol, bid, ask, currency: 'USD', dailyTradingVolume: '1000', isTradingHalt: false, generatedAt: new Date(NOW - 5_000).toISOString(), ...o }],
});

export type Scripted = PriceBody | number | 'timeout' | { status: number; headers: Record<string, string> };

export function harness(prices: Record<string, Scripted> = {}, opts: { registryStatus?: number; actions?: Scripted; timeoutMs?: number } = {}) {
  let t = NOW;
  const calls: string[] = [];
  const respond = (s: Scripted, signal?: AbortSignal): Promise<Response> => {
    if (s === 'timeout') return new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted'))));
    if (typeof s === 'number') return Promise.resolve(new Response('{}', { status: s }));
    if ('status' in s && 'headers' in s) return Promise.resolve(new Response('{}', { status: s.status as number, headers: s.headers as Record<string, string> }));
    return Promise.resolve(new Response(JSON.stringify(s), { status: 200 }));
  };
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push(url);
    if (url.endsWith('/assets')) return new Response(JSON.stringify(registryBody()), { status: opts.registryStatus ?? 200 });
    if (url.endsWith('/corporate-actions')) return respond(opts.actions ?? fixture('rhj-corporate-actions.json'), init?.signal ?? undefined);
    const symbol = url.split('/').pop()!;
    return respond(prices[symbol] ?? 404, init?.signal ?? undefined);
  }) as unknown as typeof fetch;
  const api = new RobinhoodStockApi({ fetchImpl, now: () => t, limiter: new RateLimiter(1000, () => t), timeoutMs: opts.timeoutMs });
  return { api, calls, advance: (ms: number) => (t += ms), now: () => new Date(t), setRegistryStatus: (s: number) => (opts.registryStatus = s) };
}

export const FEED: Hex = '0x2222222222222222222222222222222222222222';
export function feedClient(o: { answer?: bigint; decimals?: number; updatedAt?: number; roundId?: bigint; answeredInRound?: bigint; throws?: boolean } = {}): FeedReadClient {
  return {
    readContract: (async ({ functionName }: { functionName: string }) => {
      if (o.throws) throw new Error('rpc down');
      if (functionName === 'decimals') return o.decimals ?? 8;
      const roundId = o.roundId ?? BigInt(10);
      return [roundId, o.answer ?? BigInt(40020000000), BigInt(0), BigInt(o.updatedAt ?? (NOW - 60_000) / 1000), o.answeredInRound ?? roundId];
    }) as unknown as FeedReadClient['readContract'],
  };
}
