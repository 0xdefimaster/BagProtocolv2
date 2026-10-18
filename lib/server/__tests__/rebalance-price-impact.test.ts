import { beforeEach, describe, expect, it, vi } from 'vitest';

// Rebalance price impact: 5% by default; an impact the investor explicitly accepted is allowed up to 10%, never more.

const TSLA = '0x322f0929c4625ed5bad873c95208d54e1c003b2d';
const NVDA = '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec';
const SIGNER = '0x49dadd8212128bdf6752351bf70f6a5d8b73fe46';
const E18 = BigInt(10) ** BigInt(18);

const load = vi.hoisted(() => vi.fn());
vi.mock('@/lib/server/rebalance-preview', () => ({ loadRebalancePreview: load }));
const buildComposerRebalance = vi.fn();
vi.mock('@/lib/blockchain/lifi-composer-adapter', async (orig) => {
  const actual = await orig<typeof import('@/lib/blockchain/lifi-composer-adapter')>();
  return { ...actual, buildComposerRebalance: (...args: unknown[]) => buildComposerRebalance(...args) };
});
const { composeError } = await import('@/lib/blockchain/__tests__/composer-fixtures');

import { MAX_ACCEPTABLE_REBALANCE_PRICE_IMPACT_BPS, quoteRebalance, rebalancePriceImpactLimitBps } from '../rebalance-quote';

const order = (address: string, side: 'BUY' | 'SELL') => ({ asset: { chain: 'robinhood', address }, symbol: address, side, value: '10', quantityRaw: (BigInt(10) * E18).toString(), decimals: 18 });
const loaded = {
  ok: true,
  bag: { id: 'b', chain: 'robinhood' },
  recipe: { rebalanceRule: { maxSlippageBps: 100, driftThresholdBps: 500 } },
  holdings: [{ chain: 'robinhood', address: TSLA, decimals: 18, quantityRaw: (BigInt(60) * E18).toString(), sellableRaw: (BigInt(60) * E18).toString() }],
  symbols: {},
  preview: { status: 'OK', targetVersion: 2, requiresRebalance: true, orders: [order(TSLA, 'SELL'), order(NVDA, 'BUY')], allocations: [], driftThresholdBps: 500, maxAbsDriftBps: 1000, navQuote: '100', quoteCurrency: 'USD' },
};
const run = (acceptedPriceImpactBps?: number) =>
  quoteRebalance({} as never, {} as never, {} as never, { userId: 'u', walletAddress: SIGNER }, 'b', { apiKey: 'k', ...(acceptedPriceImpactBps !== undefined ? { acceptedPriceImpactBps } : {}) });
const impactError = (measured: number, max: number) => composeError('price_impact_exceeded', `Price impact ${measured} bps exceeds maximum ${max} bps (input: $10.00, output: $9.00)`);

beforeEach(() => {
  load.mockReset();
  load.mockResolvedValue(loaded);
  buildComposerRebalance.mockReset();
});

describe('rebalancePriceImpactLimitBps', () => {
  it('5% by default; an accepted impact + 1% buffer, never below 5% nor above 10%; anything else is refused', () => {
    expect(rebalancePriceImpactLimitBps(undefined)).toBe(500);
    expect(rebalancePriceImpactLimitBps(200)).toBe(500);
    expect(rebalancePriceImpactLimitBps(720)).toBe(820);
    expect(rebalancePriceImpactLimitBps(950)).toBe(1000);
    expect(rebalancePriceImpactLimitBps(1000)).toBe(1000);
    for (const bad of [1001, 1500, -1, 7.5, Number.NaN]) expect(rebalancePriceImpactLimitBps(bad)).toBeNull();
    expect(MAX_ACCEPTABLE_REBALANCE_PRICE_IMPACT_BPS).toBe(1000);
  });
});

describe('quoteRebalance price impact', () => {
  it('asks Composer for 5% when nothing was accepted; an impact of 7.2% is refused but offered for acceptance', async () => {
    buildComposerRebalance.mockRejectedValueOnce(await impactError(720, 500));
    const r = await run();
    expect(buildComposerRebalance.mock.calls[0][0]).toMatchObject({ maxPriceImpactBps: 500 });
    expect(r).toMatchObject({ ok: false, status: 422, acceptablePriceImpactBps: 720, composerFallback: { reason: 'PRICE_IMPACT', priceImpactBps: 720 } });
    if (!r.ok) expect(r.error).toMatch(/7\.20%.*5% limit/);
  });

  it('after acceptance the limit sent to Composer is the accepted impact + 1%', async () => {
    buildComposerRebalance.mockRejectedValueOnce(await impactError(900, 820));
    await run(720);
    expect(buildComposerRebalance.mock.calls[0][0]).toMatchObject({ maxPriceImpactBps: 820 });
  });

  it('an impact above 10% is refused outright, with nothing to accept', async () => {
    buildComposerRebalance.mockRejectedValueOnce(await impactError(1800, 500));
    const r = await run();
    expect(r).toMatchObject({ ok: false, status: 422, acceptablePriceImpactBps: null });
    if (!r.ok) expect(r.error).toMatch(/18\.00%.*10% maximum/);
  });

  it('an accepted value above 10% (or not whole bps) never reaches Composer', async () => {
    expect(await run(1500)).toMatchObject({ ok: false, status: 400 });
    expect(await run(12.5)).toMatchObject({ ok: false, status: 400 });
    expect(buildComposerRebalance).not.toHaveBeenCalled();
  });
});
