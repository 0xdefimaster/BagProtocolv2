import { describe, expect, it } from 'vitest';
import type { AssetPrice, BasketRecipe } from '@/types/basket-protocol';
import { assetIdentityKey } from '../../asset-identity';
import { previewPositionRebalance } from '../position-rebalance';

// previewPositionRebalance: one investor's effective holdings, verified prices, the strategy's CURRENT version.

const NOW = new Date('2026-10-11T00:00:00.000Z');
const TSLA = '0x322f0929c4625ed5bad873c95208d54e1c003b2d';
const NVDA = '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec';
const AMKR = '0xaaaa000000000000000000000000000000000001';

function recipe(assets: { address: string; weightBps: number; symbol: string }[], version = 1, driftThresholdBps = 500): BasketRecipe {
  return {
    id: 'r',
    bagId: 'bag',
    name: 'feetest',
    symbol: 'FEETEST',
    description: '',
    chain: 'robinhood',
    strategyType: 'STATIC_BASKET',
    assets: assets.map((a) => ({ chain: 'robinhood', decimals: 18, ...a })),
    rebalanceRule: { frequency: 'MANUAL' as never, driftThresholdBps, maxSlippageBps: 100 },
    minInvestment: 0,
    maxAssets: 10,
    minWeightBps: 100,
    maxWeightBps: 10000,
    mutability: 'MUTABLE',
    version,
    createdAt: NOW.toISOString(),
  } as BasketRecipe;
}

function prices(entries: [string, string][]): Map<string, AssetPrice> {
  return new Map(
    entries.map(([address, price]) => [
      assetIdentityKey({ chain: 'robinhood', address }),
      { asset: { chain: 'robinhood', address }, price, quoteCurrency: 'USD', timestamp: NOW.toISOString(), source: 'test' },
    ])
  );
}

const E18 = BigInt(10) ** BigInt(18);
const held = (address: string, units: bigint) => ({ chain: 'robinhood', address, decimals: 18, sellableRaw: (units * E18).toString() });
const FIFTY_FIFTY = recipe([
  { address: TSLA, weightBps: 5000, symbol: 'TSLA' },
  { address: NVDA, weightBps: 5000, symbol: 'NVDA' },
]);

describe('previewPositionRebalance', () => {
  it('within tolerance: 52/48 against 50/50 with a 5% threshold needs no rebalance', () => {
    const p = previewPositionRebalance({ recipe: FIFTY_FIFTY, holdings: [held(TSLA, BigInt(52)), held(NVDA, BigInt(48))], prices: prices([[TSLA, '1'], [NVDA, '1']]), now: NOW });
    expect(p).toMatchObject({ status: 'OK', targetVersion: 1, driftThresholdBps: 500, maxAbsDriftBps: 200, requiresRebalance: false, navQuote: expect.stringMatching(/^100(\.0+)?$/) });
    if (p.status === 'OK') expect(p.orders).toEqual([]);
  });

  it('out of tolerance: 60/40 sells the overweight asset and buys the underweight one back to target', () => {
    const p = previewPositionRebalance({ recipe: FIFTY_FIFTY, holdings: [held(TSLA, BigInt(60)), held(NVDA, BigInt(40))], prices: prices([[TSLA, '1'], [NVDA, '1']]), now: NOW });
    expect(p.status).toBe('OK');
    if (p.status !== 'OK') return;
    expect(p.requiresRebalance).toBe(true);
    expect(p.maxAbsDriftBps).toBe(1000);
    const bySide = Object.fromEntries(p.orders.map((o) => [o.side, o]));
    expect(bySide.SELL).toMatchObject({ asset: { address: TSLA }, quantityRaw: (BigInt(10) * E18).toString() });
    expect(bySide.BUY).toMatchObject({ asset: { address: NVDA }, quantityRaw: (BigInt(10) * E18).toString() });
  });

  it('targets the CURRENT version: an asset dropped in v2 is sold in full, a new one is bought', () => {
    const v2 = recipe([{ address: TSLA, weightBps: 5000, symbol: 'TSLA' }, { address: AMKR, weightBps: 5000, symbol: 'AMKR' }], 2);
    const p = previewPositionRebalance({ recipe: v2, holdings: [held(TSLA, BigInt(50)), held(NVDA, BigInt(50))], prices: prices([[TSLA, '1'], [NVDA, '1']]), now: NOW });
    expect(p.status).toBe('OK');
    if (p.status !== 'OK') return;
    expect(p.targetVersion).toBe(2);
    expect(p.requiresRebalance).toBe(true);
    expect(p.orders.find((o) => o.asset.address === NVDA)).toMatchObject({ side: 'SELL', quantityRaw: (BigInt(50) * E18).toString() });
    // Never held, so no price on hand: bought by value, quantity left to the route.
    expect(p.orders.find((o) => o.asset.address === AMKR)).toMatchObject({ side: 'BUY', quantityRaw: null });
  });

  it('fails closed: unreadable balances, no position, a missing or stale price', () => {
    expect(previewPositionRebalance({ recipe: FIFTY_FIFTY, holdings: null, prices: prices([]), now: NOW })).toEqual({ status: 'UNREADABLE_BALANCES' });
    expect(previewPositionRebalance({ recipe: FIFTY_FIFTY, holdings: [held(TSLA, BigInt(0))], prices: prices([]), now: NOW })).toEqual({ status: 'NO_POSITION' });
    expect(previewPositionRebalance({ recipe: FIFTY_FIFTY, holdings: [held(TSLA, BigInt(5)), held(NVDA, BigInt(5))], prices: prices([[TSLA, '1']]), now: NOW })).toEqual({ status: 'PRICE_UNAVAILABLE', assets: [NVDA] });
    const later = new Date(NOW.getTime() + 24 * 3600 * 1000);
    expect(previewPositionRebalance({ recipe: FIFTY_FIFTY, holdings: [held(TSLA, BigInt(5))], prices: prices([[TSLA, '1']]), now: later }).status).toBe('PRICE_UNAVAILABLE');
  });
});
