import { describe, expect, it, vi } from 'vitest';
import type { Hex } from 'viem';
import { AssetIdentity, AssetPrice, ChainId } from '@/types/basket-protocol';
import { PriceDataGapError, PriceProvider, PriceUnavailableError } from '../provider';
import { RobinhoodApiPriceProvider } from '../robinhood-stock-api';
import { ChainlinkFeedPriceProvider, FeedReadClient } from '../chainlink-feed-provider';
import { BagPriceRouter, PriceSourceDisagreementError } from '../bag-price-router';
import { LiFiPriceProvider, LiFiTokenData } from '@/lib/blockchain/lifi-token-data';
import { calculateNav, StalePriceError } from '../../nav/nav';
import { AAPL, CRWD, FEED, feedClient, harness, IMPOSTOR, NOW, quoteBody, USDG } from './robinhood-harness';

// The unified router with every external source scripted: Robinhood /rhj
// (fixture-shaped), a Chainlink feed, and LI.FI token lookups.

const WETH_ARB = '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const WETH_ETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const WETH_RH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';
const CHAIN_IDS: Record<string, number> = { ethereum: 1, arbitrum: 42161, base: 8453, robinhood: 4663 };

type LiFiScript = Record<string, { priceUSD?: string; symbol?: string; decimals?: number } | 404 | 500>;
function lifi(tokens: LiFiScript, now: () => number) {
  const fetchToken = vi.fn(async (chainId: number, address: string) => {
    const t = tokens[`${chainId}:${address.toLowerCase()}`];
    if (t === undefined || t === 404) throw Object.assign(new Error('Token not found'), { cause: { status: 404 } });
    if (t === 500) throw Object.assign(new Error('Internal'), { status: 500 });
    return { chainId, address, symbol: t.symbol ?? 'TKN', name: t.symbol ?? 'Token', decimals: t.decimals ?? 18, priceUSD: t.priceUSD, logoURI: 'https://static.li.fi/x.png' };
  });
  return { data: new LiFiTokenData({ fetchToken, now }), fetchToken };
}
const key = (chain: string, address: string) => `${CHAIN_IDS[chain]}:${address.toLowerCase()}`;

function router(opts: {
  prices?: Parameters<typeof harness>[0];
  registryStatus?: number;
  feed?: FeedReadClient;
  feeds?: Record<string, Hex>;
  lifi?: LiFiScript;
  fallbacks?: Partial<Record<ChainId, PriceProvider>>;
}) {
  const h = harness(opts.prices ?? {}, { registryStatus: opts.registryStatus });
  const l = lifi(opts.lifi ?? {}, () => h.now().getTime());
  const r = new BagPriceRouter({
    stockApi: h.api,
    stockPrices: new RobinhoodApiPriceProvider({ api: h.api, now: h.now }),
    chainlink: new ChainlinkFeedPriceProvider({ client: opts.feed ?? feedClient(), feeds: opts.feeds ?? {}, now: h.now }),
    crypto: new LiFiPriceProvider(l.data),
    cryptoFallbacks: opts.fallbacks,
    usdgAddress: USDG,
  });
  return { r, h, l };
}
const rh = (address: string): AssetIdentity => ({ chain: 'robinhood', address });
const stub = (source: string, price = '1'): PriceProvider & { getPrice: ReturnType<typeof vi.fn> } => ({
  getPrice: vi.fn(async (asset: AssetIdentity): Promise<AssetPrice> => ({ asset, price, quoteCurrency: 'USD', timestamp: new Date(NOW).toISOString(), source })),
});

describe('Stock Tokens: Robinhood API first, Chainlink verifies', () => {
  it('no feed: Robinhood mid × multiplier', async () => {
    const { r } = router({ prices: { AAPL: quoteBody('AAPL', '213.45', '213.47') } });
    const p = await r.getPrice(rh(AAPL));
    expect(p.source.startsWith('robinhood-api:prices:AAPL')).toBe(true);
    expect(p.price).toBe('213.580835449840791388'); // 213.46 × 1.000566080061092436, 18 dp
  });

  it('feed configured: API price, verified per-token against Chainlink (×4 applied, 0 bps)', async () => {
    const { r } = router({ prices: { CRWD: quoteBody('CRWD', '100.00', '100.10') }, feeds: { [CRWD]: FEED } });
    const p = await r.getPrice(rh(CRWD));
    expect(p.price).toBe('400.200000000000000000');
    expect(p.source).toBe(`robinhood-api:prices:CRWD:mid×4.000000000000000000|verify:chainlink:${FEED.toLowerCase()}:0bps`);
    expect(p.confidence).toBe(1);
  });

  it('disagreement beyond 2% fails closed', async () => {
    const { r } = router({ prices: { CRWD: quoteBody('CRWD', '105', '105') }, feeds: { [CRWD]: FEED } });
    await expect(r.getPrice(rh(CRWD))).rejects.toThrow(PriceSourceDisagreementError);
  });

  it('Chainlink unavailable: API price stands, marked unverified', async () => {
    const { r } = router({ prices: { CRWD: quoteBody('CRWD', '100', '100.1') }, feeds: { [CRWD]: FEED }, feed: feedClient({ throws: true }) });
    const p = await r.getPrice(rh(CRWD));
    expect(p.source).toContain('|verify:chainlink-unavailable');
    expect(p.confidence).toBe(0.5);
  });

  it('API unavailable: Chainlink does NOT substitute', async () => {
    const { r } = router({ prices: { CRWD: 503 }, feeds: { [CRWD]: FEED } });
    await expect(r.getPrice(rh(CRWD))).rejects.toThrow(PriceUnavailableError);
  });

  it('LI.FI is never asked for a Stock Token price', async () => {
    const { r, l } = router({ prices: { AAPL: quoteBody('AAPL', '1', '1') }, lifi: { [key('robinhood', AAPL)]: { priceUSD: '999' } } });
    await r.getPrice(rh(AAPL));
    expect(l.fetchToken).not.toHaveBeenCalled();
  });

  it('a feed configured for a non-registry address is refused', async () => {
    const { r } = router({ feeds: { [IMPOSTOR]: FEED } });
    await expect(r.getPrice(rh(IMPOSTOR))).rejects.toThrow(PriceUnavailableError);
  });
});

describe('Crypto: LI.FI first, fallback only on a documented data gap', () => {
  it('prices crypto on every chain from LI.FI priceUSD', async () => {
    const { r } = router({ lifi: { [key('arbitrum', WETH_ARB)]: { priceUSD: '2500.12' }, [key('base', USDC_BASE)]: { priceUSD: '0.9999' }, [key('robinhood', WETH_RH)]: { priceUSD: '2500.10' } } });
    expect((await r.getPrice({ chain: 'arbitrum', address: WETH_ARB })).price).toBe('2500.12');
    expect((await r.getPrice({ chain: 'base', address: USDC_BASE })).source).toBe('lifi:token:8453');
    expect((await r.getPrice(rh(WETH_RH))).source).toBe('lifi:token:4663'); // not in the Stock Token registry → crypto
  });

  it('an address with a Stock Token ticker but unknown contract is priced as crypto, never as the Stock Token', async () => {
    const { r } = router({ prices: { AAPL: quoteBody('AAPL', '999', '999') }, lifi: { [key('robinhood', IMPOSTOR)]: { symbol: 'AAPL', priceUSD: '0.01' } } });
    const p = await r.getPrice(rh(IMPOSTOR));
    expect(p.price).toBe('0.01');
    expect(p.source).toBe('lifi:token:4663');
  });

  it('data gap (no priceUSD / unknown token) → configured fallback, labelled', async () => {
    const twap = stub('uniswap-v3-twap:0xpool:1800s:USDG', '2499');
    const { r } = router({ lifi: { [key('robinhood', WETH_RH)]: {} }, fallbacks: { robinhood: twap } });
    const p = await r.getPrice(rh(WETH_RH));
    expect(p.price).toBe('2499');
    expect(p.source).toBe('uniswap-v3-twap:0xpool:1800s:USDG|fallback:lifi-data-gap');
  });

  it('data gap with no fallback for that chain → PriceDataGapError', async () => {
    const { r } = router({ lifi: { [key('ethereum', WETH_ETH)]: 404 } });
    await expect(r.getPrice({ chain: 'ethereum', address: WETH_ETH })).rejects.toThrow(PriceDataGapError);
  });

  it('LI.FI OUTAGE never switches to a fallback', async () => {
    const cg = stub('coingecko');
    const { r } = router({ lifi: { [key('ethereum', WETH_ETH)]: 500 }, fallbacks: { ethereum: cg } });
    await expect(r.getPrice({ chain: 'ethereum', address: WETH_ETH })).rejects.toThrow(PriceUnavailableError);
    await expect(r.getPrice({ chain: 'ethereum', address: WETH_ETH })).rejects.not.toThrow(PriceDataGapError);
    expect(cg.getPrice).not.toHaveBeenCalled();
  });
});

describe('Robinhood registry unavailable', () => {
  it('only USDG (known non-stock) can be priced; everything else on Robinhood fails closed', async () => {
    const { r } = router({ registryStatus: 503, lifi: { [key('robinhood', USDG)]: { priceUSD: '1.0001' }, [key('robinhood', WETH_RH)]: { priceUSD: '2500' } } });
    expect((await r.getPrice(rh(USDG))).price).toBe('1.0001');
    await expect(r.getPrice(rh(AAPL))).rejects.toThrow(PriceUnavailableError);
    await expect(r.getPrice(rh(WETH_RH))).rejects.toThrow(PriceUnavailableError);
    // other chains are unaffected
    const { r: r2 } = router({ registryStatus: 503, lifi: { [key('arbitrum', WETH_ARB)]: { priceUSD: '2500' } } });
    expect((await r2.getPrice({ chain: 'arbitrum', address: WETH_ARB })).price).toBe('2500');
  });
});

describe('multi-chain, mixed crypto + Stock Token valuation', () => {
  const holdings = [
    { asset: { chain: 'ethereum' as const, address: WETH_ETH }, quantityRaw: '100000000000000000', decimals: 18 }, // 0.1 ETH
    { asset: { chain: 'base' as const, address: USDC_BASE }, quantityRaw: '250000000', decimals: 6 }, // 250 USDC
    { asset: rh(AAPL), quantityRaw: '1000000000000000000', decimals: 18 }, // 1 AAPL token
    { asset: rh(CRWD), quantityRaw: '500000000000000000', decimals: 18 }, // 0.5 CRWD token
  ];
  const lifiTokens = { [key('ethereum', WETH_ETH)]: { priceUSD: '2500' }, [key('base', USDC_BASE)]: { priceUSD: '1', decimals: 6 } };

  it('values each asset from its own authority and sums exactly', async () => {
    const { r, h } = router({ prices: { AAPL: quoteBody('AAPL', '200', '200'), CRWD: quoteBody('CRWD', '100', '100') }, lifi: lifiTokens });
    const nav = await calculateNav(holdings, r, { now: h.now() });
    // 0.1×2500 + 250×1 + 1×(200×1.000566080061092436) + 0.5×(100×4)
    expect(nav.grossNav).toBe('900.113216012218487200');
    expect(nav.components.map((c) => c.price.source.split(':')[0])).toEqual(['lifi', 'lifi', 'robinhood-api', 'robinhood-api']);
  });

  it('one provider failing fails the whole valuation (no partial NAV)', async () => {
    const { r, h } = router({ prices: { AAPL: 503, CRWD: quoteBody('CRWD', '100', '100') }, lifi: lifiTokens });
    await expect(calculateNav(holdings, r, { now: h.now() })).rejects.toThrow(PriceUnavailableError);
  });

  it('stale data is rejected by the valuation', async () => {
    const { r, h } = router({ prices: { AAPL: quoteBody('AAPL', '200', '200'), CRWD: quoteBody('CRWD', '100', '100') }, lifi: lifiTokens });
    await expect(calculateNav(holdings, r, { now: new Date(h.now().getTime() + 10 * 60 * 1000), maxPriceAgeMs: 60_000 })).rejects.toThrow(StalePriceError);
  });
});
