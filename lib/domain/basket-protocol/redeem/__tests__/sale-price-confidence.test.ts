import { describe, expect, it } from 'vitest';
import type { AssetIdentity } from '@/types/basket-protocol';
import { RobinhoodApiPriceProvider } from '../../pricing/robinhood-stock-api';
import { ChainlinkFeedPriceProvider, FeedReadClient } from '../../pricing/chainlink-feed-provider';
import { BagPriceRouter, PriceSourceDisagreementError, stockPriceVerification } from '../../pricing/bag-price-router';
import { LiFiPriceProvider, LiFiTokenData } from '@/lib/blockchain/lifi-token-data';
import { AAPL, CRWD, FEED, feedClient, harness, NOW, quoteBody, USDG } from '../../pricing/__tests__/robinhood-harness';
import {
  DEFAULT_SALE_PRICE_POLICY,
  salePriceDeviationLimit,
  salePricePolicyFromEnv,
  SalePricePolicyConfigError,
  type SalePricePolicy,
} from '../sale-price-confidence';

// Fee-paying sale legs: which deviation band a reference price earns (sale-price-confidence.ts). The accepted states
// are exact (confidence, source) pairs produced by bag-price-router.ts; the server paths (quoteSettlement,
// signFeeAttestation) are covered end-to-end in lib/server/__tests__.

const now = new Date(NOW);
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const PRIMARY = 'robinhood-api:prices:CRWD:mid×4.000000000000000000';
const VERIFIED = `${PRIMARY}|verify:chainlink:${FEED.toLowerCase()}:12bps`;
const UNAVAILABLE = `${PRIMARY}|verify:chainlink-unavailable`;
const fresh = { timestamp: at(5_000) };

describe('stockPriceVerification — exact, anchored source labels', () => {
  it('recognises only the two router states', () => {
    expect(stockPriceVerification(VERIFIED)).toEqual({ state: 'CHAINLINK_VERIFIED', feed: FEED.toLowerCase(), deviationBps: 12 });
    expect(stockPriceVerification(UNAVAILABLE)).toEqual({ state: 'CHAINLINK_UNAVAILABLE' });
    for (const s of [
      PRIMARY, // no feed configured
      `x${VERIFIED}`,
      `${VERIFIED}x`,
      `${PRIMARY}|verify:chainlink:feed:0bps`, // not an address
      `${PRIMARY}|verify:chainlink-unavailable|verify:chainlink:${FEED.toLowerCase()}:0bps`,
      `lifi:price|verify:chainlink-unavailable`, // not a Robinhood API primary
      'twap:uniswap-v3',
      '',
      undefined,
    ]) {
      expect(stockPriceVerification(s)).toBeNull();
    }
  });
});

describe('salePriceDeviationLimit — source-qualified states', () => {
  it('(1) confidence 1 + Chainlink-verified source → VERIFIED, 500 bps', () => {
    expect(salePriceDeviationLimit({ confidence: 1, source: VERIFIED, ...fresh }, DEFAULT_SALE_PRICE_POLICY, now)).toEqual({
      ok: true,
      tier: 'VERIFIED',
      maxDeviationBps: 500,
      breakGlass: false,
    });
  });

  it('(2) confidence 0.5 + chainlink-unavailable source → REDUCED_CONFIDENCE, 100 bps', () => {
    expect(salePriceDeviationLimit({ confidence: 0.5, source: UNAVAILABLE, ...fresh }, DEFAULT_SALE_PRICE_POLICY, now)).toEqual({
      ok: true,
      tier: 'REDUCED_CONFIDENCE',
      maxDeviationBps: 100,
      breakGlass: false,
    });
  });

  it('(3) confidence 1 without Chainlink evidence → refused', () => {
    for (const source of [PRIMARY, UNAVAILABLE, 'lifi:0x…', 'mock', '']) {
      expect(salePriceDeviationLimit({ confidence: 1, source, ...fresh }, DEFAULT_SALE_PRICE_POLICY, now)).toEqual({ ok: false, reason: 'SOURCE_NOT_QUALIFIED' });
    }
  });

  it('(4) confidence 0.5 with an unrelated or the verified source → refused', () => {
    for (const source of [VERIFIED, PRIMARY, 'twap:uniswap-v3', 'coingecko']) {
      expect(salePriceDeviationLimit({ confidence: 0.5, source, ...fresh }, DEFAULT_SALE_PRICE_POLICY, now)).toEqual({ ok: false, reason: 'SOURCE_NOT_QUALIFIED' });
    }
  });

  it('(5) any other confidence value is not interpolated: refused', () => {
    for (const c of [0.75, 0.99, 0.51, 0.49, 0, 0.9999999]) {
      for (const source of [VERIFIED, UNAVAILABLE]) {
        expect(salePriceDeviationLimit({ confidence: c, source, ...fresh }, DEFAULT_SALE_PRICE_POLICY, now)).toEqual({ ok: false, reason: 'CONFIDENCE_UNEXPECTED' });
      }
    }
    for (const c of [NaN, Infinity, '1' as unknown as number]) {
      expect(salePriceDeviationLimit({ confidence: c, source: VERIFIED, ...fresh }, DEFAULT_SALE_PRICE_POLICY, now)).toEqual({ ok: false, reason: 'CONFIDENCE_INVALID' });
    }
    expect(salePriceDeviationLimit({ source: VERIFIED, ...fresh }, DEFAULT_SALE_PRICE_POLICY, now)).toEqual({ ok: false, reason: 'CONFIDENCE_MISSING' });
    expect(salePriceDeviationLimit({ confidence: null as unknown as number, source: VERIFIED, ...fresh }, DEFAULT_SALE_PRICE_POLICY, now)).toEqual({ ok: false, reason: 'CONFIDENCE_MISSING' });
  });

  it('(6) missing, invalid, future or stale timestamp → refused, even when verified', () => {
    const v = { confidence: 1, source: VERIFIED };
    for (const timestamp of ['', 'yesterday', undefined as unknown as string]) {
      expect(salePriceDeviationLimit({ ...v, timestamp }, DEFAULT_SALE_PRICE_POLICY, now)).toEqual({ ok: false, reason: 'TIMESTAMP_INVALID' });
    }
    expect(salePriceDeviationLimit({ ...v, timestamp: at(-60_000) }, DEFAULT_SALE_PRICE_POLICY, now)).toEqual({ ok: false, reason: 'TIMESTAMP_INVALID' });
    expect(salePriceDeviationLimit({ ...v, timestamp: at(-10_000) }, DEFAULT_SALE_PRICE_POLICY, now)).toMatchObject({ ok: true }); // small clock skew
    expect(salePriceDeviationLimit({ ...v, timestamp: at(5 * 60 * 1000) }, DEFAULT_SALE_PRICE_POLICY, now)).toMatchObject({ ok: true });
    expect(salePriceDeviationLimit({ ...v, timestamp: at(5 * 60 * 1000 + 1) }, DEFAULT_SALE_PRICE_POLICY, now)).toEqual({ ok: false, reason: 'PRICE_STALE' });
  });

  it('a policy whose reduced band is not below the verified band, or above 200 without break-glass, is refused', () => {
    const p = (o: Partial<SalePricePolicy>): SalePricePolicy => ({ ...DEFAULT_SALE_PRICE_POLICY, ...o });
    const reduced = { confidence: 0.5, source: UNAVAILABLE, ...fresh };
    expect(() => salePriceDeviationLimit(reduced, p({ reducedConfidenceMaxDeviationBps: 500, breakGlass: true }), now)).toThrow(SalePricePolicyConfigError);
    expect(() => salePriceDeviationLimit(reduced, p({ reducedConfidenceMaxDeviationBps: 201 }), now)).toThrow(SalePricePolicyConfigError);
    expect(salePriceDeviationLimit(reduced, p({ reducedConfidenceMaxDeviationBps: 300, breakGlass: true }), now)).toEqual({
      ok: true,
      tier: 'REDUCED_CONFIDENCE',
      maxDeviationBps: 300,
      breakGlass: true,
    });
  });
});

describe('salePricePolicyFromEnv', () => {
  it('unset → defaults (500 / 100 / 5 min, no break-glass)', () => {
    expect(salePricePolicyFromEnv({})).toEqual({ normalMaxDeviationBps: 500, reducedConfidenceMaxDeviationBps: 100, maxPriceAgeMs: 300_000, breakGlass: false });
  });

  it('0..200 is an ordinary setting; 0 = only quotes at or above the unverified reference', () => {
    expect(salePricePolicyFromEnv({ FEE_SALE_REDUCED_CONFIDENCE_MAX_DEVIATION_BPS: '50', FEE_SALE_PRICE_MAX_AGE_SECONDS: '60' })).toMatchObject({
      reducedConfidenceMaxDeviationBps: 50,
      maxPriceAgeMs: 60_000,
    });
    expect(salePricePolicyFromEnv({ FEE_SALE_REDUCED_CONFIDENCE_MAX_DEVIATION_BPS: '0' }).reducedConfidenceMaxDeviationBps).toBe(0);
    expect(salePricePolicyFromEnv({ FEE_SALE_REDUCED_CONFIDENCE_MAX_DEVIATION_BPS: '200' }).reducedConfidenceMaxDeviationBps).toBe(200);
  });

  it('201..499 only with FEE_SALE_REDUCED_CONFIDENCE_BREAK_GLASS=1; 500+ never', () => {
    expect(() => salePricePolicyFromEnv({ FEE_SALE_REDUCED_CONFIDENCE_MAX_DEVIATION_BPS: '300' })).toThrow(/BREAK_GLASS/);
    expect(salePricePolicyFromEnv({ FEE_SALE_REDUCED_CONFIDENCE_MAX_DEVIATION_BPS: '300', FEE_SALE_REDUCED_CONFIDENCE_BREAK_GLASS: '1' })).toMatchObject({
      reducedConfidenceMaxDeviationBps: 300,
      breakGlass: true,
    });
    expect(() => salePricePolicyFromEnv({ FEE_SALE_REDUCED_CONFIDENCE_MAX_DEVIATION_BPS: '500', FEE_SALE_REDUCED_CONFIDENCE_BREAK_GLASS: '1' })).toThrow(SalePricePolicyConfigError);
    // The flag alone changes nothing about the default band.
    expect(salePricePolicyFromEnv({ FEE_SALE_REDUCED_CONFIDENCE_BREAK_GLASS: '1' }).reducedConfidenceMaxDeviationBps).toBe(100);
  });

  it('a typo throws instead of falling back', () => {
    for (const env of [
      { FEE_SALE_REDUCED_CONFIDENCE_MAX_DEVIATION_BPS: '1%' },
      { FEE_SALE_REDUCED_CONFIDENCE_MAX_DEVIATION_BPS: '-1' },
      { FEE_SALE_REDUCED_CONFIDENCE_BREAK_GLASS: 'yes' },
      { FEE_SALE_PRICE_MAX_AGE_SECONDS: '0' },
      { FEE_SALE_PRICE_MAX_AGE_SECONDS: '1.5' },
    ]) {
      expect(() => salePricePolicyFromEnv(env)).toThrow(SalePricePolicyConfigError);
    }
  });
});

// The real router (scripted sources) feeding the policy: the labels it produces are the ones the policy accepts.
function router(opts: { prices: Parameters<typeof harness>[0]; feeds?: Record<string, `0x${string}`>; feed?: FeedReadClient }) {
  const h = harness(opts.prices);
  return new BagPriceRouter({
    stockApi: h.api,
    stockPrices: new RobinhoodApiPriceProvider({ api: h.api, now: h.now }),
    chainlink: new ChainlinkFeedPriceProvider({ client: opts.feed ?? feedClient(), feeds: opts.feeds ?? {}, now: h.now }),
    crypto: new LiFiPriceProvider(new LiFiTokenData({ fetchToken: async () => { throw new Error('unused'); }, now: () => NOW })),
    usdgAddress: USDG,
  });
}
const rh = (address: string): AssetIdentity => ({ chain: 'robinhood', address });

describe('BagPriceRouter → salePriceDeviationLimit', () => {
  it('feed configured and agreeing → VERIFIED, 500 bps', async () => {
    const p = await router({ prices: { CRWD: quoteBody('CRWD', '100.00', '100.10') }, feeds: { [CRWD]: FEED } }).getPrice(rh(CRWD));
    expect(salePriceDeviationLimit(p, DEFAULT_SALE_PRICE_POLICY, now)).toMatchObject({ ok: true, tier: 'VERIFIED', maxDeviationBps: 500 });
  });

  it('feed configured but unreadable → REDUCED_CONFIDENCE, 100 bps', async () => {
    const p = await router({ prices: { CRWD: quoteBody('CRWD', '100', '100.1') }, feeds: { [CRWD]: FEED }, feed: feedClient({ throws: true }) }).getPrice(rh(CRWD));
    expect(salePriceDeviationLimit(p, DEFAULT_SALE_PRICE_POLICY, now)).toMatchObject({ ok: true, tier: 'REDUCED_CONFIDENCE', maxDeviationBps: 100 });
  });

  it('no feed configured → no confidence → refused for a fee sale', async () => {
    const p = await router({ prices: { AAPL: quoteBody('AAPL', '213.45', '213.47') } }).getPrice(rh(AAPL));
    expect(p.confidence).toBeUndefined();
    expect(salePriceDeviationLimit(p, DEFAULT_SALE_PRICE_POLICY, now)).toEqual({ ok: false, reason: 'CONFIDENCE_MISSING' });
  });

  it('(7) sources disagree → the router throws; there is no price to apply a band to', async () => {
    await expect(router({ prices: { CRWD: quoteBody('CRWD', '105', '105') }, feeds: { [CRWD]: FEED } }).getPrice(rh(CRWD))).rejects.toThrow(PriceSourceDisagreementError);
  });
});
