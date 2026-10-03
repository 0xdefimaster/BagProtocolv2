import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { RateLimiter, RobinhoodStockApi } from '@/lib/domain/basket-protocol/pricing/robinhood-stock-api';

// Route-level test for GET /api/stock-quotes with a scripted Robinhood API
// (no network). Same placement convention as assets-route.test.ts.

const CRWD = '0xea72ecca2d0f6bfa1394dbbcff85b52cd4233931';
const registry = {
  assets: [
    { id: '1', tokenSymbol: 'CRWD', tokenName: 'CrowdStrike • Robinhood Token', deployments: [{ contractAddress: CRWD, chainId: 4663 }], currentMultiplier: '4.0', pendingMultiplier: '4.5', status: 'ASSET_STATUS_ACTIVE', tokenDecimals: 18 },
    { id: '2', tokenSymbol: 'DOWN', tokenName: 'Down', deployments: [{ contractAddress: '0x5555555555555555555555555555555555555555', chainId: 4663 }], currentMultiplier: '1', status: 'ASSET_STATUS_ACTIVE', tokenDecimals: 18 },
  ],
};
const fetchImpl = vi.fn(async (url: string) => {
  if (url.endsWith('/rhj/assets')) return new Response(JSON.stringify(registry));
  if (url.endsWith('/CRWD')) return new Response(JSON.stringify({ bid: '100', ask: '100.1', dailyTradingVolume: 42, isTradingHalt: false, generatedAt: new Date().toISOString() }));
  return new Response('{}', { status: 500 });
}) as unknown as typeof fetch;
const api = new RobinhoodStockApi({ fetchImpl, limiter: new RateLimiter(1000) });

vi.mock('@/lib/server/price-provider', () => ({ getRobinhoodStockApi: () => api }));

import { GET } from '@/app/api/stock-quotes/route';

const get = (q: string) => GET(new NextRequest(`http://localhost/api/stock-quotes${q}`));

describe('GET /api/stock-quotes', () => {
  it('returns per-token bid/ask (raw × multiplier) alongside the raw quote', async () => {
    const res = await get('?symbols=crwd,NOPE,DOWN');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('s-maxage=15');
    const body = await res.json();
    expect(body.quotes.CRWD).toMatchObject({
      address: CRWD,
      bid: '400.000000000000000000',
      ask: '400.400000000000000000',
      rawBid: '100.000000000000000000',
      currentMultiplier: '4.0',
      pendingMultiplier: '4.5',
      spreadBps: 10,
      dailyTradingVolume: '42',
      isTradingHalt: false,
    });
    expect(body.errors).toEqual({ NOPE: 'NOT_A_STOCK_TOKEN', DOWN: 'UNAVAILABLE' });
  });

  it.each([[''], ['?symbols='], ['?symbols=A%20B'], [`?symbols=${Array.from({ length: 26 }, (_, i) => `S${i}`).join(',')}`]])(
    'rejects bad input %s with 400',
    async (q) => {
      expect((await get(q)).status).toBe(400);
    }
  );
});
