import { describe, expect, it } from 'vitest';
import { AssetIdentity } from '@/types/basket-protocol';
import { PriceUnavailableError } from '../provider';
import {
  buildQuote,
  isFractionallyTradable,
  parseCorporateActions,
  parseRobinhoodPrice,
  RateLimiter,
  reconcileCorporateActions,
  RobinhoodApiPriceProvider,
  RobinhoodPriceApiError,
  toStockToken,
} from '../robinhood-stock-api';
import { ChainlinkFeedPriceProvider, FeedReadClient, parseChainlinkFeeds } from '../chainlink-feed-provider';
import { AAPL, CRWD, FEED, feedClient, fixture, harness, IMPOSTOR, NOW, quoteBody, UNTRADABLE } from './robinhood-harness';

// Everything here runs against scripted HTTP / chain doubles built from live
// captures (fixtures/README.md). No test reaches api.robinhood.com or an RPC.

const asset = (address: string): AssetIdentity => ({ chain: 'robinhood', address });

describe('parseRobinhoodPrice — live /prices shape', () => {
  it('reads the live {"quotes":[…]} capture for AAPL', () => {
    const p = parseRobinhoodPrice(fixture('rhj-prices-AAPL.json'), 'AAPL');
    expect(p.bid).toBe(BigInt('327770000000000000000'));
    expect(p.ask).toBe(BigInt('327780000000000000000'));
    expect(p.currency).toBe('USD');
    expect(p.dailyTradingVolume).toBe('25806784');
    expect(p.isTradingHalt).toBe(false);
    expect(p.generatedAt).toBe('2026-09-03T19:43:54.478Z'); // nanosecond input normalised
    expect(p.contractAddress).toBe(AAPL);
  });
  it('also accepts a bare quote object', () => {
    expect(parseRobinhoodPrice({ bid: '1', ask: '2', isTradingHalt: false, generatedAt: new Date(NOW).toISOString() }, 'X').currency).toBe('USD');
  });
  it.each([
    ['not an object', []],
    ['quote for another symbol', quoteBody('MSFT', '1', '1')],
    ['empty quotes', { quotes: [] }],
    ['missing bid', { quotes: [{ tokenSymbol: 'X', ask: '1', isTradingHalt: false, generatedAt: new Date(NOW).toISOString() }] }],
    ['negative ask', quoteBody('X', '1', '-1')],
    ['exponent number', quoteBody('X', 1e-7 as never, '1')],
    ['non-USD currency', quoteBody('X', '1', '1', { currency: 'EUR' })],
    ['missing isTradingHalt', quoteBody('X', '1', '1', { isTradingHalt: undefined })],
    ['bad generatedAt', quoteBody('X', '1', '1', { generatedAt: 'yesterday' })],
  ])('rejects %s', (_label, body) => {
    expect(() => parseRobinhoodPrice(body, 'X')).toThrow(RobinhoodPriceApiError);
  });
});

describe('registry (/assets) → Stock Tokens', () => {
  it('maps a live asset: canonical address, 18-dp multiplier, logo, capabilities', () => {
    const live = fixture('rhj-assets.json').assets.find((a: { tokenSymbol: string }) => a.tokenSymbol === 'CRWD');
    const t = toStockToken(live)!;
    expect(t.address).toBe(CRWD);
    expect(t.currentMultiplier).toBe('4.000000000000000000');
    expect(t.pendingMultiplier).toBeNull(); // "" in the API
    expect(t.logoUrl).toMatch(/^https:\/\/cdn\.robinhood\.com\//);
    expect(isFractionallyTradable(t)).toBe(true);
  });

  it('chainId 4663 only, ACTIVE only; identity is the ADDRESS, never the ticker', async () => {
    const { api } = harness();
    expect((await api.tokenByAddress(AAPL.toUpperCase().replace('0X', '0x')))?.symbol).toBe('AAPL');
    expect(await api.tokenByAddress(IMPOSTOR)).toBeNull(); // any other contract calling itself AAPL
    expect(await api.tokenBySymbol('OLD')).toBeNull(); // inactive
    expect(await api.tokenBySymbol('ARBO')).toBeNull(); // no Robinhood Chain deployment
    expect((await api.allTokens()).length).toBe(6);
  });

  it('trading capability validation and pending multiplier with effective time', async () => {
    const { api } = harness();
    const t = (await api.tokenByAddress(UNTRADABLE))!;
    expect(isFractionallyTradable(t)).toBe(false);
    expect(t.pendingMultiplier).toBe('2.0');
    expect(t.pendingMultiplierEffectiveTime).toBe('2026-11-02');
    expect(isFractionallyTradable({ ...t, tradingCapabilities: {} })).toBe(false); // missing = fail closed
  });
});

describe('multiplier: /prices is per SHARE, holdings are per TOKEN', () => {
  it('CRWD ×4.0: per-token bid/ask = raw × multiplier', async () => {
    const { api } = harness({ CRWD: quoteBody('CRWD', '100.00', '100.10') });
    const q = await api.quote((await api.tokenByAddress(CRWD))!);
    expect(q.bid).toBe('400.000000000000000000');
    expect(q.ask).toBe('400.400000000000000000');
    expect(q.mid).toBe('400.200000000000000000');
    expect(q.rawBid).toBe('100.000000000000000000');
    expect(q.spreadBps).toBe(10);
  });
  it('AAPL live capture with its live multiplier (1.000566…) stays exact', async () => {
    const { api } = harness({ AAPL: fixture('rhj-prices-AAPL.json') });
    const q = await api.quote((await api.tokenByAddress(AAPL))!);
    // 327.77 × 1.000566080061092436 = 327.95554406162426774772 (truncated at 18 dp)
    expect(q.bid).toBe('327.955544061624267747');
  });
  it('a quote naming a different Robinhood Chain contract is rejected', async () => {
    const body = quoteBody('AAPL', '1', '1', { deployments: [{ contractAddress: IMPOSTOR, chainId: 4663 }] });
    const { api } = harness({ AAPL: body });
    await expect(api.quote((await api.tokenByAddress(AAPL))!)).rejects.toMatchObject({ kind: 'IDENTITY' });
  });
  it('buildQuote marks a crossed quote with an infinite spread', () => {
    const t = { id: 'x', symbol: 'X', name: 'x', address: AAPL, decimals: 18, currentMultiplier: '1', pendingMultiplier: null, pendingMultiplierEffectiveTime: null, logoUrl: null, tradingCapabilities: {} };
    expect(buildQuote(t, parseRobinhoodPrice(quoteBody('X', '2', '1'), 'X')).spreadBps).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('caching, rate limit, 429, timeout', () => {
  it('a symbol is fetched at most once per 15 s; concurrent requests share one fetch', async () => {
    const h = harness({ AAPL: quoteBody('AAPL', '1', '1') });
    await Promise.all([h.api.rawPrice('AAPL'), h.api.rawPrice('aapl')]);
    h.advance(14_000);
    await h.api.rawPrice('AAPL');
    expect(h.calls.filter((c) => c.endsWith('/AAPL'))).toHaveLength(1);
    h.advance(1_001);
    await h.api.rawPrice('AAPL');
    expect(h.calls.filter((c) => c.endsWith('/AAPL'))).toHaveLength(2);
  });

  it('registry is cached separately from prices (5 min) and survives an outage (retry after 60 s)', async () => {
    const h = harness({ AAPL: quoteBody('AAPL', '1', '1') });
    await h.api.tokenByAddress(AAPL);
    h.advance(20_000);
    await h.api.rawPrice('AAPL');
    await h.api.tokenByAddress(AAPL);
    const reg = () => h.calls.filter((c) => c.endsWith('/assets')).length;
    expect(reg()).toBe(1);
    h.advance(5 * 60 * 1000);
    h.setRegistryStatus(503);
    expect((await h.api.tokenByAddress(AAPL))?.symbol).toBe('AAPL');
    await h.api.tokenByAddress(AAPL);
    expect(reg()).toBe(2);
    h.advance(61_000);
    await h.api.tokenByAddress(AAPL);
    expect(reg()).toBe(3);
  });

  it('with no registry ever loaded, lookups fail loudly', async () => {
    await expect(harness({}, { registryStatus: 503 }).api.tokenByAddress(AAPL)).rejects.toThrow();
  });

  it('never caches a failure', async () => {
    const prices: Record<string, never> = { AAPL: 500 as never };
    const h = harness(prices);
    await expect(h.api.rawPrice('AAPL')).rejects.toMatchObject({ kind: 'HTTP' });
    (prices as Record<string, unknown>).AAPL = quoteBody('AAPL', '1', '1');
    await expect(h.api.rawPrice('AAPL')).resolves.toBeTruthy();
  });

  it('429 is classified and pauses every later call (Retry-After honoured)', async () => {
    const h = harness({ AAPL: { status: 429, headers: { 'retry-after': '3' } }, CRWD: quoteBody('CRWD', '1', '1') });
    await expect(h.api.rawPrice('AAPL')).rejects.toMatchObject({ kind: 'RATE_LIMITED' });
  });

  it('404 means no quote for that symbol', async () => {
    await expect(harness({}).api.rawPrice('NOPE')).rejects.toMatchObject({ kind: 'NO_QUOTE' });
  });

  it('timeout is classified', async () => {
    const h = harness({ AAPL: 'timeout' }, { timeoutMs: 20 });
    await expect(h.api.rawPrice('AAPL')).rejects.toMatchObject({ kind: 'TIMEOUT' });
  });

  it('rate limiter waits instead of exceeding the limit, and after pause()', async () => {
    let t = 0;
    const sleeps: number[] = [];
    const rl = new RateLimiter(2, () => t, async (ms) => {
      sleeps.push(ms);
      t += ms;
    });
    await rl.take();
    await rl.take();
    await rl.take();
    expect(sleeps).toEqual([1001]);
    rl.pause(5000);
    await rl.take();
    expect(sleeps[1]).toBe(5000);
  });
});

describe('corporate actions', () => {
  it('parses the live {"corpActions":[…]} capture (protobuf processDate, cash dividend rate)', () => {
    const actions = parseCorporateActions(fixture('rhj-corporate-actions.json'));
    expect(actions.length).toBe(6);
    const sgov = actions[0];
    expect(sgov.tokenSymbol).toBe('SGOV');
    expect(sgov.type).toBe('CORPORATE_ACTION_TYPE_CASH_DIVIDEND');
    expect(sgov.processDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(sgov.cashDividendRate).toMatch(/^\d+(\.\d+)?$/);
    expect(sgov.contractAddress).toMatch(/^0x[0-9a-f]{40}$/);
  });

  it('rejects an unknown wrapper', () => {
    expect(() => parseCorporateActions({ actions: [] })).toThrow(RobinhoodPriceApiError);
  });

  it('is cached for 1 h (not per page load)', async () => {
    const h = harness();
    await h.api.corporateActions();
    h.advance(59 * 60 * 1000);
    await h.api.corporateActions();
    expect(h.calls.filter((c) => c.endsWith('/corporate-actions'))).toHaveLength(1);
    h.advance(2 * 60 * 1000);
    await h.api.corporateActions();
    expect(h.calls.filter((c) => c.endsWith('/corporate-actions'))).toHaveLength(2);
  });

  it('reconciles actions with the registry and local multipliers', async () => {
    const { api } = harness();
    const tokens = await api.allTokens();
    const actions = await api.corporateActions();
    const forged = { ...actions[0], id: 'forged', contractAddress: IMPOSTOR };
    const r = reconcileCorporateActions([...actions, forged], tokens, { [CRWD]: '1.0', [AAPL]: '1.000566080061092436' });
    expect(r.matched.map((m) => m.token.symbol)).toEqual(expect.arrayContaining(['SGOV', 'NVDA', 'AAPL']));
    expect(r.matched.some((m) => m.action.tokenSymbol === 'AMAT')).toBe(false); // not in the registry here
    expect(r.identityMismatch.map((a) => a.id)).toContain('forged');
    expect(r.pendingMultiplierChanges.map((p) => [p.token.symbol, p.pendingMultiplier, p.effectiveTime])).toEqual([['HALTD', '2.0', '2026-11-02']]);
    expect(r.multiplierDrift).toEqual([{ address: CRWD, local: '1.0', registry: '4.000000000000000000' }]);
  });
});

describe('RobinhoodApiPriceProvider — fail closed', () => {
  const provider = (h: ReturnType<typeof harness>) => new RobinhoodApiPriceProvider({ api: h.api, now: h.now });

  it('prices a registry token at mid × multiplier', async () => {
    const p = await provider(harness({ CRWD: quoteBody('CRWD', '100', '100.2') })).getPrice(asset(CRWD));
    expect(p.price).toBe('400.400000000000000000');
    expect(p.source).toBe('robinhood-api:prices:CRWD:mid×4.000000000000000000');
  });

  it.each([
    ['impostor address with a Stock Token ticker', IMPOSTOR, {}],
    ['trading halt', AAPL, { AAPL: quoteBody('AAPL', '1', '1', { isTradingHalt: true }) }],
    ['stale quote', AAPL, { AAPL: quoteBody('AAPL', '1', '1', { generatedAt: new Date(NOW - 6 * 60 * 1000).toISOString() }) }],
    ['spread wider than 5%', AAPL, { AAPL: quoteBody('AAPL', '100', '106') }],
    ['crossed quote', AAPL, { AAPL: quoteBody('AAPL', '101', '100') }],
    ['zero bid', AAPL, { AAPL: quoteBody('AAPL', '0', '1') }],
    ['API error', AAPL, { AAPL: 503 }],
    ['rate limited', AAPL, { AAPL: 429 }],
  ])('%s -> PriceUnavailable', async (_l, address, prices) => {
    await expect(provider(harness(prices as never)).getPrice(asset(address))).rejects.toThrow(PriceUnavailableError);
  });
});

// ------------------------------- Chainlink ----------------------------------

const chainlink = (c: FeedReadClient) => new ChainlinkFeedPriceProvider({ client: c, feeds: { [CRWD]: FEED }, now: () => new Date(NOW) });

describe('ChainlinkFeedPriceProvider (on-chain oracle read)', () => {
  it('uses the answer AS-IS (already multiplier-adjusted), scaled by feed decimals', async () => {
    const p = await chainlink(feedClient()).getPrice(asset(CRWD));
    expect(p.price).toBe('400.20000000');
    expect(p.source).toBe(`chainlink:${FEED.toLowerCase()}`);
  });
  it.each([
    ['unconfigured asset', feedClient(), AAPL],
    ['stale round', feedClient({ updatedAt: (NOW - 10 * 60 * 1000) / 1000 }), CRWD],
    ['non-positive answer', feedClient({ answer: BigInt(0) }), CRWD],
    ['incomplete round', feedClient({ updatedAt: 0 }), CRWD],
    ['answeredInRound < roundId', feedClient({ answeredInRound: BigInt(9) }), CRWD],
    ['RPC error', feedClient({ throws: true }), CRWD],
  ])('%s -> PriceUnavailable', async (_l, c, address) => {
    await expect(chainlink(c).getPrice(asset(address))).rejects.toThrow(PriceUnavailableError);
  });
  it('parseChainlinkFeeds validates address pairs', () => {
    expect(parseChainlinkFeeds(undefined)).toEqual({});
    expect(parseChainlinkFeeds(`{"${CRWD.toUpperCase().replace('0X', '0x')}":"${FEED}"}`)).toEqual({ [CRWD]: FEED });
    expect(() => parseChainlinkFeeds('{"0x1":"0x2"}')).toThrow();
    expect(() => parseChainlinkFeeds('[]')).toThrow();
    expect(() => parseChainlinkFeeds('nope')).toThrow();
  });
});
