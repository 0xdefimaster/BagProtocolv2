import { describe, expect, it } from 'vitest';
import { diffRecipes } from '../strategy-diff';
import { RecipeAsset } from '@/types/basket-protocol';

const a = (symbol: string, address: string, weightBps: number): RecipeAsset => ({ chain: 'robinhood', address, symbol, decimals: 18, weightBps });
const NVDA = '0x00000000000000000000000000000000000000a1';
const AMD = '0x00000000000000000000000000000000000000a2';
const MSFT = '0x00000000000000000000000000000000000000a3';
const BTC = '0x00000000000000000000000000000000000000a4';

describe('diffRecipes', () => {
  it('reports added, removed and re-weighted assets, matched by address not symbol', () => {
    const v4 = { assets: [a('NVDA', NVDA, 3000), a('AMD', AMD, 2000), a('BTC', BTC, 1500), a('MSFT', MSFT, 3500)] };
    // Same NVDA contract with a different symbol label is still the same asset.
    const v5 = { assets: [a('NVDA.x', NVDA.toUpperCase().replace('0X', '0x'), 2500), a('AMD', AMD, 2500), a('BTC', BTC, 1500), a('ETH', '0x00000000000000000000000000000000000000a5', 3500)] };
    const d = diffRecipes(v4, v5);
    const by = Object.fromEntries(d.assets.map((x) => [x.symbol, x]));
    expect(by['NVDA.x']).toMatchObject({ kind: 'REWEIGHTED', fromBps: 3000, toBps: 2500, deltaBps: -500 });
    expect(by.AMD).toMatchObject({ kind: 'REWEIGHTED', deltaBps: 500 });
    expect(by.BTC).toMatchObject({ kind: 'UNCHANGED', deltaBps: 0 });
    expect(by.MSFT).toMatchObject({ kind: 'REMOVED', fromBps: 3500, toBps: null });
    expect(by.ETH).toMatchObject({ kind: 'ADDED', fromBps: null, toBps: 3500 });
    expect(d.assets.map((x) => x.kind)).toEqual(['ADDED', 'REWEIGHTED', 'REWEIGHTED', 'REMOVED', 'UNCHANGED']);
    expect(d.unchanged).toBe(false);
  });

  it('reports changed strategy settings with readable values', () => {
    const base = { assets: [a('NVDA', NVDA, 10000)], performanceFeeBps: 1000, maxWeightBps: 5000 };
    const d = diffRecipes(base, { ...base, performanceFeeBps: 1500, maxWeightBps: 3000 });
    expect(d.settings).toEqual([
      { field: 'performanceFeeBps', label: 'Performance fee', from: '10%', to: '15%' },
      { field: 'maxWeightBps', label: 'Max weight per asset', from: '50%', to: '30%' },
    ]);
  });

  it('the first version lists every asset as added and no settings', () => {
    const d = diffRecipes(null, { assets: [a('NVDA', NVDA, 6000), a('AMD', AMD, 4000)], performanceFeeBps: 500 });
    expect(d.assets.every((x) => x.kind === 'ADDED')).toBe(true);
    expect(d.settings).toEqual([]);
  });

  it('identical recipes are unchanged', () => {
    const r = { assets: [a('NVDA', NVDA, 10000)], performanceFeeBps: 0 };
    expect(diffRecipes(r, { ...r }).unchanged).toBe(true);
  });
});
