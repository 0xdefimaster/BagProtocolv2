import { describe, expect, it } from 'vitest';
import type { AssetIdentity } from '@/types/basket-protocol';
import { RobinhoodApiPriceProvider } from '../../pricing/robinhood-stock-api';
import { ChainlinkFeedPriceProvider, FeedReadClient } from '../../pricing/chainlink-feed-provider';
import { BagPriceRouter, PriceSourceDisagreementError } from '../../pricing/bag-price-router';
import { LiFiPriceProvider, LiFiTokenData } from '@/lib/blockchain/lifi-token-data';
import { AAPL, CRWD, FEED, feedClient, harness, NOW, quoteBody, USDG } from '../../pricing/__tests__/robinhood-harness';
import {
  DEFAULT_SALE_PRICE_POLICY,
  salePriceDeviationLimit,
  salePricePolicyFromEnv,
  SalePricePolicyConfigError,
  type SalePricePolicy,
} from '../sale-price-confidence';

// Fee-paying sale legs: which deviation band a reference price earns (sale-price-confidence.ts). The server paths
// (quoteSettlement, signFeeAttestation) are covered end-to-end in lib/server/__tests__.

const now = new Date(NOW);
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();

describe('salePriceDeviationLimit — tiers', () => {
  it('(1) confidence 1 (Chainlink-verified) → the normal 500 bps band', () => {
    expect(salePriceDeviationLimit({ confidence: 1, timestamp: at(5_000) }, DEFAULT_SALE_PRICE_POLICY, now)).toEqual({ ok: true, tier: 'VERIFIED', maxDeviationBps: 500 });
  });

  it('(2) confidence 0.5 (Chainlink unavailable) → the stricter band, default 100 bps', () => {
    expect(salePriceDeviationLimit({ confidence: 0.5, timestamp: at(5_000) }, DEFAULT_SALE_PRICE_POLICY, now)).toEqual({
      ok: true,
      tier: 'REDUCED_CONFIDENCE',
      maxDeviationBps: 100,
    });
    expect(salePriceDeviationLimit({ confidence: 0.75, timestamp: at(0) }, DEFAULT_SALE_PRICE_POLICY, now)).toMatchObject({ ok: true, maxDeviationBps: 100 });
  });

  it('(3) missing confidence fails closed', () => {
    expect(salePriceDeviationLimit({ timestamp: at(5_000) }, DEFAULT_SALE_PRICE_POLICY, now)).toEqual({ ok: false, reason: 'CONFIDENCE_MISSING' });
    expect(salePriceDeviationLimit({ confidence: null as unknown as number, timestamp: at(5_000) }, DEFAULT_SALE_PRICE_POLICY, now)).toEqual({ ok: false, reason: 'CONFIDENCE_MISSING' });
  });

  it('confidence below 0.5, out of [0, 1] or not a number fails closed', () => {
    expect(salePriceDeviationLimit({ confidence: 0.49, timestamp: at(0) }, DEFAULT_SALE_PRICE_POLICY, now)).toEqual({ ok: false, reason: 'CONFIDENCE_TOO_LOW' });
    expect(salePriceDeviationLimit({ confidence: 0, timestamp: at(0) }, DEFAULT_SALE_PRICE_POLICY, now)).toEqual({ ok: false, reason: 'CONFIDENCE_TOO_LOW' });
    for (const c of [1.01, -0.1, NaN, Infinity, '1' as unknown as number]) {
      expect(salePriceDeviationLimit({ confidence: c, timestamp: at(0) }, DEFAULT_SALE_PRICE_POLICY, now)).toEqual({ ok: false, reason: 'CONFIDENCE_INVALID' });
    }
  });

  it('(4) a stale price fails closed, even at confidence 1', () => {
    expect(salePriceDeviationLimit({ confidence: 1, timestamp: at(5 * 60 * 1000) }, DEFAULT_SALE_PRICE_POLICY, now)).toMatchObject({ ok: true });
    expect(salePriceDeviationLimit({ confidence: 1, timestamp: at(5 * 60 * 1000 + 1) }, DEFAULT_SALE_PRICE_POLICY, now)).toEqual({ ok: false, reason: 'PRICE_STALE' });
  });

  it('a missing, unparseable or future timestamp fails closed', () => {
    for (const timestamp of ['', 'yesterday', undefined as unknown as string]) {
      expect(salePriceDeviationLimit({ confidence: 1, timestamp }, DEFAULT_SALE_PRICE_POLICY, now)).toEqual({ ok: false, reason: 'TIMESTAMP_INVALID' });
    }
    expect(salePriceDeviationLimit({ confidence: 1, timestamp: at(-60_000) }, DEFAULT_SALE_PRICE_POLICY, now)).toEqual({ ok: false, reason: 'TIMESTAMP_INVALID' });
    expect(salePriceDeviationLimit({ confidence: 1, timestamp: at(-10_000) }, DEFAULT_SALE_PRICE_POLICY, now)).toMatchObject({ ok: true }); // small clock skew
  });

  it('a policy that would widen the band for a weaker price is refused', () => {
    const bad: SalePricePolicy = { ...DEFAULT_SALE_PRICE_POLICY, reducedConfidenceMaxDeviationBps: 600 };
    expect(() => salePriceDeviationLimit({ confidence: 0.5, timestamp: at(0) }, bad, now)).toThrow(SalePricePolicyConfigError);
  });
});

describe('salePricePolicyFromEnv', () => {
  it('unset → defaults (500 / 100 / 5 min)', () => {
    expect(salePricePolicyFromEnv({})).toEqual({ normalMaxDeviationBps: 500, reducedConfidenceMaxDeviationBps: 100, maxPriceAgeMs: 300_000 });
  });

  it('configurable within the verified band', () => {
    expect(salePricePolicyFromEnv({ FEE_SALE_REDUCED_CONFIDENCE_MAX_DEVIATION_BPS: '50', FEE_SALE_PRICE_MAX_AGE_SECONDS: '60' })).toEqual({
      normalMaxDeviationBps: 500,
      reducedConfidenceMaxDeviationBps: 50,
      maxPriceAgeMs: 60_000,
    });
    // 0 = only a quote at or above the unverified reference may pass.
    expect(salePricePolicyFromEnv({ FEE_SALE_REDUCED_CONFIDENCE_MAX_DEVIATION_BPS: '0' }).reducedConfidenceMaxDeviationBps).toBe(0);
  });

  it('a typo or a wider-than-verified value throws instead of falling back', () => {
    for (const env of [
      { FEE_SALE_REDUCED_CONFIDENCE_MAX_DEVIATION_BPS: '1%' },
      { FEE_SALE_REDUCED_CONFIDENCE_MAX_DEVIATION_BPS: '-1' },
      { FEE_SALE_REDUCED_CONFIDENCE_MAX_DEVIATION_BPS: '501' },
      { FEE_SALE_PRICE_MAX_AGE_SECONDS: '0' },
      { FEE_SALE_PRICE_MAX_AGE_SECONDS: '1.5' },
    ]) {
      expect(() => salePricePolicyFromEnv(env)).toThrow(SalePricePolicyConfigError);
    }
  });
});

// The real router (scripted sources) feeding the policy: what each live situation becomes.
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
    expect(salePriceDeviationLimit(p, DEFAULT_SALE_PRICE_POLICY, now)).toEqual({ ok: true, tier: 'VERIFIED', maxDeviationBps: 500 });
  });

  it('feed configured but unreadable → REDUCED_CONFIDENCE, 100 bps', async () => {
    const p = await router({ prices: { CRWD: quoteBody('CRWD', '100', '100.1') }, feeds: { [CRWD]: FEED }, feed: feedClient({ throws: true }) }).getPrice(rh(CRWD));
    expect(p.source).toContain('|verify:chainlink-unavailable');
    expect(salePriceDeviationLimit(p, DEFAULT_SALE_PRICE_POLICY, now)).toEqual({ ok: true, tier: 'REDUCED_CONFIDENCE', maxDeviationBps: 100 });
  });

  it('no feed configured → no confidence → refused for a fee sale', async () => {
    const p = await router({ prices: { AAPL: quoteBody('AAPL', '213.45', '213.47') } }).getPrice(rh(AAPL));
    expect(p.confidence).toBeUndefined();
    expect(salePriceDeviationLimit(p, DEFAULT_SALE_PRICE_POLICY, now)).toEqual({ ok: false, reason: 'CONFIDENCE_MISSING' });
  });

  it('(5) sources disagree → the router throws; there is no price to apply a band to', async () => {
    await expect(router({ prices: { CRWD: quoteBody('CRWD', '105', '105') }, feeds: { [CRWD]: FEED } }).getPrice(rh(CRWD))).rejects.toThrow(PriceSourceDisagreementError);
  });
});
